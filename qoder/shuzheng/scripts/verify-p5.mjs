// P5 验收：走真实 HTTP 链路（服务需已 npm start），逐条打印判据与"点引用后定位到的原句"。
const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const DATASET = process.argv[2] || '生物必修1-细胞代谢讲义';
const QUERIES = [
  '酶有什么特性',
  '有氧呼吸哪个阶段释放的能量最多',
  'ATP与ADP怎么相互转化',
  '洛伦兹力的方向怎么判断',
];

const post = async (url, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};

const doc = await (await fetch(`${BASE}/api/dataset/${encodeURIComponent(DATASET)}/text`)).json();
console.log(`资料集「${DATASET}」原文 ${doc.charCount} 字（doc ${doc.docId}，状态 ${doc.status}）\n`);

for (const query of QUERIES) {
  const { status, data } = await post('/api/search', { datasetName: DATASET, query, nResults: 8 });
  const c = data.coverage;
  console.log(`问：${query}                                    [HTTP ${status}｜${data.timing.totalMs} ms]`);
  console.log(`  查询词 ${JSON.stringify(data.terms)}｜召回通道 ${data.channels.map((x) => (x.type === 'vector' ? `向量:${x.hits}` : `${x.keyword}:${x.hits}`)).join(' ')}`);
  console.log(`  覆盖率 ${c.coverage}（阈值 ${c.coverageFloor}）→ 规则① ${c.rule1LowCoverage ? '成立' : '不成立'}｜最强一句含 ${c.witnessTermCount} 词 → 规则② ${c.rule2NoSharedTermSentence ? '成立' : '不成立'}`);
  console.log(`  判定：${c.covered ? '已覆盖' : '未覆盖（拒答）'}｜置信 ${data.confidence}｜证据卡 ${data.evidence.length} 条｜命中词 ${c.hitTerms.join('/') || '无'}｜未出现 ${c.missedTerms.join('/') || '无'}`);

  const shown = data.answer.kind === 'refusal' ? data.evidence.slice(0, 2) : data.answer.statements;
  for (const item of shown) {
    const { charStart, charEnd } = item;
    const slice = doc.text.slice(charStart, charEnd);
    console.log(`  〔${item.ref}〕定位 char ${charStart}–${charEnd} → 逐字一致 ${slice === item.sentence ? '是' : '否'}`);
    console.log(`        ${slice.replace(/\n/g, ' ⏎ ')}`);
  }
  if (data.answer.kind === 'refusal') {
    console.log(`  拒答文案：${data.answer.text}`);
    console.log(`  卡点账本：${data.stuck?.stuckId ? `${data.stuck.collectionName} → ${data.stuck.stuckId}（${data.stuck.state}）` : JSON.stringify(data.stuck)}`);
  }
  console.log();
}

const stuck = await (await fetch(`${BASE}/api/stuck?limit=5`)).json();
console.log(`卡点账本 ${stuck.name}：共 ${stuck.total} 条`);
for (const row of stuck.rows) {
  console.log(`  ${row.id}｜${row.state}｜问「${row.question_text}」｜覆盖率 ${row.coverage}｜未出现词 ${row.missed_terms}｜最近证据 ${row.nearest_ids}`);
}
