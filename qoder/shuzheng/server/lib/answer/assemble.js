import { config } from '../../config.js';
import { embedQuery } from '../embed/local-embedder.js';
import { openCollection } from '../seekdb/client.js';
import { extractKeywords } from './keywords.js';
import { judgeCoverage } from './coverage.js';
import { recordRefusal } from '../stuck/ledger.js';

/**
 * F4 + F5：一次提问的多路召回、证据卡组装与抽取式答案。
 *
 * 通道设计（都要串行，见下）：
 *  - 全文通道：`whereDocument.$contains` 一次只吃一个词，所以对前几个候选词各发一次 hybridSearch；
 *    这解决了 P4 观察到的偏差——定义句本身不含术语时，单词语过滤会把单元语句排在前面。
 *  - 向量通道：再发一次纯向量 query()，保证"关键词在教材里根本不存在"时仍有最近邻内容可展示（F4.5）。
 *  - hybridSearch 是并集融合而非 AND 过滤，所以"结果为空"永远不能用来判未覆盖，判定只走 coverage.js 两条规则。
 *
 * 为什么串行：SDK v1.4 的 hybridSearch 实现是「SET @search_parm = ? → 读回 query_sql → 执行」，
 * 用的是一条连接上的**会话变量**。并发调用会互相覆盖 search_parm，结果是错的。
 * 向量通道不受此限制，但为同一理由（导入会重建集合）统一走队列。
 */
const MAX_KEYWORD_CHANNELS = 4;
const ANSWER_SENTENCES = 3;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toRows(res, channel) {
  const ids = res.ids?.flat() ?? [];
  const documents = res.documents?.flat() ?? [];
  const metadatas = res.metadatas?.flat() ?? [];
  const distances = res.distances?.flat() ?? [];
  return ids.map((id, i) => ({
    id,
    document: documents[i] ?? '',
    meta: metadatas[i] ?? {},
    score: Number(distances[i] ?? 0),
    rank: i + 1,
    channel,
  }));
}

function makeCard(row) {
  const m = row.meta;
  const sectionTitle = m.section_title ?? '';
  const sentence =
    m.plain_text ?? String(row.document ?? '').replace(new RegExp(`^${escapeRe(sectionTitle)}\\s*`), '');
  return {
    id: row.id,
    docId: m.doc_id ?? null,
    datasetName: m.dataset_name ?? '',
    sectionTitle,
    sectionPath: m.section_path ?? sectionTitle,
    sentNo: m.sent_no ?? null,
    sentence,
    charStart: m.char_start ?? null,
    charEnd: m.char_end ?? null,
    mergedCount: m.merged_count ?? 1,
    hasFormula: Boolean(m.has_formula),
    channels: [],
    channelCount: 0,
    bestRank: Number.POSITIVE_INFINITY,
    bestScore: Number.POSITIVE_INFINITY,
    matchedTerms: [],
  };
}

// 名次可跨通道比较（都是各自通道内的第几条），原始分数不可比（融合名次分），故排序只用名次 + 命中通道数。
function finalizeCards(byId, terms) {
  const cards = [];
  for (const card of byId.values()) {
    const seen = new Set();
    for (const ch of card.channels) {
      seen.add(ch.type === 'vector' ? 'vector' : `kw:${ch.keyword}`);
      if (ch.rank < card.bestRank) card.bestRank = ch.rank;
      if (ch.score < card.bestScore) card.bestScore = ch.score;
    }
    card.channelCount = seen.size;
    card.matchedTerms = terms.filter((t) => `${card.sectionTitle} ${card.sentence}`.includes(t));
    cards.push(card);
  }
  cards.sort(
    (a, b) => b.channelCount - a.channelCount || a.bestRank - b.bestRank || a.bestScore - b.bestScore,
  );
  return cards;
}

