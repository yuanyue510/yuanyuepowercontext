# NOTICE

## 本项目

**书证 · 教材口径复习助手**
MIT License，见 `LICENSE`。

## 第三方组件

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| Node.js | ≥ 20（实测 22） | MIT | 运行时 |
| Express | ^4.21.2 | MIT | HTTP 服务与静态资源 |
| seekdb（JS SDK） | ^1.4.0 | Apache-2.0 | 集合创建、混合检索、SQL 通道 |
| mysql2 | ^3.11.5 | MIT | 直连 seekdb 查库核对（验收脚本用） |
| @huggingface/transformers | ^3.5.1 | Apache-2.0 | ONNX 推理运行时（含 onnxruntime-node） |
| OceanBase seekdb | 1.4.0（服务端） | Apache-2.0 | 数据库 |

## 模型

| 模型 | 来源 | 许可 | 说明 |
|---|---|---|---|
| bge-small-zh-v1.5 | BAAI（北京智源人工智能研究院） | MIT | 512 维中文嵌入模型 |
| 量化版 ONNX | `Xenova/bge-small-zh-v1.5` 转换权重 | 随上游（MIT） | `model_quantized.onnx`，INT8 动态量化，约 24 MB，随仓库提交以保证离线可跑 |
| 分词与配置 | 同上 | 随上游 | `config.json` / `tokenizer.json` / `tokenizer_config.json` / `special_tokens_map.json` |

## 数据

- `eval/corpus/` 下的两篇讲义（物理必修1-动力学、生物必修1-细胞代谢）为本项目自行撰写，
  用于演示导入、检索、拒答与卡点闭环，**未复制任何教材或他人文档的原文**。
- `data/` 目录是导入后生成的规范化文本，属运行产物，已加入 `.gitignore`，不入库。

## 合规说明

- 全流程**不调用**任何云端大模型或 embedding 接口，不需要 API Key，无出网请求。
- 向量化由本地 ONNX 模型在 Node 进程内完成；`.npmrc` 里 `legacy-peer-deps=true` 的一个副作用，
  正是让 seekdb 的 `@seekdb/default-embed`（云端向量化插件）不会被安装 —— 这是刻意的。
- 未修改 seekdb、Express、Transformers.js 的源码，对第三方库均为常规调用。

## 素材

Qoder 界面截图（`docs/qoder/`）由开发者本人在 Qoder 桌面端截取，仅用于赛事开发记录。
`docs/qoder/00-account-uid.png` 含账号名与阿里云账号 ID，**已加入 `.gitignore` 不入库**，
只随提交附件提供。
