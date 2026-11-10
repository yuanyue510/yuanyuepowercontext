import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  http: {
    port: Number(process.env.PORT || 8790),
  },
  seekdb: {
    host: process.env.SEEKDB_HOST || '127.0.0.1',
    port: Number(process.env.SEEKDB_PORT || 2881),
    user: process.env.SEEKDB_USER || 'root',
    password: process.env.SEEKDB_PASSWORD || '',
    database: process.env.SEEKDB_DATABASE || 'test',
  },
  embedding: {
    modelDir: path.join(root, 'models', 'bge-small-zh-v1.5'),
    modelFile: path.join(root, 'models', 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx'),
    tokenizerFile: path.join(root, 'models', 'bge-small-zh-v1.5', 'tokenizer.json'),
    dimension: 512,
    maxLength: 512,
  },
  collection: {
    // 共享库 shijuan 里已有其他项目的 sj_ 前缀表，本项目一律 sh_ 开头，且不得 DROP 非本项目对象
    namespace: 'sh_',
    prefix: 'sh_ds_',
    namePattern: /^[a-zA-Z0-9_]+$/,
    fulltextParser: 'ngram2',
    minNgramSize: 2,
    maxNgramSize: 3,
    defaultNResults: 8,
  },
  chunk: {
    minSentenceChars: 15,
    contextWindow: 2,
  },
  paths: {
    uploads: path.join(root, 'data', 'uploads'),
    normalized: path.join(root, 'data', 'normalized'),
    exports: path.join(root, 'data', 'exports'),
    public: path.join(root, 'public'),
  },
};
