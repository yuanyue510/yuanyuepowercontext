/**
 * 安装后钩子：校验关键运行时文件是否就位。
 * 浏览器端 transformers.js 与 ORT wasm 直接通过 /vendor 静态路由读取
 * node_modules/@huggingface/transformers/dist，无需复制文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules', '@huggingface/transformers', 'dist');
const need = ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
for (const f of need) {
  if (!fs.existsSync(path.join(dist, f))) {
    console.warn(`[sync-vendor] 缺少 ${f}，请重新执行 npm install`);
  }
}
console.log('[sync-vendor] transformers.js 运行时就绪');
