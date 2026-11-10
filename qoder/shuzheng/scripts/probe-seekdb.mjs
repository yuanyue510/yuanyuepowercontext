// 一次性探针，只回答三个问题（不承载业务逻辑）：
// 1) query.whereDocument.$contains 对中文短词是否命中
// 2) fulltextIndex=ngram2 是否真的生效（创建是否被接受 + 中文子串能否召回）
// 3) hybridSearch 返回结构里有没有 similarity / distances 之类的分数字段
// 运行：npm run probe   （需 seekdb 服务端在 SEEKDB_HOST:SEEKDB_PORT 上监听）
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from 'seekdb';
import { config } from '../server/config.js';

const NAME = 'sh_probe_ngram';
const DIM = config.embedding.dimension;

// 探针不加载 ONNX：用固定种子伪向量，只验证索引与返回结构。
function pseudo(seed) {
  const v = new Array(DIM);
  let x = seed;
  for (let i = 0; i < DIM; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = x / 2147483648;
  }
  return v;
}

const DOCS = [
  { id: 'p1', text: '牛顿第二定律指出物体所受合外力等于质量与加速度的乘积。' },
  { id: 'p2', text: '动能定理描述合外力做功与动能变化之间的关系。' },
  { id: 'p3', text: '自由落体运动的加速度等于重力加速度 g。' },
  { id: 'p4', text: 'The work-energy theorem relates net work to kinetic energy.' },
];

function shape(label, value) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2)?.slice(0, 1200));
}

const client = new SeekdbClient({
  host: config.seekdb.host,
  port: config.seekdb.port,
  user: config.seekdb.user,
  password: config.seekdb.password,
  database: config.seekdb.database,
});

const schema = new Schema({
  fulltextIndex: new FulltextIndexConfig(config.collection.fulltextParser, {
    min_ngram_size: config.collection.minNgramSize,
    max_ngram_size: config.collection.maxNgramSize,
  }),
  vectorIndex: new VectorIndexConfig({
    hnsw: { dimension: DIM, distance: 'cosine' },
  }),
});

try {
  await client.deleteCollection({ name: NAME }).catch(() => {});

  const collection = await client.createCollection({
    name: NAME,
    schema,
    dimension: DIM,
    embeddingFunction: null,
  });
  console.log(`[OK] createCollection 接受 parser=${config.collection.fulltextParser} + embeddingFunction:null`);

  await collection.add({
    ids: DOCS.map((d) => d.id),
    documents: DOCS.map((d) => d.text),
    embeddings: DOCS.map((_, i) => pseudo(i + 1)),
  });
  console.log(`[OK] add 写入 ${DOCS.length} 条（向量由外部提供）`);

  const run = (label, params) =>
    collection
      .hybridSearch(params)
      .then((r) => {
        const ids = r?.ids?.flat?.().filter(Boolean) ?? [];
        console.log(`\n[${label}] 命中 ids = ${JSON.stringify(ids)}`);
        return r;
      })
      .catch((err) => {
        console.log(`\n[${label}] 失败: ${err.message}`);
        return null;
      });

  // 检查点 1：中文短词 $contains
  const c1 = await run('1 中文双字 "动能"', {
    query: { whereDocument: { $contains: '动能' } },
    knn: { queryEmbeddings: [pseudo(2)] },
    nResults: 4,
  });
  await run('1 中文短语 "合外力做功"', {
    query: { whereDocument: { $contains: '合外力做功' } },
    knn: { queryEmbeddings: [pseudo(2)] },
    nResults: 4,
  });

  // 检查点 2：ngram2 生效判据 —— 跨词边的二元组（教材里常见：只输入词的一部分也能召回）
  await run('2 ngram 片段 "重力加"', {
    query: { whereDocument: { $contains: '重力加' } },
    knn: { queryEmbeddings: [pseudo(3)] },
    nResults: 4,
  });
  await run('2 ngram 片段 "能定"', {
    query: { whereDocument: { $contains: '能定' } },
    knn: { queryEmbeddings: [pseudo(2)] },
    nResults: 4,
  });

  // 检查点 3：返回结构里是否有分数字段
  console.log('\n--- 3 hybridSearch 返回顶层 keys ---');
  console.log(Object.keys(c1 ?? {}));
  shape('3 返回结构原样', c1);
} catch (err) {
  console.error('[FAIL]', err.message);
  if (err.cause) console.error('cause:', err.cause?.message ?? err.cause);
  process.exitCode = 1;
} finally {
  await client.close?.();
}
