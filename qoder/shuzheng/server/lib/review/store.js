import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { sqlSelect, sqlWrite } from '../seekdb/sql.js';

const TABLE = `${config.collection.namespace}review`; // sh_review

export const REVIEW_STATES = ['open', 'reviewing', 'mastered'];

/**
 * 状态机唯一的合法边。开放题「回退到 open」允许从 reviewing / mastered 两个态回来，
 * 但 mastered 不能直接跳回 reviewing —— 想重看就走 open，队列里才会重新出现。
 */
const TRANSITIONS = {
  open: ['reviewing'],
  reviewing: ['mastered', 'open'],
  mastered: ['open'],
};

const clip = (s, n) => String(s ?? '').slice(0, n);

/**
 * 卡点身份 = (资料集, 原问题)。同一个问题再被判未覆盖一次，就应该在同一条队列项上 +1 次错，
 * 而不是又多一行。所以 id 是这两者的确定性哈希，跟时间无关。
 */
export function reviewIdFor(datasetName, questionText) {
  return `rv_${createHash('sha1').update(`${datasetName}::${questionText}`).digest('hex').slice(0, 16)}`;
}

export async function ensureReviewTable() {
  await sqlWrite(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id VARCHAR(64) PRIMARY KEY,
       dataset_name VARCHAR(200) NOT NULL,
       question_text VARCHAR(500) NOT NULL,
       concept VARCHAR(300),
       coverage DOUBLE,
       missed_terms VARCHAR(300),
       nearest_doc_id VARCHAR(100),
       latest_stuck_id VARCHAR(64),
       status VARCHAR(32) NOT NULL,
       miss_count INT NOT NULL,
       first_seen BIGINT NOT NULL,
       last_seen BIGINT NOT NULL,
       status_changed_at BIGINT,
       mastered_at BIGINT
     )`,
  );
}

let tablePromise = null;

/** 建表语句本身幂等（IF NOT EXISTS，绝不 DROP）；进程内只跑一次，失败不留缓存，seekdb 后起来也能自愈。 */
function tableReady() {
  tablePromise ??= ensureReviewTable().catch((err) => {
    tablePromise = null;
    throw err;
  });
  return tablePromise;
}

/**
 * 拒答落队列：首次 INSERT，重复命中同一 (dataset, question) 就 miss_count+1 并退回 open。
 * 用一条 INSERT ... ON DUPLICATE KEY UPDATE 完成，不给"先查再插"留竞态窗口。
 */
export async function recordStuck({ datasetName, questionText, concept, coverage, missedTerms, nearestDocId, stuckId }) {
  await tableReady();
  const now = Date.now();
  const id = reviewIdFor(datasetName, questionText);
  await sqlWrite(
    `INSERT INTO ${TABLE}
       (id, dataset_name, question_text, concept, coverage, missed_terms, nearest_doc_id, latest_stuck_id,
        status, miss_count, first_seen, last_seen, status_changed_at, mastered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       miss_count = miss_count + 1,
       last_seen = VALUES(last_seen),
       concept = VALUES(concept),
       coverage = VALUES(coverage),
       missed_terms = VALUES(missed_terms),
       nearest_doc_id = VALUES(nearest_doc_id),
       latest_stuck_id = VALUES(latest_stuck_id),
       status = 'open',
       status_changed_at = VALUES(status_changed_at),
       mastered_at = NULL`,
    [
      id,
      clip(datasetName, 200),
      clip(questionText, 500),
      clip(concept, 300),
      coverage,
      clip(missedTerms, 300),
      clip(nearestDocId, 100),
      clip(stuckId, 64),
      now,
      now,
      now,
    ],
  );
  return { id, status: 'open' };
}

const toRow = (r) => ({
  id: r.id,
  allowed: TRANSITIONS[r.status] ?? [], // 前端据此置灰非法按钮，规则只在服务端这一份
  datasetName: r.dataset_name,
  questionText: r.question_text,
  concept: r.concept,
  coverage: r.coverage == null ? null : Number(r.coverage),
  missedTerms: r.missed_terms,
  nearestDocId: r.nearest_doc_id,
  latestStuckId: r.latest_stuck_id,
  status: r.status,
  missCount: Number(r.miss_count),
  firstSeen: Number(r.first_seen),
  lastSeen: Number(r.last_seen),
  statusChangedAt: r.status_changed_at == null ? null : Number(r.status_changed_at),
  masteredAt: r.mastered_at == null ? null : Number(r.mastered_at),
});

/** 待复习队列：open + reviewing，错得多的先看，错得一样久没碰的先看。 */
export async function listPending({ dataset, limit = 50 } = {}) {
  await tableReady();
  const where = ["status IN ('open','reviewing')"];
  const params = [];
  if (dataset) {
    where.push('dataset_name = ?');
    params.push(dataset);
  }
  params.push(limit);
  const rows = await sqlSelect(
    `SELECT * FROM ${TABLE} WHERE ${where.join(' AND ')}
      ORDER BY miss_count DESC, last_seen ASC
      LIMIT ?`,
    params,
  );

  const counts = {};
  for (const r of await sqlSelect(`SELECT status, COUNT(*) AS n FROM ${TABLE} GROUP BY status`)) {
    counts[r.status] = Number(r.n);
  }
  return { table: TABLE, dataset: dataset ?? null, limit, pending: rows.map(toRow), counts };
}

/**
 * 状态流转 = 一条带前驱守卫的 UPDATE。
 * 并发安全来自数据库本身：两个人同时点「已掌握」，只有一条连接能匹配到 status='reviewing'，
 * 另一条执行时该行已是 mastered，WHERE 不成立 → affectedRows=0 → 路由返回 409，不会双双报成功。
 * 因此绝不能先 SELECT 判断再 UPDATE（那才是竞态）。affectedRows 就是本次流转的裁决。
 */
export async function transition(id, target) {
  await tableReady();
  if (!REVIEW_STATES.includes(target)) throw new Error(`未知状态：${target}（只支持 ${REVIEW_STATES.join('/')}）`);

  // 前驱集合从 TRANSITIONS 反查，状态表改了这里不用跟着改。
  const predecessors = Object.entries(TRANSITIONS)
    .filter(([, next]) => next.includes(target))
    .map(([from]) => from);
  const params = [target, Date.now(), target === 'mastered' ? Date.now() : null, id, ...predecessors];

  const { affectedRows } = await sqlWrite(
    `UPDATE ${TABLE}
        SET status = ?, status_changed_at = ?, mastered_at = ?
      WHERE id = ? AND status IN (${predecessors.map(() => '?').join(',')})`,
    params,
  );

  if (affectedRows > 0) {
    const [row] = await sqlSelect(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
    return { ok: true, id, applied: true, row: toRow(row) };
  }

  // 走到这里说明守卫没放行。之后这次 SELECT 只用于给报错文案，不参与裁决，不影响并发正确性。
  const [current] = await sqlSelect(`SELECT status FROM ${TABLE} WHERE id = ?`, [id]);
  if (!current) return { ok: false, applied: false, reason: 'not_found', id };
  return {
    ok: false,
    applied: false,
    reason: 'conflict',
    id,
    from: current.status,
    to: target,
    allowed: TRANSITIONS[current.status] ?? [],
  };
}
