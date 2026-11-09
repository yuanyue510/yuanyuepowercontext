import { CONFIG } from './config.mjs';

/**
 * 中文友好的切片：优先在段落/句末断开，控制每片 320 字、重叠 60 字。
 * 切片结果是检索的最小单位，metadata 里保留文件名与片序号，用于界面追溯出处。
 */
export function chunkText(text, { size = CONFIG.chunk.size, overlap = CONFIG.chunk.overlap } = {}) {
  const clean = String(text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/);
  const chunks = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
  };
  for (const p of paras) {
    if ((buf + '\n\n' + p).length <= size) {
      buf = buf ? buf + '\n\n' + p : p;
      continue;
    }
    if (buf) {
      flush();
      // 重叠：保留上一片尾部，保证跨段语义不被切断
      buf = buf.length > overlap ? buf.slice(-overlap) + '\n\n' + p : p;
    } else {
      buf = p;
    }
    // 单段本身超长，按句号硬切
    while (buf.length > size * 1.5) {
      let cut = buf.lastIndexOf('。', size);
      if (cut < size * 0.6) cut = size;
      else cut += 1;
      chunks.push(buf.slice(0, cut).trim());
      buf = buf.slice(Math.max(0, cut - overlap));
    }
  }
  flush();
  return chunks.filter((c) => c.length > 20);
}

/** 稳定的片段 id：同一文件同一序号重复导入即覆盖（幂等） */
export function chunkId(source, index) {
  const base = String(source).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 60);
  return `${base}#${String(index).padStart(3, '0')}`;
}
