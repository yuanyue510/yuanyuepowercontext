import { config } from '../server/config.js';
import { sqlSelect, closeSql } from '../server/lib/seekdb/sql.js';

/**
 * 直接查库打印 sh_review 的行，用来做状态流转的「库内前后对照」。
 * 走 mysql2 而不是业务接口，是为了证明改动真的落到 seekdb，不是接口内存里转了一圈。
 * 用法：node scripts/show-review.mjs [id 前缀]
 */
const where = process.argv[2] ? 'WHERE id LIKE ?' : '';
const rows = await sqlSelect(`SELECT * FROM ${config.collection.namespace}review ${where}`, process.argv[2] ? [`${process.argv[2]}%`] : []);
console.table(
  rows.map((r) => ({
    id: r.id,
    status: r.status,
    miss: r.miss_count,
    coverage: r.coverage,
    doc: r.nearest_doc_id,
    first_seen: new Date(Number(r.first_seen)).toLocaleTimeString('zh-CN', { hour12: false }),
    last_seen: new Date(Number(r.last_seen)).toLocaleTimeString('zh-CN', { hour12: false }),
    status_changed_at: r.status_changed_at ? new Date(Number(r.status_changed_at)).toLocaleTimeString('zh-CN', { hour12: false }) : null,
    mastered_at: r.mastered_at ? new Date(Number(r.mastered_at)).toLocaleTimeString('zh-CN', { hour12: false }) : null,
  })),
);
await closeSql();
