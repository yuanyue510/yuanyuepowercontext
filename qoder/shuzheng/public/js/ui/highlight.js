/** 把命中的查询词在句子里加粗（纯 DOM 拼接，不走 innerHTML，资料内容不可信）。 */
export function textWithTerms(text, terms = []) {
  const frag = document.createDocumentFragment();
  const words = [...new Set(terms.filter((t) => t && t.length >= 2))].sort((a, b) => b.length - a.length);
  if (words.length === 0) {
    frag.append(text);
    return frag;
  }
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const b = document.createElement('b');
    b.className = 'term';
    b.textContent = m[0];
    frag.append(b);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/**
 * 按 char_start–char_end 在规范化全文里定位并高亮一个句子（验收点 B.4：不偏移一个字）。
 * 渲染前先自查：slice(start,end) 必须与证据卡里的原句逐字相同，不一致就把偏差报出来而不是硬显示。
 */
export function renderLocated(root, text, card) {
  root.textContent = '';
  const { charStart, charEnd } = card;
  const exact = Number.isInteger(charStart) && Number.isInteger(charEnd) && text.slice(charStart, charEnd) === card.sentence;

  if (!exact) {
    root.append(document.createTextNode(text));
    return { exact, note: 'offset 与原文不一致（已回退为全文纯文本显示）' };
  }

  root.append(text.slice(0, charStart));
  const mark = document.createElement('mark');
  mark.textContent = card.sentence;
  root.append(mark);
  root.append(text.slice(charEnd));
  mark.scrollIntoView({ block: 'center' });
  return { exact, note: `char ${charStart}–${charEnd} 与原文逐字一致` };
}
