/**
 * 下载 embedding 模型（FP32 / FP16 / INT8 三份 ONNX）到 public/models/<model>/
 *
 * 默认走 hf-mirror.com（国内可达），可用 HF_ENDPOINT 覆盖：
 *   HF_ENDPOINT=https://huggingface.co node scripts/fetch-models.mjs
 *
 * 只下载推理真正需要的文件，不含训练权重与 svelte 分片。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const ENDPOINT = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/$/, '');
const DEST = path.join(ROOT, 'public', 'models', MODEL_ID.split('/')[1]);

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'quantize_config.json',
  'onnx/model.onnx',          // FP32
  'onnx/model_fp16.onnx',     // FP16（WebGPU 使用）
  'onnx/model_quantized.onnx' // INT8（WASM 使用，optimum 动态量化）
];

async function download(rel) {
  const url = `${ENDPOINT}/${MODEL_ID}/resolve/main/${rel}`;
  const out = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    console.log(`skip  ${rel} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
    return;
  }
  process.stdout.write(`get   ${rel} ... `);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log(`${(buf.length / 1048576).toFixed(1)} MB`);
}

fs.mkdirSync(DEST, { recursive: true });
for (const f of FILES) await download(f);
console.log(`\n模型已就绪: ${DEST}`);
