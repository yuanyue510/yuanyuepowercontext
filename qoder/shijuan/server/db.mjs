import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import {
  SeekdbClient,
  AdminClient,
  Schema,
  FulltextIndexConfig,
  VectorIndexConfig
} from 'seekdb';
import { CONFIG } from './config.mjs';

const PREFIX = 'sj_';

/**
 * seekdb 的集合（表）名只允许 [a-zA-Z0-9_]，而用户需要中文资料集名。
 * 这里用「中文标签 → 稳定 slug」映射：标签存在 sj_collections 表里，
 * 表名固定为 sj_<slug>，同一个标签每次算出的 slug 相同，重装也不会变。
 */
export function slugOf(label) {
  return 'c_' + createHash('sha256').update(String(label)).digest('hex').slice(0, 10);
}

/**
 * seekdb 双通道封装：
 *  1) 文档集合（向量 + 全文混合检索）走官方 SDK，索引与 RRF 融合都在库内完成；
 *  2) 学习记忆（学习者 / 提问 / 薄弱点 / 复习记录）走 SQL，用结构化条件查询。
 *
 * 两条通道连的是同一个 seekdb 实例，同一个 database。
 */
export class Db {
  constructor(cfg = CONFIG.seekdb) {
    this.cfg = cfg;
    this.client = null;
    this.pool = null;
    this.version = 'unknown';
  }