/** F4.3 上下文窗口：按 id 规则取同节 ±N 句，一次 get 批量拿回（get 按表序返回，必须建 Map 对齐）。 */
async function attachContext(collection, cards, window = config.chunk.contextWindow) {
  const wanted = new Map();
  for (const card of cards.slice(0, ANSWER_SENTENCES)) {
    if (card.sentNo == null || !/^(.+#)(\d{3})$/.test(card.id)) continue;
    const ids = [];
    for (let n = card.sentNo - window; n <= card.sentNo + window; n++) {
      if (n < 1 || n === card.sentNo) continue;
      ids.push(card.id.replace(/\d{3}$/, String(n).padStart(3, '0')));
    }
    wanted.set(card.id, ids);
  }
  if (wanted.size === 0) return;

  const res = await collection.get({ ids: [...new Set([...wanted.values()].flat())], include: ['metadatas'] });
  const metaById = new Map((res.ids ?? []).map((id, i) => [id, res.metadatas?.[i] ?? {}]));
  for (const [cardId, ids] of wanted) {
    const card = cards.find((c) => c.id === cardId);
    card.context = ids
      .map((id) => metaById.get(id))
      .filter(Boolean)
      .map((m) => ({ sentNo: m.sent_no, sentence: m.plain_text ?? '', charStart: m.char_start, charEnd: m.char_end }))
      .sort((a, b) => a.sentNo - b.sentNo);
  }
}

export async function answerQuery({ datasetName, collectionName, query, nResults = config.collection.defaultNResults }) {
  const started = Date.now();
  const terms = extractKeywords(query).candidates.slice(0, MAX_KEYWORD_CHANNELS);
  const tEmbed = Date.now();
  const vec = await embedQuery(query);
  const embedMs = Date.now() - tEmbed;

  const collection = await openCollection(collectionName);
  const rows = [];
  const channels = [];

  for (const keyword of terms) {
    const res = await collection.hybridSearch({
      query: { whereDocument: { $contains: keyword } },
      knn: { queryEmbeddings: [vec] },
      nResults,
    });
    const got = toRows(res, { type: 'hybrid', keyword });
    channels.push({ type: 'hybrid', keyword, hits: got.length });
    rows.push(...got);
  }

  const vecRes = await collection.query({ queryEmbeddings: [vec], nResults });
  const vecRows = toRows(vecRes, { type: 'vector', keyword: null });
  channels.push({ type: 'vector', hits: vecRows.length });
  rows.push(...vecRows);

  const byId = new Map();
  for (const row of rows) {
    let card = byId.get(row.id);
    if (!card) {
      card = makeCard(row);
      byId.set(row.id, card);
    }
    card.channels.push({ ...row.channel, rank: row.rank, score: Number(row.score.toFixed(4)) });
  }

  const searchMs = Date.now() - started - embedMs;
  const cards = finalizeCards(byId, terms).slice(0, nResults);
  await attachContext(collection, cards);

  const coverage = judgeCoverage(terms, cards);
  const confidence = !coverage.covered || cards.length === 0 ? 'none' : coverage.witnessTermCount >= 2 ? 'sufficient' : 'thin';
  const evidence = cards.map((c, i) => ({ ...c, ref: i + 1 }));

  const answer =
    confidence === 'none'
      ? {
          kind: 'refusal',
          confidence,
          // 核心红线：不给任何无出处的内容，只说明判据并指向最近的原文。
          text:
            `资料集「${datasetName}」中没有讲到这个问题的原句。` +
            `判据①：${terms.length} 个查询词里，命中句覆盖 ${coverage.hitTerms.length} 个（覆盖率 ${coverage.coverage} < ${coverage.coverageFloor}）；` +
            `判据②：没有任何一句同时包含 2 个查询词。` +
            (cards.length ? `下面是字面最接近 ${Math.min(2, cards.length)} 条原文，仅供判断是否口径不同，不构成答案。` : '没有可展示的近似内容。'),
          statements: [],
          nearestRefs: evidence.slice(0, 2).map((c) => c.ref),
        }
      : {
          kind: 'extractive',
          confidence,
          text: cards
            .slice(0, ANSWER_SENTENCES)
            .map((c, i) => `〔${i + 1}〕${c.sentence}`)
            .join(' '),
          statements: cards.slice(0, ANSWER_SENTENCES).map((c, i) => ({
            ref: i + 1,
            cardId: c.id,
            sentence: c.sentence,
            sectionTitle: c.sectionTitle,
            charStart: c.charStart,
            charEnd: c.charEnd,
          })),
        };

  // 未覆盖不是"返回空"就完事：按痛点 3 立刻落一条卡点（state=open），P6 的复习队列从这里接。
  let stuck = null;
  if (confidence === 'none') {
    try {
      stuck = await recordRefusal({
        datasetName,
        collectionName,
        query,
        terms,
        coverage,
        nearest: cards.slice(0, 2),
        queryEmbedding: vec,
      });
    } catch (err) {
      stuck = { error: `卡点账本写入失败：${err.message}` };
    }
  }

  return {
    query,
    datasetName,
    collectionName,
    nResults,
    terms,
    channels,
    coverage,
    confidence,
    answer,
    evidence,
    stuck,
    timing: { totalMs: Date.now() - started, embedMs, searchMs },
  };
}
