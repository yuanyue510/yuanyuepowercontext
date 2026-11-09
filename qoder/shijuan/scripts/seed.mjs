import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 8790}`;
const COLLECTION = process.env.COLLECTION || '期末复习';

const dir = path.join(ROOT, 'data', 'seed');
const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
const files = [];
for (const name of names) {
  files.push({ name, text: await fs.readFile(path.join(dir, name), 'utf8') });
}
console.log(`导入 ${files.length} 篇到资料集「${COLLECTION}」`);

const t0 = Date.now();
const res = await fetch(`${BASE}/api/docs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ collection: COLLECTION, files })
});
const data = await res.json();
if (!data.ok) {
  console.error('导入失败：', data);
  process.exit(1);
}
for (const f of data.files) console.log(`  ${f.name}  ${f.chars} 字 → ${f.chunks} 片`);
console.log(`共 ${data.chunks} 片；耗时 切片 ${data.ms.chunk}ms / 向量化 ${data.ms.embed}ms / 写入 ${data.ms.write}ms / 刷新索引 ${data.ms.refresh}ms / 自检 ${data.ms.verify}ms`);
console.log(`导入后自检（新片段是否可检索）：${data.selfCheck ? '通过' : '未命中'}`);
console.log(`总耗时 ${Date.now() - t0}ms`);