  async connect() {
    const { host, port, user, password, database } = this.cfg;
    // 1. 确保 database 存在（seekdb 兼容 MySQL 协议，information_schema 可直接查）
    const admin = new AdminClient({ host, port, user, password });
    try {
      const dbs = await admin.listDatabases(200, 0);
      if (!dbs.some((d) => d.name === database)) await admin.createDatabase(database);
    } finally {
      await admin.close().catch(() => {});
    }

    // 2. 文档集合通道
    this.client = new SeekdbClient({ host, port, user, password, database });

    // 3. 结构化通道（连接池，避免空闲连接被服务端回收后失效）
    this.pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 4,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });

    const [rows] = await this.pool.query('select version() as v');
    this.version = rows[0].v;
    await this.initMemorySchema();
    return this;
  }

  async close() {
    if (this.client) await this.client.close().catch(() => {});
    if (this.pool) await this.pool.end().catch(() => {});
  }

  /* ---------------- 记忆表结构 ---------------- */

  async initMemorySchema() {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS sj_collections (
        slug VARCHAR(32) PRIMARY KEY,
        label VARCHAR(64) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uk_label (label)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS sj_learners (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(64) NOT NULL DEFAULT '',
        created_at DATETIME(3) NOT NULL,
        last_seen DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS sj_questions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        learner VARCHAR(64) NOT NULL,
        collection VARCHAR(64) NOT NULL,
        question TEXT NOT NULL,
        mode VARCHAR(16) NOT NULL,
        top_score DOUBLE NULL,
        hit_count INT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        KEY idx_q_learner (learner, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS sj_weakpoints (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        learner VARCHAR(64) NOT NULL,
        collection VARCHAR(64) NOT NULL,
        concept VARCHAR(191) NOT NULL,
        question TEXT NOT NULL,
        evidence TEXT NULL,
        asks INT NOT NULL DEFAULT 1,
        misses INT NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        last_score DOUBLE NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uk_weak (learner, collection, concept)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS sj_reviews (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        weak_id BIGINT NOT NULL,
        result VARCHAR(16) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY idx_r_weak (weak_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ];
    for (const sql of ddl) await this.pool.query(sql);
  }

  /* ---------------- 文档集合 ---------------- */

  /** 标签 → {slug,label}，不存在则登记（只登记，不建表） */
  async resolve(label) {
    const [rows] = await this.pool.query('SELECT slug, label FROM sj_collections WHERE label=?', [label]);
    if (rows.length) return rows[0];
    const slug = slugOf(label);
    await this.pool.query(
      'INSERT INTO sj_collections (slug, label, created_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label)',
      [slug, label, new Date()]
    );
    return { slug, label };
  }

  async listCollections() {
    const [rows] = await this.pool.query('SELECT slug, label FROM sj_collections ORDER BY created_at');
    const out = [];
    for (const r of rows) {
      const table = PREFIX + r.slug;
      let count = 0;
      if (await this.client.hasCollection(table)) {
        const col = await this.client.getCollection({ name: table, embeddingFunction: null });
        count = await col.count();
      }
      out.push({ name: r.label, slug: r.slug, count, dimension: CONFIG.embed.dimension });
    }
    return out;
  }

  async createCollection(label) {
    const { slug } = await this.resolve(label);
    const table = PREFIX + slug;
    if (await this.client.hasCollection(table)) {
      return { name: label, slug, created: false };
    }
    const schema = new Schema({
      fulltextIndex: new FulltextIndexConfig('ngram2', { min_ngram_size: 2, max_ngram_size: 3 }),
      vectorIndex: new VectorIndexConfig({
        hnsw: {
          dimension: CONFIG.embed.dimension,
          distance: 'cosine',
          type: 'hnsw',
          m: 16,
          ef_construction: 200,
          ef_search: 128
        }
      })
    });
    await this.client.createCollection({
      name: table,
      schema,
      dimension: CONFIG.embed.dimension,
      embeddingFunction: null,
      metadata: { app: 'shijuan', label }
    });
    return { name: label, slug, created: true };
  }

  async deleteCollection(label) {
    const { slug } = await this.resolve(label);
    const table = PREFIX + slug;
    if (await this.client.hasCollection(table)) {
      await this.client.deleteCollection(table);
      await this.pool.query('DELETE FROM sj_collections WHERE slug=?', [slug]);
      return { name: label, deleted: true };
    }
    return { name: label, deleted: false };
  }

  async collection(label) {
    const { slug } = await this.resolve(label);
    const table = PREFIX + slug;
    if (!(await this.client.hasCollection(table))) {
      const err = new Error(`资料集 ${label} 不存在`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this.client.getCollection({ name: table, embeddingFunction: null });
  }

  async upsertDocs(name, items) {
    const col = await this.collection(name);
    await col.upsert({
      ids: items.map((x) => x.id),
      embeddings: items.map((x) => x.embedding),
      documents: items.map((x) => x.text),
      metadatas: items.map((x) => x.metadata ?? {})
    });
  }

  async refresh(name) {
    const col = await this.collection(name);
    await col.refresh_index();
  }

  /**
   * 检索：三种模式都交给 seekdb，客户端只传查询原文与查询向量。
   *  - hybrid：DBMS_HYBRID_SEARCH，全文 + KNN 双路召回，RRF 在库内融合
   *  - vector：HNSW 近邻
   *  - fulltext：全文分支
   */
  async search(name, { mode = 'hybrid', queryText, embedding, k = 8 }) {
    const col = await this.collection(name);
    const win = Math.max(k, CONFIG.search.rankWindowSize);
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
        query: { whereDocument: { $contains: queryText }, nResults: win },
        knn: { queryEmbeddings: embedding, nResults: win },
        rank: { rrf: { rankWindowSize: CONFIG.search.rankWindowSize, rankConstant: CONFIG.search.rankConstant } },
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
        // cosine 距离 → 相似度，便于界面理解
        similarity: dists[i] == null ? null : Number((1 - dists[i]).toFixed(4)),
        text: docs[i] ?? '',
        metadata: metas[i] ?? {}
      }))
    };
  }

  /* ---------------- 记忆读写 ---------------- */

  async touchLearner(learner, name = '') {
    const now = new Date();
    await this.pool.query(
      `INSERT INTO sj_learners (id, name, created_at, last_seen) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE last_seen=VALUES(last_seen), name=IF(VALUES(name)='', name, VALUES(name))`,
      [learner, name, now, now]
    );
  }

  async recordQuestion({ learner, collection, question, mode, topScore, hitCount }) {
    await this.pool.query(
      `INSERT INTO sj_questions (learner, collection, question, mode, top_score, hit_count, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [learner, collection, question, mode, topScore, hitCount, new Date()]
    );
  }

  /** 薄弱点：同一学习者 + 资料集 + 概念只保留一行，累加次数 */
  async upsertWeak({ learner, collection, concept, question, evidence, score, miss = 0 }) {
    const now = new Date();
    await this.pool.query(
      `INSERT INTO sj_weakpoints (learner, collection, concept, question, evidence, asks, misses, status, last_score, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?, 'open', ?,?,?)
       ON DUPLICATE KEY UPDATE asks=asks+1, misses=misses+VALUES(misses),
         status='open', last_score=VALUES(last_score), evidence=VALUES(evidence), updated_at=VALUES(updated_at)`,
      [learner, collection, concept, question, evidence, miss, score, now, now]
    );
    const [rows] = await this.pool.query(
      'SELECT * FROM sj_weakpoints WHERE learner=? AND collection=? AND concept=?',
      [learner, collection, concept]
    );
    return rows[0];
  }

  async listWeak(learner, { status = 'open', limit = 50 } = {}) {
    const [rows] = await this.pool.query(
      `SELECT * FROM sj_weakpoints WHERE learner=? AND status=? ORDER BY misses DESC, asks DESC, updated_at DESC LIMIT ?`,
      [learner, status, Number(limit)]
    );
    return rows;
  }

  async reviewWeak(weakId, result) {
    const now = new Date();
    await this.pool.query('INSERT INTO sj_reviews (weak_id, result, created_at) VALUES (?,?,?)', [
      weakId,
      result,
      now
    ]);
    if (result === 'understood') {
      await this.pool.query("UPDATE sj_weakpoints SET status='mastered', updated_at=? WHERE id=?", [now, weakId]);
    }
    const [rows] = await this.pool.query('SELECT * FROM sj_weakpoints WHERE id=?', [weakId]);
    return rows[0];
  }

  async memoryOverview(learner) {
    const [[q]] = await this.pool.query(
      'SELECT COUNT(*) AS n, AVG(top_score) AS avg_score FROM sj_questions WHERE learner=?',
      [learner]
    );
    const [[w]] = await this.pool.query(
      `SELECT SUM(status='open') AS open_n, SUM(status='mastered') AS mastered_n, COALESCE(SUM(asks),0) AS asks
       FROM sj_weakpoints WHERE learner=?`,
      [learner]
    );
    const [recent] = await this.pool.query(
      'SELECT question, collection, top_score, created_at FROM sj_questions WHERE learner=? ORDER BY id DESC LIMIT 8',
      [learner]
    );
    return {
      questions: Number(q.n || 0),
      avgScore: q.avg_score == null ? null : Number(Number(q.avg_score).toFixed(4)),
      open: Number(w.open_n || 0),
      mastered: Number(w.mastered_n || 0),
      asks: Number(w.asks || 0),
      recent: recent.map((r) => ({
        question: r.question,
        collection: r.collection,
        score: r.top_score,
        at: r.created_at
      }))
    };
  }
}
