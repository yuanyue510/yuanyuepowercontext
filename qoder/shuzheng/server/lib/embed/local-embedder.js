import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { config } from '../../config.js';

// 离线三件套：禁止远程模型、禁止远端文件缓存，模型只从仓库内 models/ 目录读。
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = path.dirname(config.embedding.modelDir);

const MODEL_ID = path.basename(config.embedding.modelDir);

let extractor;

export async function initEmbedder() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
  }
  return extractor;
}

// bge-zh-v1.5 官方建议：查询侧加指令前缀，文档侧不加。
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

async function encode(texts) {
  const extract = await initEmbedder();
  const out = [];
  for (const text of texts) {
    const res = await extract(text, { pooling: 'mean', normalize: true });
    out.push(Array.from(res.data));
  }
  return out;
}

export async function embedDocuments(texts) {
  return encode(texts);
}

export async function embedQuery(text) {
  const [vec] = await encode([QUERY_INSTRUCTION + text]);
  return vec;
}

export const EMBEDDING_META = {
  modelId: MODEL_ID,
  dimension: config.embedding.dimension,
  queryInstruction: QUERY_INSTRUCTION,
  source: path.relative(config.root, config.embedding.modelDir),
};
