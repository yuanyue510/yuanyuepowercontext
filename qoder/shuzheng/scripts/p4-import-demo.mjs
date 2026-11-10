// P4 端到端冒烟：示例语料 → 句级切片(R1/R2) → 本地 ONNX 向量化 → 写 seekdb → 混合检索
import fs from 'node:fs/promises';
import path from 'node:path';
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from 'seekdb';
import { config } from '../server/config.js';
import { normalizeText, parseSections } from '../server/lib/ingest/section.js';
import { splitSentences, mergeShortSentences } from '../server/lib/ingest/sentence.js';
import { embedDocuments, embedQuery, EMBEDDING_META } from '../server/lib/embed/local-embedder.js';
import { extractKeywords } from '../server/lib/answer/keywords.js';
import { collectionNameFor, assertOwnCollection } from '../server/lib/seekdb/naming.js';

const CORPUS = path.join(config.root, 'eval', 'corpus', '物理必修1-动力学讲义.md');
const DATASET_NAME = '物理必修1-动力学讲义';
const DOC_ID = 'doc_demo_dyn';
const QUERIES = [
  '什么是牛顿第二定律',
  '合外力做功和动能变化是什么关系',
  '机械能守恒的条件是什么',
  '洛伦兹力的方向怎么判断', // 教材未覆盖，用于观察空/弱命中
];

const raw = await fs.readFile(CORPUS, 'utf8');
const normalized = normalizeText(raw);
await fs.mkdir(config.paths.normalized, { recursive: true });
await fs.writeFile(path.join(config.paths.normalized, `${DOC_ID}.txt`), normalized, 'utf8');

const sections = parseSections(normalized);
const chunks = [];
for (const section of sections) {
  const merged = mergeShortSentences(splitSentences(normalized, section));
  merged.forEach((s, i) => {
    chunks.push({
      id: `${DOC_ID}#${section.sectionId}#${String(i + 1).padStart(3, '0')}`,
      text: s.text,
      indexText: `${section.title} ${s.text}`,
      mergedCount: s.mergedCount,
      meta: {
        dataset_id: DATASET_NAME,
        dataset_name: DATASET_NAME,
        doc_id: DOC_ID,
        section_id: section.sectionId,
        section_title: section.title,
        section_path: section.breadcrumb,
        sent_no: i + 1,
        merged_count: s.mergedCount,
        char_start: s.charStart,
        char_end: s.charEnd,
        has_formula: /[_^]|[=<>]|\\frac/.test(s.text),
        norm_len: s.text.length,
      },
    });
  });
}

const tooShort = chunks.filter((c) => c.text.replace(/[。！？；…]+$/, '').length < config.chunk.minSentenceChars && c.mergedCount === 1);
console.log(`[1] 解析：小节 ${sections.length} 个，切片 ${chunks.length} 条`);
console.log(`    R1 短句合并生效 ${chunks.filter((c) => c.mergedCount > 1).length} 条；残留 <15 字且未合并 ${tooShort.length} 条`);
console.log(`    小节样例：${sections.slice(0, 3).map((s) => s.breadcrumb).join(' | ')}`);

const t0 = Date.now();
const embeddings = [];
for (let i = 0; i < chunks.length; i += 8) {
  embeddings.push(...(await embedDocuments(chunks.slice(i, i + 8).map((c) => c.indexText))));
}
console.log(`[2] 本地向量化：${embeddings.length} 条，维度 ${embeddings[0].length}，用时 ${Date.now() - t0} ms（模型 ${EMBEDDING_META.modelId}，离线）`);

const client = new SeekdbClient({
  host: config.seekdb.host, port: config.seekdb.port,
  user: config.seekdb.user, password: config.seekdb.password, database: config.seekdb.database,
});

const NAME = collectionNameFor(DATASET_NAME);
assertOwnCollection(NAME);
await client.deleteCollection(NAME).catch(() => {});
const schema = new Schema({
  fulltextIndex: new FulltextIndexConfig(config.collection.fulltextParser, {
    min_ngram_size: config.collection.minNgramSize, max_ngram_size: config.collection.maxNgramSize,
  }),
  vectorIndex: new VectorIndexConfig({ hnsw: { dimension: config.embedding.dimension, distance: 'cosine' } }),
});
const collection = await client.createCollection({ name: NAME, schema, dimension: config.embedding.dimension, embeddingFunction: null });
console.log(`[3] 集合就绪：${NAME}（中文名「${DATASET_NAME}」经 naming.js 映射）`);

for (let i = 0; i < chunks.length; i += 8) {
  const batch = chunks.slice(i, i + 8);
  await collection.add({
    ids: batch.map((c) => c.id),
    documents: batch.map((c) => c.indexText),
    embeddings: embeddings.slice(i, i + 8),
    metadatas: batch.map((c) => c.meta),
  });
}
console.log(`[4] 写入完成：${chunks.length} 条（每批 8 条）`);

const probe = chunks[0];
const slice = normalized.slice(probe.meta.char_start, probe.meta.char_end);
console.log(`[5] offset 自检：chunk[0] char_start/end → 原文 ${slice === probe.text ? '一致' : '不一致'}｜"${slice}"`);

for (const q of QUERIES) {
  const { primary } = extractKeywords(q);
  const vec = await embedQuery(q);
  const res = await collection.hybridSearch({
    query: { whereDocument: { $contains: primary } },
    knn: { queryEmbeddings: [vec] },
    nResults: 3,
  });
  const ids = res.ids?.flat() ?? [];
  const docs = res.documents?.flat() ?? [];
  console.log(`\n[6] 问：${q}`);
  console.log(`    主关键词：${primary}｜命中 ${ids.length} 条`);
  ids.slice(0, 3).forEach((id, i) => {
    const meta = res.metadatas?.flat()[i] ?? {};
    console.log(`    #${i + 1} [${meta.dataset_name} / ${meta.section_title}] ${meta.sent_no}句 ${res.distances?.flat()[i].toFixed(4)}`);
    console.log(`         ${docs[i]}`);
  });
}

await client.close();
