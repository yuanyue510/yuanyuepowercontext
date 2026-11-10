// 目的只有一个：确认 hybridSearch 的 distances 是"纯向量距离"还是"融合后的名次分"。
// 做法：全文关键词固定不变，只换查询向量。结论记完即停，不做阈值校准。
import { SeekdbClient } from 'seekdb';
import { config } from '../server/config.js';

const NAME = 'sh_probe_ngram'; // P3 留下的回归基线集合，4 条文档，入库向量种子 1..4
const DIM = config.embedding.dimension;

const pseudo = (seed) => {
  const v = new Array(DIM);
  let x = seed;
  for (let i = 0; i < DIM; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = x / 2147483648;
  }
  return v;
};

const client = new SeekdbClient({
  host: config.seekdb.host,
  port: config.seekdb.port,
  user: config.seekdb.user,
  password: config.seekdb.password,
  database: config.seekdb.database,
});
const collection = await client.getCollection({ name: NAME, embeddingFunction: null });

const KEYWORD = '动能'; // 只命中 p2，保持不变
for (const [label, vec] of [
  ['与 p2 入库向量完全相同 (seed=2)', pseudo(2)],
  ['完全无关的随机向量 (seed=99)', pseudo(99)],
  ['p1 的入库向量 (seed=1)', pseudo(1)],
]) {
  const r = await collection.hybridSearch({
    query: { whereDocument: { $contains: KEYWORD } },
    knn: { queryEmbeddings: [vec] },
    nResults: 4,
  });
  console.log(`关键词"${KEYWORD}" 查询向量=${label}`);
  console.log('   ids       =', JSON.stringify(r.ids?.flat()));
  console.log('   distances =', JSON.stringify(r.distances?.flat()));
}

// 对照：同一向量、只改关键词，看分数是否随文本命中变化
for (const kw of ['动能', '自由落体', '不存在的词xyz']) {
  const r = await collection.hybridSearch({
    query: { whereDocument: { $contains: kw } },
    knn: { queryEmbeddings: [pseudo(2)] },
    nResults: 4,
  });
  console.log(`查询向量固定(seed=2) 关键词="${kw}"`);
  console.log('   ids       =', JSON.stringify(r.ids?.flat()));
  console.log('   distances =', JSON.stringify(r.distances?.flat()));
}

await client.close();
