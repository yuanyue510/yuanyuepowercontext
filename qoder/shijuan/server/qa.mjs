const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '有', '就', '都', '而', '及', '或', '一个', '什么', '怎么', '如何',
  '为什么', '哪些', '这个', '那个', '我们', '可以', '需要', '进行', '通过', '以及', '其中', '对于', '如果',
  'the', 'a', 'an', 'of', 'to', 'is', 'are', 'and', 'or', 'in', 'on', 'for', 'how', 'what', 'why'
]);

/** 中文 2-gram + 英文/数字 token，作为「查询词」的近似切分 */
export function terms(text) {
  const s = String(text).toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_+#.]{2,}/g) || []) out.add(w);
  const zh = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of zh.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out].filter((t) => !STOP.has(t));
}

function splitParagraphs(text) {
  const raw = String(text)
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const out = [];
  let carry = '';
  for (const p of raw) {
    // 标题不参与回答，但会切断上一段
    if (p.startsWith('#')) {
      if (carry) out.push(carry);
      carry = '';
      continue;
    }
    const merged = carry ? `${carry} ${p}` : p;
    // 以冒号结尾的是列表引导句，与后面的步骤列表合并成一段，否则答案会只剩半句
    if (/[:：]$/.test(merged)) {
      carry = merged;
      continue;
    }
    if (merged.length >= 24) out.push(merged);
    carry = '';
  }
  if (carry.length >= 24 && !/[:：]$/.test(carry)) out.push(carry);
  return out;
}

/**
 * 抽取式回答：不调用任何大模型，直接依据 seekdb 返回的片段组织答案。
 * 每条结论都带 [n] 引用，n 对应 hits 的序号，界面可点开看原文。
 *
 * 打分用「查询词 × 稀有度」：越少见的词命中，说明这一段越可能是答案所在。
 */
export function answerFromHits(question, hits, { threshold = 0.55 } = {}) {
  const qTerms = terms(question);
  const bestSim = hits.length ? Math.max(...hits.map((h) => h.similarity ?? 0)) : 0;
  if (!hits.length) {
    return {
      answer: '资料集里没有检索到相关内容。可以换个说法，或先把相关文档导入当前资料集。',
      citations: [],
      covered: false,
      coverage: 0,
      bestSim: 0
    };
  }

  const paras = [];
  hits.forEach((h, hi) => {
    for (const p of splitParagraphs(h.text)) {
      paras.push({ text: p, ci: hi + 1, source: h.metadata?.source || h.id, rank: hi });
    }
  });

  // 文档频率 → 权重：只有少数片段出现的词更能区分答案
  const df = new Map();
  for (const t of qTerms) {
    let n = 0;
    for (const p of paras) if (p.text.toLowerCase().includes(t)) n += 1;
    df.set(t, n);
  }
  const weight = (t) => Math.log(1 + paras.length / (1 + (df.get(t) || 0)));

  const scored = paras.map((p) => {
    const lower = p.text.toLowerCase();
    let w = 0;
    let hit = 0;
    for (const t of qTerms) {
      if (lower.includes(t)) {
        w += weight(t);
        hit += 1;
      }
    }
    // 片段检索名次越靠前、段落越短，越可能是直接答案
    const rankBonus = 1 / (1 + p.rank * 0.4);
    const lenPenalty = p.text.length > 260 ? 0.85 : 1;
    return { ...p, score: w * rankBonus * lenPenalty, hit };
  });

  const allText = hits.map((h) => h.text).join('\n').toLowerCase();
  const coveredTerms = qTerms.filter((t) => allText.includes(t)).length;
  const coverage = qTerms.length ? coveredTerms / qTerms.length : 0;
  // 「资料有没有讲到」以查询词覆盖率为准：bge 的 cosine 相似度整体偏高，
  // 单看相似度无法区分「相关」与「无关」，覆盖率更可靠。
  const covered = coverage >= 0.34;

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of scored) {
    if (c.hit < 2 || c.score <= 0) continue;
    if (picked.some((p) => overlapRatio(p.text, c.text) > 0.45)) continue;
    // 第二条引用只取与第一条同源的段落，避免答案跨文档拼贴
    if (picked.length && picked[0].source !== c.source) continue;
    picked.push(c);
    if (picked.length >= 2) break;
  }

  if (!picked.length) {
    const first = hits[0];
    return {
      answer: `检索到 ${hits.length} 个相关片段，但没有找到能直接回答「${question}」的段落。最接近的是 [1]（${first.metadata?.source || first.id}），建议点开原文确认。`,
      citations: hits.slice(0, 2).map((h, i) => ({ n: i + 1, source: h.metadata?.source || h.id, text: h.text })),
      covered: false,
      coverage: Number(coverage.toFixed(3)),
      bestSim
    };
  }

  const body = picked
    .map((p) => {
      const t = p.text.length > 420 ? p.text.slice(0, 420) + '…' : p.text;
      // 列表项另起一行，避免答案挤成一大段
      return `- ${t.replace(/ (\d)\. /g, '\n$1. ')} [${p.ci}]`;
    })
    .join('\n');
  const srcs = [...new Set(picked.map((p) => p.source))].join('、');
  const head = covered
    ? `根据 ${srcs}：`
    : `资料里没有正面讲到「${question}」，最接近的说法是：`;

  return {
    answer: `${head}\n${body}`,
    citations: picked.map((p) => ({ n: p.ci, source: p.source, text: p.text })),
    covered,
    coverage: Number(coverage.toFixed(3)),
    bestSim
  };
}

function overlapRatio(a, b) {
  const sa = new Set(terms(a));
  const sb = new Set(terms(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / Math.min(sa.size, sb.size);
}

/** 把问题压成一个可复用的「概念」键，用于薄弱点去重 */
export function conceptKey(question) {
  const s = String(question)
    .replace(/[\s?？。.,，!！:：;；"'“”‘’()（）\[\]【】]/g, '')
    .replace(/^(请问|想问一下|帮我看看|帮我查查|查一下|介绍一下|解释一下)/, '');
  return s.slice(0, 40) || '未命名问题';
}
