import { Schema, FulltextIndexConfig, VectorIndexConfig } from 'seekdb';
import { config } from '../../config.js';
import { getClient, execute, openCollection } from './client.js';
import { assertOwnCollection } from './naming.js';

const REGISTRY = `${config.collection.namespace}registry`;

const buildSchema = () =>
  new Schema({
    fulltextIndex: new FulltextIndexConfig(config.collection.fulltextParser, {
      min_ngram_size: config.collection.minNgramSize,
      max_ngram_size: config.collection.maxNgramSize,
    }),
    vectorIndex: new VectorIndexConfig({
      hnsw: { dimension: config.embedding.dimension, distance: 'cosine' },
    }),
  });

export { buildSchema };

export async function ensureRegistryTable() {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${REGISTRY} (
       name VARCHAR(200) PRIMARY KEY,
       collection_name VARCHAR(200) NOT NULL,
       doc_id VARCHAR(100) NOT NULL,
       filename VARCHAR(300),
       chunk_count INT,
       status VARCHAR(32),
       updated_at BIGINT
     )`,
  );
}

export async function upsertRegistry(row) {
  await execute(
    `INSERT INTO ${REGISTRY} (name, collection_name, doc_id, filename, chunk_count, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE collection_name=VALUES(collection_name), doc_id=VALUES(doc_id),
       filename=VALUES(filename), chunk_count=VALUES(chunk_count), status=VALUES(status), updated_at=VALUES(updated_at)`,
    [row.name, row.collectionName, row.docId, row.filename, row.chunkCount, row.status, Date.now()],
  );
}

export async function listRegistry() {
  const rows = await execute(`SELECT * FROM ${REGISTRY} ORDER BY updated_at DESC`);
  return rows.map((r) => ({
    name: r.name,
    collectionName: r.collection_name,
    docId: r.doc_id,
    filename: r.filename,
    chunkCount: r.chunk_count,
    status: r.status,
    updatedAt: Number(r.updated_at),
  }));
}

export async function findDataset(name) {
  const rows = await execute(`SELECT * FROM ${REGISTRY} WHERE name = ?`, [name]);
  return rows[0] ?? null;
}

/** 重建同名集合：只删本项目 sh_ 前缀对象，绝不碰库里其它项目的表。 */
export async function recreateCollection(asciiName) {
  assertOwnCollection(asciiName);
  await getClient().deleteCollection(asciiName).catch(() => {});
  return getClient().createCollection({
    name: asciiName,
    schema: buildSchema(),
    dimension: config.embedding.dimension,
    embeddingFunction: null,
  });
}

/** 账本类集合（sh_stuck 等）：与切片集合同一套 ngram2 + hnsw512 schema，缺失才建，绝不删除。 */
export async function ensureCollection(asciiName) {
  assertOwnCollection(asciiName);
  if (await getClient().hasCollection(asciiName)) return openCollection(asciiName);
  return getClient().createCollection({
    name: asciiName,
    schema: buildSchema(),
    dimension: config.embedding.dimension,
    embeddingFunction: null,
  });
}

export { openCollection };
