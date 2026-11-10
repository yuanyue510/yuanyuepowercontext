const STOP = [
  '什么', '怎么', '如何', '哪些', '为什么', '请问', '请', '介绍', '说明', '一下', '多少',
  '哪个', '怎样', '可以', '这个', '那个', '以及', '关于', '对于', '通过', '进行', '之间',
  '是不', '是', '的', '了', '和', '与', '及', '在', '有', '吗', '呢', '它', '他们', '我', '你',
];

const HAN = /[一-龥]+/g;
const SPLIT_RE = new RegExp(
  [...STOP].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

/**
 * 从问句里挑全文检索关键词：汉字串 → 一次性剥掉所有疑问/虚词 → 优先长词（信息量高）。
 * $contains 一次只接受一个词，故只出一个主关键词，其余留给多路召回（P5）。
 */
export function extractKeywords(query) {
  const pieces = [];
  for (const run of query.match(HAN) ?? []) {
    for (const part of run.split(SPLIT_RE)) {
      if (part.length >= 2) pieces.push(part);
    }
  }

  const candidates = [...new Set(pieces)].sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh'));
  return { primary: candidates[0] ?? query.trim(), candidates };
}
