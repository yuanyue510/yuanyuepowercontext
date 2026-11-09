import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.HF_REPO || 'Xenova/bge-small-zh-v1.5';
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx'
];
const DIR = path.join(ROOT, 'models', 'bge-small-zh-v1.5');

// 依次尝试：显式指定 → 国内镜像 → 官方。镜像限流（429）时自动换下一个。
const ENDPOINTS = [
  process.env.HF_ENDPOINT,
  'https://hf-mirror.com',
  'https://huggingface.co'
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithFallback(rel) {
  const errors = [];
  for (const host of ENDPOINTS) {
    const url = `${host}/${REPO}/resolve/main/${rel}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (res.status === 429) {
          errors.push(`${host} 429 限流`);
          break; // 换下一个源，不在限流的源上重试
        }
        if (!res.ok) {
          errors.push(`${host} HTTP ${res.status}`);
          break;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, url };
      } catch (e) {
        errors.push(`${host} ${e.message}`);
        if (attempt < 2) await sleep(1200);
      }
    }
  }
  throw new Error(`全部下载源失败：\n  ${errors.join('\n  ')}`);
}

for (const rel of FILES) {
  const dest = path.join(DIR, rel);
  try {
    const st = await fs.stat(dest);
    if (st.size > 0) {
      console.log(`✓ 已存在 ${rel} (${(st.size / 1048576).toFixed(1)} MB)`);
      continue;
    }
  } catch {}
  process.stdout.write(`→ ${rel} … `);
  try {
    const { buf, url } = await fetchWithFallback(rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    console.log(`完成 ${(buf.length / 1048576).toFixed(1)} MB（${new URL(url).host}）`);
  } catch (e) {
    console.log('失败');
    console.error(e.message);
    console.error('\n可在能联网的机器上手动下载后放到 models/bge-small-zh-v1.5/ 对应子目录。');
    process.exit(1);
  }
}
console.log('模型就绪：models/bge-small-zh-v1.5');
