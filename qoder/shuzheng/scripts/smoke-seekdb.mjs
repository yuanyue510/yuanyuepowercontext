// P3 冒烟：连接 → 建集合（已存在则复用）→ 写 1 条 → 读回。
// 只操作 sh_ 前缀对象，绝不 DROP 库里已有的其他项目表。
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from 'seekdb';
import { config } from '../server/config.js';

const NAME = 'sh_smoke';
const DIM = config.embedding.dimension;

function pseudo(seed) {
  const v = new Array(DIM);
  let x = seed;
  for (let i = 0; i < DIM; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = x / 2147483648;
  }
  return v;
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
  vectorIndex: new VectorIndexConfig({ hnsw: { dimension: DIM, distance: 'cosine' } }),
});

console.log(`连接 ${config.seekdb.host}:${config.seekdb.port} 数据库=${config.seekdb.database}`);

const tables = await client.execute('SHOW TABLES');
console.log('\n[1] 库里现有表（只读确认，不动非 sh_ 表）:');
console.log(JSON.stringify(tables));

let collection;
try {
  collection = await client.createCollection({
    name: NAME,
    schema,
    dimension: DIM,
    embeddingFunction: null,
  });
  console.log(`\n[2] createCollection 成功: ${NAME} (dimension=${DIM}, parser=${config.collection.fulltextParser}, embeddingFunction=null)`);
} catch (err) {
  if (!/exist/i.test(err.message)) throw err;
  collection = await client.getCollection({ name: NAME, embeddingFunction: null });
  console.log(`\n[2] 集合已存在，复用: ${NAME}（${err.message}）`);
}

const id = `sh_smoke_${Date.now()}`;
const doc = '牛顿第二定律指出物体所受合外力等于质量与加速度的乘积。';
await collection.add({ ids: [id], documents: [doc], embeddings: [pseudo(7)], metadatas: [{ kind: 'smoke' }] });
console.log(`\n[3] add 成功: id=${id}`);

const got = await collection.get({ ids: [id], include: ['documents', 'metadatas'] });
console.log('\n[4] get 读回:');
console.log(JSON.stringify(got));

const hybrid = await collection.hybridSearch({
  query: { whereDocument: { $contains: '合外力' } },
  knn: { queryEmbeddings: [pseudo(7)] },
  nResults: 3,
});
console.log('\n[5] hybridSearch 顶层 keys:', JSON.stringify(Object.keys(hybrid ?? {})));
console.log('    ids       =', JSON.stringify(hybrid?.ids));
console.log('    documents =', JSON.stringify(hybrid?.documents));
console.log('    metadatas =', JSON.stringify(hybrid?.metadatas));
console.log('    分数字段   =', JSON.stringify(
  Object.fromEntries(Object.entries(hybrid ?? {}).filter(([k]) => /dist|score|simil|rank/i.test(k))),
));

// 冒烟集合是一次性产物，跑完即删，避免在共享库里留垃圾（只删本项目 sh_ 集合）
await client.deleteCollection(NAME);
console.log(`\n[6] 已清理冒烟集合: ${NAME}`);

await client.close();
