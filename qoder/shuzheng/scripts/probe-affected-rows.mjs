// 一次性探针（评审可跳过）：seekdb 的 execute() 对非 SELECT 一律返回 null，拿不到 affectedRows。
// 这里验证「另开一条 mysql2 连接」这条路能否拿到匹配行数 —— seekdb README 对跨向量/关系的写法也推荐这条路。
// 只跑 WHERE 不命中的零影响语句：不建表、不 DROP、不改任何数据。
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({
  host: process.env.SEEKDB_HOST,
  port: Number(process.env.SEEKDB_PORT),
  user: `${process.env.SEEKDB_USER}@sys`, // seekdb 内部按 user@tenant 连接，这里必须对齐
  password: process.env.SEEKDB_PASSWORD ?? '',
  database: process.env.SEEKDB_DATABASE,
  charset: 'utf8mb4',
});
const [r] = await conn.query('UPDATE sh_registry SET status=status WHERE name=?', ['__definitely_absent__']);
console.log('UPDATE 不命中 ->', JSON.stringify({ affectedRows: r.affectedRows, changedRows: r.changedRows, constructor: r.constructor.name }));
const [rows] = await conn.query('SELECT name, status, chunk_count FROM sh_registry');
console.log('SELECT ->', JSON.stringify(rows));
await conn.end();
