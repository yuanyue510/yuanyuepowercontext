import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { normalizeText, parseSections } from './section.js';
import { splitSentences, mergeShortSentences } from './sentence.js';
import { embedDocuments } from '../embed/local-embedder.js';
import { collectionNameFor } from '../seekdb/naming.js';
import { recreateCollection, upsertRegistry, findDataset } from '../seekdb/collections.js';
import { waitUntilReady } from '../seekdb/ready.js';

const BATCH = 8;

export function buildChunks(text, datasetName) {
  const normalized = normalizeText(text);
  const sections = parseSections(normalized);
  const chunks = [];

  for (const section of sections) {
    mergeShortSentences(splitSentences(normalized, section)).forEach((s, i) => {
      chunks.push({
        text: s.text,
        indexText: `${section.title} ${s.text}`,
        mergedCount: s.mergedCount,
        meta: {
          dataset_id: datasetName,
          dataset_name: datasetName,
          section_id: section.sectionId,
          section_title: section.title,
          section_path: section.breadcrumb,
          sent_no: i + 1,
          merged_count: s.mergedCount,
          char_start: s.charStart,
          char_end: s.charEnd,
          has_formula: /[_^]|[=<>]|\\frac/.test(s.text),
          norm_len: s.text.length,
          plain_text: s.text,
        },
      });
    });
  }
  return { normalized, sections, chunks };
}

/**
 * 导入一份资料：切片 → 本地向量化 → 重建集合并写入 → 就绪门槛 → 登记。
 * 同名资料集重复导入是整体重建（幂等），不会产生重复切片。
 */
export async function importDataset({ datasetName, filename, text }) {
  const { normalized, sections, chunks } = buildChunks(text, datasetName);
  if (chunks.length === 0) throw new Error('没有可入库的句子，请检查文件内容或编码');

  // 先自检再花向量化的钱：offset 是"点证据卡跳原文"的地基，有一条对不上就整批不入库（验收点 B.4）。
  const offsetOk = chunks.every((c) => normalized.slice(c.meta.char_start, c.meta.char_end) === c.text);
  if (!offsetOk) {
    const bad = chunks.findIndex((c) => normalized.slice(c.meta.char_start, c.meta.char_end) !== c.text);
    throw new Error(`切片 offset 自检未通过（第 ${bad + 1} 条起不逐字相等），已中止导入而不是带病入库`);
  }

  const collectionName = collectionNameFor(datasetName);
  const docId = `doc_${createHash('sha1').update(`${datasetName}::${filename}`).digest('hex').slice(0, 10)}`;
  chunks.forEach((c) => {
    c.id = `${docId}#${c.meta.section_id}#${String(c.meta.sent_no).padStart(3, '0')}`;
    c.meta.doc_id = docId;
  });

  // 先登记 importing：就绪门槛没过就中断时，资料集在清单里看得见、状态是 importing，而不是凭空不存在。
  const previous = await findDataset(datasetName);
  await upsertRegistry({ name: datasetName, collectionName, docId, filename, chunkCount: 0, status: 'importing' });

  const t0 = Date.now();
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    embeddings.push(...(await embedDocuments(chunks.slice(i, i + BATCH).map((c) => c.indexText))));
  }
  const embedMs = Date.now() - t0;

  const collection = await recreateCollection(collectionName);
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    await collection.add({
      ids: batch.map((c) => c.id),
      documents: batch.map((c) => c.indexText),
      embeddings: embeddings.slice(i, i + BATCH),
      metadatas: batch.map((c) => c.meta),
    });
  }

  await fs.mkdir(config.paths.normalized, { recursive: true });
  await fs.writeFile(path.join(config.paths.normalized, `${docId}.txt`), normalized, 'utf8');

  // 过不了这道门槛就停在 importing（检索侧会拒绝该资料集），绝不给出"刚导入搜不到"的假象。
  const ready = await waitUntilReady(collection, chunks.length, embeddings[0]);
  await upsertRegistry({
    name: datasetName,
    collectionName,
    docId,
    filename,
    chunkCount: chunks.length,
    status: 'ready',
  });

  const tooShort = chunks.filter(
    (c) => c.mergedCount === 1 && c.text.replace(/[。！？；…]+$/, '').length < config.chunk.minSentenceChars,
  ).length;

  return {
    datasetName,
    collectionName,
    docId,
    filename,
    sectionCount: sections.length,
    chunkCount: chunks.length,
    mergedCount: chunks.filter((c) => c.mergedCount > 1).length,
    residualShort: tooShort,
    offsetOk,
    embedMs,
    readyMs: ready.readyMs,
    readyPolls: ready.polls,
    readyIntervalMs: ready.intervalMs,
    readyTimeoutMs: ready.timeoutMs,
    previousRebuilt: Boolean(previous),
  };
}
