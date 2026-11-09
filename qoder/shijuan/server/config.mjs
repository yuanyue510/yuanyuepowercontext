/**
 * 配置：全部来自环境变量，默认值面向本机开发。
 */
export const CONFIG = {
  port: Number(process.env.PORT || 8790),
  seekdb: {
    host: process.env.SEEKDB_HOST || '127.0.0.1',
    port: Number(process.env.SEEKDB_PORT || 2881),
    user: process.env.SEEKDB_USER || 'root',
    password: process.env.SEEKDB_PASSWORD || '',
    database: process.env.SEEKDB_DATABASE || 'shijuan'
  },
  embed: {
    // 本地模型目录（相对项目根），首次使用 npm run fetch-models 下载
    modelDir: process.env.EMBED_MODEL_DIR || 'models',
    modelName: process.env.EMBED_MODEL_NAME || 'bge-small-zh-v1.5',
    dtype: process.env.EMBED_DTYPE || 'q8',
    dimension: 512,
    // bge 中文检索官方建议的查询侧指令前缀
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    batchSize: Number(process.env.EMBED_BATCH || 8)
  },
  chunk: { size: 320, overlap: 60 },
  // 混合检索参数（RRF 融合在 seekdb 内完成）
  search: { rankWindowSize: 40, rankConstant: 60 },
  // 低于该相似度视为「资料没讲到」，触发薄弱点候选
  weakThreshold: Number(process.env.WEAK_THRESHOLD || 0.55)
};
