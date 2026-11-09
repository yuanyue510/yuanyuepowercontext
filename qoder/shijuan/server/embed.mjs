import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import { CONFIG } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 本地向量化：bge-small-zh-v1.5（INT8 量化，512 维）。
 * 模型文件由 scripts/fetch-models.mjs 下载到 models/ 下，推理在 Node 进程内完成，
 * 不调用任何云端 embedding 接口。
 */
export class Embedder {
  constructor(cfg = CONFIG.embed) {
    this.cfg = cfg;
    this.extractor = null;
    this.ready = false;
    this.loadMs = null;
  }

  async init() {
    if (this.ready) return this;
    env.allowRemoteModels = false;
    env.localModelPath = path.join(ROOT, this.cfg.modelDir) + path.sep;
    const t0 = performance.now();
    this.extractor = await pipeline('feature-extraction', this.cfg.modelName, { dtype: this.cfg.dtype });
    // 预热一次，避免首条请求承担图初始化开销
    await this.extractor(['预热'], { pooling: 'cls', normalize: true });
    this.loadMs = Math.round(performance.now() - t0);
    this.ready = true;
    return this;
  }

  async embed(texts, { query = false } = {}) {
    await this.init();
    const input = query
      ? texts.map((t) => this.cfg.queryPrefix + t)
      : texts;
    const out = [];
    for (let i = 0; i < input.length; i += this.cfg.batchSize) {
      const batch = input.slice(i, i + this.cfg.batchSize);
      const res = await this.extractor(batch, { pooling: 'cls', normalize: true });
      const dim = res.dims[1];
      for (let r = 0; r < batch.length; r++) {
        out.push(Array.from(res.data.slice(r * dim, (r + 1) * dim)));
      }
    }
    return out;
  }

  async embedOne(text, opts) {
    const [v] = await this.embed([text], opts);
    return v;
  }
}
