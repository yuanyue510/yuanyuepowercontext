import mysql from 'mysql2/promise';
import { config } from '../../config.js';

/**
 * 关系表走独立的 mysql2 连接池，不走 seekdb SDK 的 execute()。
 *
 * 原因（node_modules/seekdb/dist/index.mjs:90-99）：SDK 的 execute() 只在语句以
 * SELECT/SHOW/DESCRIBE 开头时返回行，其它一律 `return null`，UPDATE 的 affectedRows 被丢掉了。
 * 而复习状态机必须知道「那条带 WHERE 守卫的 UPDATE 到底改到行没有」，否则并发下会误报成功。
 * seekdb README 对跨向量/关系的事务也是同一个建议：另开一条 mysql2 连接。
 *
 * 顺带的好处：SDK 那边是一条连接 + 会话变量（@search_parm），必须全局串行；
 * 连接池是多条连接，复习列表和状态流转不用排在检索后面。
 * 并发正确性不靠这里，靠 store.js 里那条 UPDATE ... WHERE。
 */
const tenantUser = () => {
  const user = config.seekdb.user;
  return user.includes('@') ? user : `${user}@sys`; // SDK 内部按 user@tenant 连接，这里必须对齐
};

let pool;

export function sqlPool() {
  pool ??= mysql.createPool({
    host: config.seekdb.host,
    port: config.seekdb.port,
    user: tenantUser(),
    password: config.seekdb.password,
    database: config.seekdb.database,
    charset: 'utf8mb4',
    connectionLimit: 4,
    waitForConnections: true,
  });
  return pool;
}

export async function sqlSelect(sql, params = []) {
  const [rows] = await sqlPool().query(sql, params);
  return rows;
}

/** 写语句返回 ResultSetHeader，affectedRows 是「WHERE 命中的行数」，状态机据此判定流转是否生效。 */
export async function sqlWrite(sql, params = []) {
  const [result] = await sqlPool().query(sql, params);
  return { affectedRows: result?.affectedRows ?? 0, changedRows: result?.changedRows ?? 0 };
}

export async function closeSql() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}
