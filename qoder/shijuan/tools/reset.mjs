/**
 * 复位脚本：清掉某个学习者的记忆（提问、薄弱点、复习记录），或删除整个资料集。
 *
 *   node tools/reset.mjs --learner=demo                 # 只清记忆，文档保留
 *   node tools/reset.mjs --learner=demo --collection=期末复习   # 同时删除该资料集（表一起删）
 *   node tools/reset.mjs --all                          # 清空 demo 外所有学习者 + 所有 sj_ 集合
 *
 * 验收样例里用它把环境恢复到初始状态。
 */
import mysql from 'mysql2/promise';
import { CONFIG } from '../server/config.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const LEARNER = args.learner || 'demo';

const conn = await mysql.createConnection({
  host: process.env.SEEKDB_HOST || CONFIG.seekdb.host,
  port: Number(process.env.SEEKDB_PORT || CONFIG.seekdb.port),
  user: process.env.SEEKDB_USER || CONFIG.seekdb.user,
  password: process.env.SEEKDB_PASSWORD ?? CONFIG.seekdb.password,
  database: process.env.SEEKDB_DATABASE || CONFIG.seekdb.database,
  multipleStatements: true
});

if (args.all) {
  await conn.query('DELETE FROM sj_reviews');
  await conn.query('DELETE FROM sj_weakpoints');
  await conn.query('DELETE FROM sj_questions');
  console.log('已清空全部记忆表（sj_questions / sj_weakpoints / sj_reviews）');
} else {
  const [w] = await conn.query(
    'DELETE r FROM sj_reviews r JOIN sj_weakpoints p ON p.id = r.weak_id WHERE p.learner=?',
    [LEARNER]
  );
  const [wp] = await conn.query('DELETE FROM sj_weakpoints WHERE learner=?', [LEARNER]);
  const [q] = await conn.query('DELETE FROM sj_questions WHERE learner=?', [LEARNER]);
  console.log(`学习者 ${LEARNER}：删除薄弱点 ${wp.affectedRows} 条、复习记录 ${w.affectedRows} 条、提问 ${q.affectedRows} 条`);
}

if (args.collection) {
  const label = String(args.collection);
  const [rows] = await conn.query('SELECT slug FROM sj_collections WHERE label=?', [label]);
  if (!rows.length) {
    console.log(`资料集「${label}」未登记，跳过`);
  } else {
    const slug = rows[0].slug;
    const [reg] = await conn.query('SELECT collection_id FROM sdk_collections WHERE collection_name=?', ['sj_' + slug]);
    if (reg.length) {
      await conn.query('DROP TABLE ??', [`c$v2$${reg[0].collection_id}`]);
      await conn.query('DELETE FROM sdk_collections WHERE collection_id=?', [reg[0].collection_id]);
    }
    await conn.query('DELETE FROM sj_collections WHERE label=?', [label]);
    console.log(`已删除资料集「${label}」（物理表 c$v2$${reg[0]?.collection_id || '-'}）`);
  }
}

await conn.end();
