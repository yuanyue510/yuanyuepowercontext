import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { ensureCollection } from '../seekdb/collections.js';
import { recordStuck } from '../review/store.js';

const NAME = `${config.collection.namespace}stuck`;

let collectionPromise = null;
const collection = () => (collectionPromise ??= ensureCollection(NAME));

/**
 * F5.4 判为未覆盖 → 立刻落一条卡点（痛点 3：事后别忘了自己卡在哪）。
 * 复用检索时算好的查询向量，不再向量化一次；写失败不静默，错误随检索结果返回。
 *
 * 两处落库分工不同，不是重复：
 *  - 集合 sh_stuck：一次拒答一条流水（id 带时间戳），存问题原文 + 查询向量，将来可做"相似卡点"聚类；
 *  - 关系表 sh_review：按 (资料集, 问题) 去重的复习队列，带 status/miss_count，P6 的状态机只改这张表。
 *  　　关系表走独立 mysql2 连接，见 server/lib/seekdb/sql.js。
 */
export async function recordRefusal({ datasetName, collectionName, query, terms, coverage, nearest, queryEmbedding }) {
  const col = await collection();
  const id = `st_${createHash('sha1').update(`${datasetName}::${query}::${Date.now()}`).digest('hex').slice(0, 12)}`;
  const now = Date.now();

  await col.add({
    ids: [id],
    documents: [query],
    embeddings: [queryEmbedding],
    metadatas: [
      {
        source: 'refusal',
        state: 'open',
        question_text: query,
        dataset_name: datasetName,
        chunk_collection: collectionName,
        query_terms: terms.join(','),
        coverage: coverage.coverage,
        rule1_low_coverage: coverage.rule1LowCoverage,
        rule2_no_shared_term_sentence: coverage.rule2NoSharedTermSentence,
        missed_terms: coverage.missedTerms.join(','),
        nearest_ids: nearest.map((c) => c.id).join(','),
        created_at: now,
      },
    ],
  });

  const review = await recordStuck({
    datasetName,
    questionText: query,
    // 「概念」取没被命中句证到的查询词——这正是资料没讲到的那个说法；一个都没命中时退回全部查询词。
    concept: (coverage.missedTerms.length ? coverage.missedTerms : coverage.terms).join('、'),
    coverage: coverage.coverage,
    missedTerms: coverage.missedTerms.join('、'),
    nearestDocId: nearest[0]?.docId ?? null,
    stuckId: id,
  });

  return { stuckId: id, collectionName: NAME, state: 'open', reviewId: review.id };
}

export async function listStuck(limit = 20) {
  const col = await collection();
  const res = await col.get({ limit, include: ['metadatas'] });
  return {
    name: NAME,
    total: await col.count(),
    rows: (res.ids ?? []).map((id, i) => ({ id, ...(res.metadatas?.[i] ?? {}) })),
  };
}
