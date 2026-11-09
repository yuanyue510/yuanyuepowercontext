# NOTICE

## 本项目

拾卷 · 学习资料检索与记忆助手
MIT License，见 LICENSE。

## 第三方组件

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| Node.js | 20+ / 实测 22.22.2 | MIT | 运行时 |
| Express | ^4.19.2 | MIT | HTTP 服务 |
| seekdb（JS SDK） | ^1.4.0 | Apache-2.0 | seekdb 集合接口与混合检索 |
| mysql2 | ^3.x | MIT | seekdb 的 SQL 通道（记忆表） |
| @huggingface/transformers | ^3.7.5 | Apache-2.0 | ONNX 推理运行时 |
| onnxruntime-node | 随 transformers 安装 | MIT | CPU 推理后端 |
| OceanBase seekdb | 1.4.0（服务端） | Apache-2.0 | 数据库 |

## 模型

| 模型 | 来源 | 许可 | 说明 |
|---|---|---|---|
| bge-small-zh-v1.5 | BAAI（北京智源人工智能研究院） | MIT | 512 维中文嵌入模型 |
| 浏览器/Node 转换版 | `Xenova/bge-small-zh-v1.5` | 随上游 | 使用其中 `model_quantized.onnx`（INT8 动态量化，23 MB） |
| 分词与配置 | 同上 | 随上游 | config.json / tokenizer.json / tokenizer_config.json / special_tokens_map.json |

模型文件不随仓库提交，由 `npm run fetch-models` 从 hf-mirror 下载。

## 数据

`data/seed/` 下 6 篇学习资料为本项目自行撰写，用于演示检索与记忆链路，未复制他人文档。

## 改动说明

本项目未修改 seekdb、Express、Transformers.js 源码；对第三方库的使用均为常规调用。
