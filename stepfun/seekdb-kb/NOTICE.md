# NOTICE — 第三方组件与模型来源

## 模型

- **bge-small-zh-v1.5**（BERT，4 层 / hidden 512 / 24M 参数，输出 512 维向量）
  - 原始模型：BAAI/bge-small-zh-v1.5，https://huggingface.co/BAAI/bge-small-zh-v1.5 ，
    License: MIT（见 https://huggingface.co/BAAI/bge-small-zh-v1.5/blob/main/LICENSE ）
  - 浏览器端使用的 ONNX 权重：Xenova/bge-small-zh-v1.5（Transformers.js 官方转换版），
    https://huggingface.co/Xenova/bge-small-zh-v1.5 ，
    含 FP32（onnx/model.onnx）、FP16（onnx/model_fp16.onnx）与 INT8 动态量化（onnx/model_quantized.onnx）三份权重
  - 检索时查询侧使用官方建议的指令前缀：「为这个句子生成表示以用于检索相关文章：」

## 运行时

- **@huggingface/transformers 3.7.x**（Transformers.js），Apache-2.0，https://github.com/huggingface/transformers.js
- **onnxruntime-web**（随 Transformers.js 分发，/vendor 路由提供 ort-wasm 二进制），MIT，https://github.com/microsoft/onnxruntime
- **seekdb / seekdb-js 1.4.0**，Apache-2.0，https://github.com/oceanbase/seekdb-js
- **express 4**，MIT，https://github.com/expressjs/express

## 量化说明

INT8 权重采用 optimum/ONNX Runtime 动态量化：per-channel、reduce_range、权重 QInt8，
与 Xenova 仓库内 `quantize_config.json` 一致；复现脚本见 `scripts/quantize_int8.py`。

## 评测集

`public/data/eval.json` 为本项目自建中文客服知识库评测集（48 篇 / 30 问），内容为常见电商/开放平台客服规则的拟真改写，仅用于检索质量评测。
