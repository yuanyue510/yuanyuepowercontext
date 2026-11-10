import { config } from '../../config.js';

const TERMINATORS = ['。', '！', '？', '；', '…', '\n'];
const LATIN = new Set(['.', '!', '?', ';']);

function isTerminator(ch) {
  return TERMINATORS.includes(ch) || LATIN.has(ch);
}

function formulaDepth(text, from, to) {
  let depth = 0;
  for (let i = from; i < to; i += 1) if (text[i] === '$') depth += 1;
  return depth % 2;
}

/**
 * 小节正文 → 句级切片（带绝对字符偏移）。行内公式 $...$ 内部不断句。
 *
 * 【offset 不变式：文本按构造生成，不做事后 slice】
 * `text` 与 (charStart, charEnd) 由同一对下标产出，所以 `text === source.slice(charStart, charEnd)` 恒成立。
 * 首尾空白靠**移动下标**剥掉，不做 trim —— 一旦 trim 文本而不同步挪下标（或反过来），
 * 证据卡跳原文就会偏字；重复句又会让"事后回头找位置"必然错位的风险变成事实。
 * 相邻两句之间的空白记进 `gapBefore`，R1 合并时一起接上，合并结果仍是原文连续区间
 * （直接拼接曾丢掉句间换行，造成 4/33 条 slice 与正文不等）。
 */
export function splitSentences(normalized, section) {
  const out = [];
  const end = section.bodyEnd;
  let inCode = false;

  const push = (from, to) => {
    while (from < to && /[\s\u3000]/.test(normalized[from])) from += 1;
    while (to > from && /[\s\u3000]/.test(normalized[to - 1])) to -= 1;
    if (to <= from) return;
    out.push({
      text: normalized.slice(from, to),
      charStart: from,
      charEnd: to,
      gapBefore: out.length ? normalized.slice(out[out.length - 1].charEnd, from) : '',
    });
  };

  let start = section.bodyStart;
  for (let i = section.bodyStart; i < end; i += 1) {
    const ch = normalized[i];
    if (ch === '`') inCode = !inCode;
    if (inCode) continue;
    if (!isTerminator(ch)) continue;
    if (formulaDepth(normalized, start, i)) continue;

    push(start, i + 1);
    start = i + 1;
  }

  push(start, end);
  return out;
}

/**
 * R1：少于 minSentenceChars 的句子并入相邻句（优先向前并），
 * 否则 ngram 全文通道会被"是的。""如图。"这类碎片污染。
 */
export function mergeShortSentences(sentences, minChars = config.chunk.minSentenceChars) {
  const append = (prev, sent) => {
    prev.text += sent.gapBefore + sent.text;
    prev.charEnd = sent.charEnd;
    prev.mergedCount += 1;
  };

  const merged = [];
  for (const sent of sentences) {
    const body = sent.text.replace(/[。！？；…]+$/, '');
    const tooShort = body.length < minChars;
    const prev = merged.at(-1);

    if (tooShort && prev) {
      append(prev, sent);
    } else if (tooShort && !prev) {
      merged.push({ ...sent, mergedCount: 1, pending: true });
    } else if (prev?.pending) {
      append(prev, sent);
      delete prev.pending;
    } else {
      merged.push({ ...sent, mergedCount: 1 });
    }
  }
  return merged.filter((s) => s.text.trim().length > 0);
}
