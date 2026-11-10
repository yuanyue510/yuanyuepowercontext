import { setTimeout as sleep } from 'node:timers/promises';

/**
 * 就绪门槛：写入完成 ≠ 可检索。实测向量通道有秒级可见性延迟，
 * 所以轮询读数（每 200ms），连续 2 次读数相同且 >= 期望条数才放行，上限 10s。
 * 读数取 min(表行数, 向量通道可召回条数)——后者才是真正滞后的那个信号，
 * 用固定 sleep 在别人机器上要么不够、要么白等。
 */
export async function waitUntilReady(collection, expected, probeEmbedding, { intervalMs = 200, timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  let previous = -1;
  let polls = 0;

  while (Date.now() - started <= timeoutMs) {
    polls += 1;
    const [rows, vectorVisible] = await Promise.all([
      collection.count(),
      collection.query({ queryEmbeddings: [probeEmbedding], nResults: expected, include: ['metadatas'] }).then((r) => r.ids?.flat()?.length ?? 0),
    ]);
    const reading = Math.min(rows, vectorVisible);
    console.log(`[ready] 第 ${polls} 次探测：表行数 ${rows}，向量通道可召回 ${vectorVisible} → 读数 ${reading}（期望 ${expected}，上一次 ${previous}）`);

    if (reading >= expected && reading === previous) {
      return { readyMs: Date.now() - started, reading, expected, polls, intervalMs, timeoutMs };
    }
    previous = reading;
    await sleep(intervalMs);
  }

  throw new Error(`集合未就绪：实际 count=${previous}，期望 ${expected} 条（已轮询 ${polls} 次 / 上限 ${timeoutMs} ms）`);
}
