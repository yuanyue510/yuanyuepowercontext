import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';

/**
 * npm run seed：把 eval/corpus 里的两篇示例资料导入 seekdb。
 * 可重复执行 —— 同名资料集是整体重建（recreateCollection），第二次不会多出切片。
 * 服务需已 npm start（默认 http://127.0.0.1:8790，可用 BASE_URL 覆盖）。
 */
const BASE = process.env.BASE_URL || `http://127.0.0.1:${config.http.port}`;
const CORPUS = ['物理必修1-动力学讲义.md', '生物必修1-细胞代谢讲义.md'];

let failed = 0;
for (const file of CORPUS) {
  const datasetName = path.basename(file, path.extname(file));
  const text = await fs.readFile(path.join(config.root, 'eval', 'corpus', file), 'utf8');
  const res = await fetch(`${BASE}/api/dataset/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetName, filename: file, text }),
  });
  const s = await res.json();
  if (!res.ok || !s.offsetOk) {
    failed += 1;
    console.error(`[seed] ${datasetName} 导入失败：HTTP ${res.status} ${JSON.stringify(s)}`);
    continue;
  }
  console.log(
    `[seed] ${datasetName}｜${s.sectionCount} 小节 → ${s.chunkCount} 切片（R1 合并 ${s.mergedCount} 条，短句 ${s.residualShort} 条）` +
      `｜offset 自检 ${s.offsetOk ? '通过' : '未通过'}｜向量化 ${s.embedMs} ms` +
      `｜就绪门槛 轮询 ${s.readyPolls} 次 × ${s.readyIntervalMs} ms（上限 ${s.readyTimeoutMs} ms）= ${s.readyMs} ms` +
      `｜集合 ${s.collectionName}（doc ${s.docId}）${s.previousRebuilt ? '｜重建同名集合' : ''}`,
  );
}

const list = await (await fetch(`${BASE}/api/dataset/list`)).json();
console.log(`[seed] 当前登记：${list.datasets.map((d) => `${d.name}(${d.chunkCount} 切片, ${d.status})`).join('、')}`);
process.exit(failed ? 1 : 0);
