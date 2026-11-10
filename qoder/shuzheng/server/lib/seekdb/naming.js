import { createHash } from 'node:crypto';
import { config } from '../../config.js';

/**
 * 中文资料集名 → seekdb 合法集合名（只允许 [a-zA-Z0-9_]）。
 * 中文名本身存在 sh_registry.display_name，用户永远看不到这里的 ASCII 名。
 * 统一 sh_ 前缀：库内还有其它项目的 sj_ 对象，前缀即隔离边界。
 */
export function collectionNameFor(displayName) {
  const stripped = displayName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  // 中文名剥完只剩数字/下划线时没有可读性，退回 doc，唯一性由 hash 保证
  const ascii = (stripped.replace(/[0-9_]/g, '').length >= 2 ? stripped : 'doc').slice(0, 24);
  const hash = createHash('sha1').update(displayName).digest('hex').slice(0, 8);
  const name = `${config.collection.prefix}${ascii}_${hash}`;
  assertOwnCollection(name);
  return name;
}

export function assertOwnCollection(name) {
  if (typeof name !== 'string' || !name.startsWith(config.collection.namespace)) {
    throw new Error(`集合名必须以 ${config.collection.namespace} 开头，拒绝操作: ${String(name)}`);
  }
  if (!config.collection.namePattern.test(name)) {
    throw new Error(`集合名含非法字符: ${name}`);
  }
  return name;
}
