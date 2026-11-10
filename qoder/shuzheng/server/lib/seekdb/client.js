import { SeekdbClient } from 'seekdb';
import { config } from '../../config.js';

let client;

export function getClient() {
  if (!client) {
    client = new SeekdbClient({
      host: config.seekdb.host,
      port: config.seekdb.port,
      user: config.seekdb.user,
      password: config.seekdb.password,
      database: config.seekdb.database,
    });
  }
  return client;
}

/** 服务端会把空闲连接掐掉，SDK v1.4 不自愈（docs/TECHNICAL.md 事实 24），只能自己认出来。 */
const DEAD = /closed state|can't add new command|PROTOCOL_CONNECTION_LOST|ECONNRESET|connection lost/i;

function resetClient() {
  const stale = client;
  client = undefined;
  try {
    stale?.close?.()?.catch?.(() => {});
  } catch {
    // 连接已经死了，close() 本身报错不用管
  }
}

/**
 * 只在「死连接」这一类错误上重试一次，先把单例丢掉。
 * 重试点选在打开集合 / 原生 SQL 这类写入之前的动作上：重跑没有副作用；
 * 写到一半才断的情况留给下一个请求自愈，不重复写。
 */
export async function withReconnect(action) {
  try {
    return await action();
  } catch (err) {
    if (!DEAD.test(err?.message ?? '')) throw err;
    resetClient();
    return action();
  }
}

/**
 * 打开已有集合。必须显式传 embeddingFunction:null —— 否则 SDK 会按库内元数据
 * 去 import('@seekdb/default-embed') 并抛 "not registered"（本项目不装任何向量化插件）。
 */
export async function openCollection(name) {
  return withReconnect(() => getClient().getCollection({ name, embeddingFunction: null }));
}

export async function execute(sql, params = []) {
  return withReconnect(() => getClient().execute(sql, params));
}

/**
 * 串行执行一段 seekdb 操作。
 * v1.4 的 hybridSearch = 「SET @search_parm → 读回 query_sql → 执行」，依赖一条连接上的会话变量，
 * 并发调用会互相覆盖参数；导入又会重建集合。所以检索与入库统一排队，宁可慢也不要给出错的结果。
 */
let queue = Promise.resolve();

export function exclusive(task) {
  const result = queue.then(task);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}
