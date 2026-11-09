import { SeekdbClient, AdminClient, Schema, FulltextIndexConfig, VectorIndexConfig } from 'seekdb';

export const COLLECTION_PREFIX = 'kb_';

/**
 * seekdb 连接管理。
 *
 * 两种部署方式都支持：
 *  - server 模式（推荐）：SEEKDB_HOST / SEEKDB_PORT，官方镜像 oceanbase/seekdb
 *  - 嵌入式模式：SEEKDB_PATH=/path/to/dir
 */
export class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = null;
    this.mode = cfg.path ? 'embedded' : 'server';
    this.info = {};
  }

  async connect() {
    const { path: dbPath, host, port, user, password, database } = this.cfg;
    if (this.mode === 'embedded') {
      this.client = new SeekdbClient({ path: dbPath, database });
    } else {
      // 先确保目标库存在，再连到该库
      const admin = new AdminClient({ host, port, user, password });
      try {
        const dbs = await admin.listDatabases(100, 0);
        const names = (dbs || []).map((d) => d.name);
        if (!names.includes(database)) await admin.createDatabase(database);
      } finally {
        await admin.close().catch(() => {});
      }
      this.client = new SeekdbClient({ host, port, user, password, database });
    }
    const rows = await this.client.execute('select version() as v');
    this.info.version = rows?.[0]?.v ?? 'unknown';
    this.info.database = database;
    return this;
  }

  async close() {
    if (this.client) await this.client.close().catch(() => {});
    this.client = null;
  }

  async reconnect() {
    await this.close();
    await this.connect();
  }

  /* ---------------- collection ---------------- */

  async listCollections() {
    const all = await this.client.listCollections({ withEmbeddingFunction: false });
    const out = [];
    for (const c of all) {
      if (!c.name.startsWith(COLLECTION_PREFIX)) continue;
      const info = await c.describe();
      out.push({
        name: c.name.slice(COLLECTION_PREFIX.length),
        table: c.name,
        dimension: info.dimension,
        distance: info.distance,
        count: await c.count(),
        metadata: info.metadata ?? null
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async has(name) {
    return this.client.hasCollection(COLLECTION_PREFIX + name);
  }

  async createCollection(name, dimension, meta = {}) {
    const table = COLLECTION_PREFIX + name;
    if (await this.client.hasCollection(table)) {
      const col = await this.client.getCollection({ name: table, embeddingFunction: null });
      const d = (await col.describe()).dimension;
      if (d !== dimension) {
        const err = new Error(`集合已存在且维度为 ${d}，与当前模型维度 ${dimension} 不一致，请使用另一集合名或删除旧集合`);
        err.code = 'DIM_MISMATCH';
        throw err;
      }
      return { name, table, dimension: d, created: false };
    }
    // 全文索引用 ngram2（中文按 2~3 字切分），向量用 HNSW + cosine
    const schema = new Schema({
      fulltextIndex: new FulltextIndexConfig('ngram2', { min_ngram_size: 2, max_ngram_size: 3 }),
      vectorIndex: new VectorIndexConfig({ hnsw: { dimension, distance: 'cosine', type: 'hnsw', m: 16, ef_construction: 200, ef_search: 128 } })
    });
    await this.client.createCollection({
      name: table,
      schema,
      dimension,
      embeddingFunction: null,
      metadata: { app: 'seekdb-browser-kb', ...meta }
    });
    return { name, table, dimension, created: true };
  }

  async dropCollection(name) {
    const table = COLLECTION_PREFIX + name;
    if (await this.client.hasCollection(table)) await this.client.deleteCollection(table);
  }

  async collection(name) {
    const table = COLLECTION_PREFIX + name;
    if (!(await this.client.hasCollection(table))) {
      const err = new Error(`集合 ${name} 不存在`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this.client.getCollection({ name: table, embeddingFunction: null });
  }

  /* ---------------- write ---------------- */

  async addDocuments(name, items) {
    const col = await this.collection(name);
    const t0 = performance.now();
    // 单批 upsert：同 id 重复导入时覆盖，保证增量导入幂等
    await col.upsert({
      ids: items.map((x) => x.id),
      embeddings: items.map((x) => x.embedding),
      documents: items.map((x) => x.text),
      metadatas: items.map((x) => x.metadata ?? {})
    });
    return performance.now() - t0;
  }

  /** 刷新向量/全文索引，使新写入立即可检索 */
  async refresh(name) {
    const col = await this.collection(name);
    const t0 = performance.now();
    await col.refresh_index();
    return performance.now() - t0;
  }

  async stats(name) {
    const col = await this.collection(name);
    const info = await col.describe();
    return { name, dimension: info.dimension, count: await col.count() };
  }

  /* ---------------- search ---------------- */

  /**
   * 检索全部在 seekdb 内完成：
   *  - hybrid: DBMS_HYBRID_SEARCH(query_string + knn + RRF)
   *  - vector: HNSW 近邻
   *  - fulltext: DBMS_HYBRID_SEARCH 的全文分支
   * 客户端只传查询向量与查询原文，不做任何结果拼接。
   */
  async search(name, { mode = 'hybrid', queryText, embedding, k = 10, rankWindowSize = 40, rankConstant = 60 }) {
    const col = await this.collection(name);
    const t0 = performance.now();
    let res;
    if (mode === 'vector') {
      res = await col.query({
        queryEmbeddings: embedding,
        nResults: k,
        include: ['documents', 'metadatas', 'distances']
      });
    } else if (mode === 'fulltext') {
      res = await col.hybridSearch({
        query: { whereDocument: { $contains: queryText }, nResults: k },
        nResults: k,
        include: ['documents', 'metadatas', 'distances']
      });
    } else {
      res = await col.hybridSearch({
        query: { whereDocument: { $contains: queryText }, nResults: Math.max(k, rankWindowSize) },
        knn: { queryEmbeddings: embedding, nResults: Math.max(k, rankWindowSize) },
        rank: { rrf: { rankWindowSize, rankConstant } },
        nResults: k,
        include: ['documents', 'metadatas', 'distances']
      });
    }
    const ms = performance.now() - t0;
    const ids = res.ids?.[0] ?? [];
    const docs = res.documents?.[0] ?? [];
    const metas = res.metadatas?.[0] ?? [];
    const dists = res.distances?.[0] ?? [];
    return {
      ms,
      mode,
      hits: ids.map((id, i) => ({
        id,
        rank: i + 1,
        score: dists[i],
        text: docs[i] ?? '',
        metadata: metas[i] ?? {}
      }))
    };
  }
}
