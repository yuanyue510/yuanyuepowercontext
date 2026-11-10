const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** F1.1 的 .html 输入：先转成纯文本再做小节/句子切分。offset 一律以转换后的文本为准，与库里存的正文同源。 */
function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n');
}

export function normalizeText(raw) {
  // 只认"真的像 HTML 文档"的输入，避免把 `F<30N`、`a<b>` 这类物理式子当标签吃掉。
  const looksHtml =
    /^\s*<!doctype\s+html/i.test(raw) ||
    /^\s*<(html|body|div|p|h[1-6]|ul|ol|li|table|section|article)\b/i.test(raw) ||
    /<\/(p|div|li|h[1-6]|tr|table|html|body)>/i.test(raw);
  const text = looksHtml ? htmlToText(raw) : raw;
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * 按 Markdown 标题切小节。返回的 bodyStart/bodyEnd 是「规范化全文」里的绝对字符偏移，
 * 与 data/normalized/<doc>.txt 严格对应，原句定位靠它。
 */
export function parseSections(normalized) {
  const lines = [];
  let offset = 0;
  for (const line of normalized.split('\n')) {
    lines.push({ text: line, start: offset });
    offset += line.length + 1;
  }

  const headings = lines
    .map((l, i) => ({ ...l, lineNo: i, match: HEADING.exec(l.text) }))
    .filter((l) => l.match);

  const sections = [];
  const stack = [];
  headings.forEach((h, idx) => {
    const level = h.match[1].length;
    const title = h.match[2].trim();
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    stack.push({ level, title });
    const next = headings[idx + 1];
    sections.push({
      sectionId: `s${sections.length + 1}`,
      level,
      title,
      breadcrumb: stack.map((s) => s.title).join(' > '),
      bodyStart: h.start + h.text.length + 1,
      bodyEnd: next ? next.start : normalized.length,
    });
  });

  if (sections.length === 0) {
    sections.push({
      sectionId: 's1',
      level: 1,
      title: '正文',
      breadcrumb: '正文',
      bodyStart: 0,
      bodyEnd: normalized.length,
    });
  }
  return sections;
}
