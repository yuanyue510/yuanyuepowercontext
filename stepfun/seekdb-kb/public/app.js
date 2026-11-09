import { pipeline, env } from '/vendor/transformers.min.js';

/* ============================== 配置 ============================== */
const MODEL_DIR = 'bge-small-zh-v1.5';
const MODEL_LABEL = 'Xenova/bge-small-zh-v1.5';
const DIM = 512;
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'; // BGE-zh 官方检索指令
const DOC_FILES = {
  fp32: 'onnx/model.onnx',
  fp16: 'onnx/model_fp16.onnx',
  q8: 'onnx/model_quantized.onnx'
};

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = '/vendor/';
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
env.backends.onnx.wasm.proxy = false;

const params = new URLSearchParams(location.search);
const FORCE_WASM = params.get('forceWasm') === '1';

/* ============================== 状态 ============================== */
const state = {
  backend: { device: null, dtype: null, reason: '' },
  model: null,
  modelLoadMs: 0,
  collections: [],
  current: null,
  mode: 'hybrid',
  timings: {},
  busy: false,
  modelSizes: {}
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const now = () => performance.now();
const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(d));

/* ============================== 日志 ============================== */
const logEl = $('#log');
function log(msg, kind = 'info') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${t}] ${msg}`;
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
  (kind === 'err' ? console.error : console.log)(msg);
}
function toast(msg, ms = 2200) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ============================== 后端探测 ============================== */
async function detectBackend() {
  if (FORCE_WASM) return { device: 'wasm', dtype: 'q8', reason: 'URL 参数 forceWasm=1 强制降级' };
  if (!('gpu' in navigator)) return { device: 'wasm', dtype: 'q8', reason: '浏览器未提供 navigator.gpu' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { device: 'wasm', dtype: 'q8', reason: 'requestAdapter() 返回 null（无可用 GPU）' };
    const hasF16 = adapter.features?.has?.('shader-f16');
    return { device: 'webgpu', dtype: hasF16 ? 'fp16' : 'fp32', reason: hasF16 ? 'WebGPU + shader-f16' : 'WebGPU（无 f16，用 fp32）' };
  } catch (e) {
    return { device: 'wasm', dtype: 'q8', reason: `WebGPU 探测异常：${e.message}` };
  }
}

function renderBackend() {
  const b = state.backend;
  const el = $('#badgeBackend');
  el.className = 'badge ' + (b.device === 'webgpu' ? 'gpu' : 'wasm');
  el.textContent = b.device === 'webgpu' ? `WebGPU · ${b.dtype.toUpperCase()}` : `WASM · ${b.dtype.toUpperCase()}`;
  el.title = b.reason + (b.device === 'wasm' ? '（已自动降级，核心流程仍可用）' : '');
  $('#badgeModel').textContent = `${MODEL_LABEL} · ${DIM}d`;
  renderDiag();
}

/* ============================== 模型 ============================== */
async function loadModel(device, dtype, onProgress) {
  const t0 = now();
  const pipe = await pipeline('feature-extraction', MODEL_DIR, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file && onProgress) onProgress(p);
    }
  });
  return { pipe, ms: now() - t0 };
}

async function ensureModel() {
  if (state.model) return state.model;
  const det = await detectBackend();
  state.backend = det;
  renderBackend();
  log(`后端选择：${det.device} / ${det.dtype}（${det.reason}）`);
  try {
    const { pipe, ms } = await loadModel(det.device, det.dtype, (p) => {
      $('#badgeModel').textContent = `加载 ${p.file} ${Math.round(p.progress || 0)}%`;
    });
    state.model = pipe;
    state.modelLoadMs = ms;
    log(`模型加载完成：${Math.round(ms)} ms（${det.device}/${det.dtype}）`);
    // WebGPU 初始化失败会在这里抛错，自动降级到 WASM/INT8
  } catch (e) {
    if (det.device === 'webgpu') {
      log(`WebGPU 初始化失败：${e.message}，自动降级到 WASM`, 'err');
      state.backend = { device: 'wasm', dtype: 'q8', reason: 'WebGPU 初始化失败，自动降级' };
      renderBackend();
      const { pipe, ms } = await loadModel('wasm', 'q8', (p) => {
        $('#badgeModel').textContent = `加载 ${p.file} ${Math.round(p.progress || 0)}%`;
      });
      state.model = pipe;
      state.modelLoadMs = ms;
    } else throw e;
  }
  $('#badgeModel').textContent = `${MODEL_LABEL} · ${DIM}d`;
  renderBackend();
  // 预热：第一次推理包含 kernel 编译/内存分配，单独剔除，不计入吞吐
  try {
    const t = now();
    await state.model(['预热文本 warmup'], { pooling: 'cls', normalize: true });
    state.warmupMs = now() - t;
    log(`模型预热完成：${Math.round(state.warmupMs)} ms`);
  } catch (e) { log('预热失败：' + e.message, 'err'); }
  await measureModelSizes();
  window.__modelReady = true;
  return state.model;
}

/** 用 HTTP HEAD 读取三份模型的实际字节数，计算压缩比 */
async function measureModelSizes() {
  const out = {};
  for (const [k, rel] of Object.entries(DOC_FILES)) {
    try {
      const r = await fetch(`/models/${MODEL_DIR}/${rel}`, { method: 'HEAD' });
      const len = Number(r.headers.get('content-length') || 0);
      if (len) out[k] = len;
    } catch { /* ignore */ }
  }
  state.modelSizes = out;
  const rows = [];
  const base = out.fp32;
  const nameMap = { fp32: 'FP32（基线）', fp16: 'FP16', q8: 'INT8 动态量化' };
  for (const k of ['fp32', 'fp16', 'q8']) {
    if (!out[k]) continue;
    const mb = out[k] / 1048576;
    const ratio = base ? (base / out[k]).toFixed(2) + '×' : '—';
    rows.push(`<tr><td>${nameMap[k]}</td><td class="num">${mb.toFixed(1)} MB</td><td class="num">${k === 'fp32' ? '—' : ratio}</td></tr>`);
  }
  $('#sizeTable').innerHTML = `<thead><tr><th>精度</th><th class="num">体积</th><th class="num">压缩比</th></tr></thead><tbody>${rows.join('')}</tbody>`;
}

/* ============================== 向量化 ============================== */
async function embed(texts, { isQuery = false, batchSize = 16, onProgress } = {}) {
  const model = await ensureModel();
  const prepared = isQuery ? texts.map((t) => QUERY_PREFIX + t) : texts;
  const vectors = [];
  const t0 = now();
  for (let i = 0; i < prepared.length; i += batchSize) {
    const batch = prepared.slice(i, i + batchSize);
    const out = await model(batch, { pooling: 'cls', normalize: true });
    const [n, d] = out.dims;
    for (let r = 0; r < n; r++) vectors.push(Array.from(out.data.slice(r * d, (r + 1) * d)));
    if (onProgress) onProgress(Math.min(i + batch.length, prepared.length), prepared.length);
  }
  return { vectors, ms: now() - t0 };
}

/* ============================== 切片 ============================== */
function chunkText(text, size = 320, overlap = 60) {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units = [];
  for (const p of paras) {
    if (p.length <= size) { units.push(p); continue; }
    const sents = p.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [p];
    let buf = '';
    for (const s of sents) {
      if ((buf + s).length > size && buf) { units.push(buf.trim()); buf = buf.slice(Math.max(0, buf.length - overlap)) + s; }
      else buf += s;
    }
    if (buf.trim()) units.push(buf.trim());
  }
  const out = [];
  let buf = '';
  for (const u of units) {
    if ((buf + '\n' + u).length > size && buf) { out.push(buf.trim()); buf = buf.slice(Math.max(0, buf.length - overlap)) + '\n' + u; }
    else buf = buf ? buf + '\n' + u : u;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((c) => c.length > 8);
}

/* ============================== API ============================== */
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ ok: false, error: 'invalid json' }));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ============================== 知识库 ============================== */
async function loadCollections() {
  const { collections } = await api('/api/collections');
  state.collections = collections;
  if (state.current && !collections.some((c) => c.name === state.current)) state.current = null;
  if (!state.current && collections.length) state.current = localStorage.getItem('kb.current') || collections[0].name;
  renderKbList();
  if (state.current) await selectKb(state.current, { silent: true });
  else renderDiag();
}

function renderKbList() {
  const el = $('#kbList');
  if (!state.collections.length) {
    el.innerHTML = `<div class="dim small" style="padding:6px 2px">还没有知识库，点右上角 + 新建，或直接导入语料自动创建。</div>`;
    return;
  }
  el.innerHTML = state.collections
    .map((c) => `<div class="kb ${c.name === state.current ? 'active' : ''}" data-name="${c.name}">
      <div><div class="kb-name">${c.name}</div><div class="kb-sub">${c.count} 条 · ${c.dimension}d</div></div>
      <span class="pill">${c.name === state.current ? '当前' : ''}</span>
    </div>`)
    .join('');
  el.querySelectorAll('.kb').forEach((n) => n.addEventListener('click', () => selectKb(n.dataset.name)));
}

async function selectKb(name, { silent = false } = {}) {
  state.current = name;
  localStorage.setItem('kb.current', name);
  renderKbList();
  const stats = await api(`/api/collections/${name}/stats`);
  state.stats = stats.stats;
  if (!silent) { $('#results').innerHTML = emptyResults(); $('#resultMeta').textContent = ''; }
  renderDiag();
  renderData();
  log(`切换到集合 ${name}（${stats.stats.count} 条，${stats.stats.dimension}d）`);
}

async function createKb(name) {
  const r = await api('/api/collections', { method: 'POST', body: JSON.stringify({ name, dimension: DIM }) });
  log(`集合 ${name} ${r.collection.created ? '已创建' : '已存在'}（${DIM}d，ngram2 全文 + HNSW 向量）`);
  await loadCollections();
  await selectKb(name);
}

/* ============================== 导入 ============================== */
const importState = { running: false };

async function ingestTexts(docs) {
  // docs: [{name, text}]
  if (!state.current) {
    const auto = 'kb' + new Date().toISOString().slice(5, 19).replace(/[-:T]/g, '');
    await createKb(auto);
    toast(`已自动创建知识库 ${auto}`);
  }
  const batchSize = Number($('#selBatch').value);
  const chunkSize = Number($('#selChunk').value);
  const overlap = 60;

  const items = [];
  for (const d of docs) {
    const chunks = chunkText(d.text, chunkSize, overlap);
    const base = d.name.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40);
    chunks.forEach((text, i) => items.push({
      id: `${base}-${i}-${hash(text).toString(36)}`,
      text,
      metadata: { source: d.name, chunk: i, chars: text.length }
    }));
    log(`切片 ${d.name}：${d.text.length} 字 → ${chunks.length} 段（${chunks.map((c) => c.length).join('/')} 字）`);
  }
  if (!items.length) { toast('没有可用文本'); return; }

  $('#ingestProgress').hidden = false;
  const t = state.timings;
  t.ingest = { chunks: items.length, batchSize };

  // 1. 向量化
  setProgress(0, `向量化 0/${items.length}`);
  const tEmbed0 = now();
  const e = await embed(items.map((x) => x.text), {
    batchSize,
    onProgress: (done, total) => setProgress((done / total) * 0.75, `向量化 ${done}/${total}`, `${(done / ((now() - tEmbed0) / 1000)).toFixed(1)} 段/s`)
  });
  t.docEmbedMs = e.ms;
  t.docEmbedCount = items.length;
  log(`向量化完成：${items.length} 段 / ${Math.round(e.ms)} ms（${(items.length / (e.ms / 1000)).toFixed(1)} 段/s，batch=${batchSize}）`);

  // 2. 写入 seekdb（每 64 条一批），最后统一 refresh
  const chunksPerWrite = 64;
  let writeMs = 0, refreshMs = 0;
  for (let i = 0; i < items.length; i += chunksPerWrite) {
    const slice = items.slice(i, i + chunksPerWrite);
    const payload = {
      items: slice.map((x, j) => ({ id: x.id, text: x.text, metadata: x.metadata, embedding: e.vectors[i + j] })),
      refresh: false
    };
    const r = await api(`/api/collections/${state.current}/docs`, { method: 'POST', body: JSON.stringify(payload) });
    writeMs += r.writeMs;
    setProgress(0.75 + (Math.min(i + chunksPerWrite, items.length) / items.length) * 0.2, `写入 seekdb ${Math.min(i + chunksPerWrite, items.length)}/${items.length}`);
  }
  // 3. 刷新索引
  setProgress(0.96, '刷新向量与全文索引…');
  const rf = await api(`/api/collections/${state.current}/refresh`, { method: 'POST' });
  refreshMs = rf.refreshMs;
  t.writeMs = writeMs;
  t.refreshMs = refreshMs;

  // 4. 验证新增内容可检索
  const probe = items[items.length - 1];
  const probeVec = e.vectors[items.length - 1];
  const vr = await api(`/api/collections/${state.current}/search`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'vector', queryText: probe.text.slice(0, 40), embedding: probeVec, k: 3 })
  });
  const hit = vr.result.hits.some((h) => h.id === probe.id);

  setProgress(1, '完成');
  t.ingestTotalMs = e.ms + writeMs + refreshMs;
  log(`写入 ${items.length} 条：write ${Math.round(writeMs)} ms，refresh ${Math.round(refreshMs)} ms；刷新后校验${hit ? '通过（新增片段已命中 top3）' : '未命中 top3，请检查索引'}`);
  $('#importLog').textContent = `本次导入 ${items.length} 段 · 向量化 ${Math.round(e.ms)} ms · 写入 ${Math.round(writeMs)} ms · 索引刷新 ${Math.round(refreshMs)} ms\n刷新后校验：${hit ? '✓ 新增片段可检索' : '✗ 未命中'}`;
  toast(hit ? `导入完成，${items.length} 段已可检索` : '导入完成，但校验未命中');

  await api(`/api/collections/${state.current}/stats`).then((r) => { state.stats = r.stats; });
  await loadCollections();
  renderDiag();
  renderData();
  setTimeout(() => { $('#ingestProgress').hidden = true; }, 1200);
}

function setProgress(p, stage, stat = '') {
  $('#ingestBar').style.width = `${Math.min(100, p * 100).toFixed(1)}%`;
  if (stage) $('#ingestStage').textContent = stage;
  $('#ingestStat').textContent = stat;
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return Math.abs(h); }

async function ingestFiles(files) {
  if (importState.running) return toast('正在导入，请稍候');
  importState.running = true;
  state.timings._start = 0;
  $('#importLog').textContent = '';
  try {
    await ensureModel();
    const docs = [];
    for (const f of files) {
      const text = await f.text();
      docs.push({ name: f.name, text });
    }
    await ingestTexts(docs);
  } catch (e) {
    log(`导入失败：${e.message}`, 'err');
    toast('导入失败：' + e.message);
    $('#ingestProgress').hidden = true;
  } finally {
    importState.running = false;
  }
}

/* ============================== 检索 ============================== */
function emptyResults() {
  return `<div class="empty"><div class="empty-icon">⌕</div><p>导入几篇文档后，输入问题即可检索。</p>
  <p class="dim">文档在本机完成向量化，向量与原文写入 seekdb，检索由 seekdb 的 DBMS_HYBRID_SEARCH 完成。</p></div>`;
}

async function doSearch(q) {
  if (!q.trim()) return;
  if (!state.current) return toast('请先导入文档或选择知识库');
  const t0 = now();
  $('#btnSearch').disabled = true;
  try {
    const em = await embed([q], { isQuery: true, batchSize: 1 });
    const tEmbed = now() - t0;
    const body = {
      mode: state.mode,
      queryText: q,
      embedding: em.vectors[0],
      k: Number($('#selK').value),
      rankWindowSize: 40,
      rankConstant: 60
    };
    const r = await api(`/api/collections/${state.current}/search`, { method: 'POST', body: JSON.stringify(body) });
    const total = now() - t0;
    state.timings = { ...state.timings, queryEmbedMs: tEmbed, searchMs: r.result.ms, e2eMs: total, modelLoadMs: state.modelLoadMs };
    renderResults(r.result, q);
    $('#searchMeta').textContent = `查询向量化 ${Math.round(tEmbed)} ms · seekdb 检索 ${Math.round(r.result.ms)} ms · 端到端 ${Math.round(total)} ms`;
    renderDiag();
    log(`检索「${q}」mode=${state.mode} hits=${r.result.hits.length} ${Math.round(total)} ms`);
  } catch (e) {
    log(`检索失败：${e.message}`, 'err');
    toast('检索失败：' + e.message);
  } finally {
    $('#btnSearch').disabled = false;
  }
}

function highlight(text, q) {
  const terms = q.replace(/[，。？！,.?!]/g, ' ').split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  let out = escapeHtml(text);
  for (const t of terms) {
    out = out.replaceAll(escapeHtml(t), `<mark>${escapeHtml(t)}</mark>`);
  }
  // 中文整体未命中时，用 2-gram 兜底高亮
  if (!out.includes('<mark>')) {
    const cjk = q.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i + 2 <= cjk.length; i += 1) {
      const g = cjk.slice(i, i + 2);
      if (out.includes(g)) { out = out.replace(g, `<mark>${g}</mark>`); break; }
    }
  }
  return out;
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderResults(result, q) {
  const el = $('#results');
  if (!result.hits.length) {
    el.innerHTML = `<div class="empty"><p>没有命中任何片段。</p><p class="dim">试试更换关键词，或切到「混合 RRF」模式。</p></div>`;
    $('#resultMeta').textContent = '';
    return;
  }
  $('#resultMeta').textContent = `${result.hits.length} 条 · ${result.mode}`;
  el.innerHTML = result.hits.map((h) => {
    const src = h.metadata?.source ?? 'unknown';
    const snip = h.text.length > 220 ? h.text.slice(0, 220) + '…' : h.text;
    return `<article class="result">
      <div class="result-head">
        <span class="rank">${h.rank}</span>
        <span class="src">${escapeHtml(src)}</span>
        <span class="score">score ${fmt(h.score, 5)}</span>
      </div>
      <p class="snippet">${highlight(snip, q)}</p>
      <div class="meta-line"><span>chunk ${h.metadata?.chunk ?? '-'}</span><span>${h.text.length} 字</span><span>id ${h.id.slice(0, 22)}</span></div>
      <div class="expand" hidden>${escapeHtml(h.text)}</div>
    </article>`;
  }).join('');
  el.querySelectorAll('.result').forEach((n) => {
    n.style.cursor = 'pointer';
    n.addEventListener('click', () => { const d = n.querySelector('.expand'); d.hidden = !d.hidden; });
  });
}

/* ============================== 诊断面板 ============================== */
function renderDiag() {
  const b = state.backend;
  const t = state.timings;
  const rows = [
    ['推理后端', b.device ? `${b.device} / ${b.dtype}` : '—'],
    ['后端来源', b.reason || '—'],
    ['模型', MODEL_LABEL],
    ['向量维度', DIM],
    ['WASM 线程', String(env.backends.onnx.wasm.numThreads)],
    ['模型加载', state.modelLoadMs ? `${Math.round(state.modelLoadMs)} ms` : '—'],
    ['当前集合', state.current || '—'],
    ['集合条数', state.stats?.count ?? '—'],
    ['seekdb', state.seekdb?.version || '—']
  ];
  $('#diagKv').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');

  const timingRows = [
    ['模型加载', t.modelLoadMs],
    ['文档向量化', t.docEmbedMs ? `${Math.round(t.docEmbedMs)} ms / ${t.docEmbedCount} 段` : null],
    ['写入 seekdb', t.writeMs != null ? `${Math.round(t.writeMs)} ms` : null],
    ['索引刷新', t.refreshMs != null ? `${Math.round(t.refreshMs)} ms` : null],
    ['查询向量化', t.queryEmbedMs != null ? `${Math.round(t.queryEmbedMs)} ms` : null],
    ['seekdb 检索', t.searchMs != null ? `${Math.round(t.searchMs)} ms` : null],
    ['端到端', t.e2eMs != null ? `${Math.round(t.e2eMs)} ms` : null]
  ].filter(([, v]) => v != null);
  $('#timingTable').innerHTML = timingRows.length
    ? timingRows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')
    : `<tr><td class="dim">检索一次后显示</td></tr>`;
}

function renderData() {
  const s = state.stats;
  $('#dataKv').innerHTML = s
    ? `<dt>集合</dt><dd>${escapeHtml(s.name)}</dd><dt>表名</dt><dd>kb_${escapeHtml(s.name)}</dd><dt>条数</dt><dd>${s.count}</dd><dt>维度</dt><dd>${s.dimension}</dd><dt>索引</dt><dd>HNSW(cosine) + ngram2 全文</dd>`
    : `<dt>—</dt><dd>尚未选择集合</dd>`;
}

async function peek() {
  if (!state.current) return;
  const r = await api(`/api/collections/${state.current}/peek?limit=8`);
  $('#peekList').innerHTML = r.items.map((it) => `<div class="peek-item"><div class="id">${escapeHtml(it.id)} · ${escapeHtml(it.metadata?.source || '')}</div><div>${escapeHtml(it.text)}</div></div>`).join('') || '<div class="dim small">空集合</div>';
}

/* ============================== 评测 ============================== */
let evalData = null;

function ndcgAt(ranked, rel, k) {
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => { const g = rel[id] || 0; if (g) dcg += (2 ** g - 1) / Math.log2(i + 2); });
  const ideal = Object.values(rel).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((g, i) => { idcg += (2 ** g - 1) / Math.log2(i + 2); });
  return idcg ? dcg / idcg : 0;
}

async function runEval(onlyKeys = null) {
  if (state.busy) return;
  state.busy = true;
  $('#btnEval').disabled = true;
  const out = $('#evalOut');
  try {
    if (!evalData) evalData = await (await fetch('/data/eval.json')).json();
    const { corpus, queries } = evalData;
    const variants = [];
    const det = state.backend;
    if (det.device === 'webgpu') {
      variants.push({ key: 'fp32', device: 'wasm', dtype: 'fp32', label: 'FP32 + WASM' });
      variants.push({ key: 'fp16', device: 'webgpu', dtype: 'fp16', label: 'FP16 + WebGPU' });
    } else {
      variants.push({ key: 'fp32', device: 'wasm', dtype: 'fp32', label: 'FP32 + WASM' });
    }
    variants.push({ key: 'q8', device: 'wasm', dtype: 'q8', label: 'INT8 + WASM' });
    const picked = onlyKeys ? variants.filter((v) => onlyKeys.includes(v.key)) : variants;
    // 释放当前主模型，避免多份权重同时驻留内存
    if (state.model) { try { await state.model.dispose?.(); } catch { /* noop */ } state.model = null; window.__modelReady = false; }

    out.innerHTML = `<p class="dim">评测集：${corpus.length} 篇文档 / ${queries.length} 条查询。开始加载各精度模型…</p>`;
    const results = [];
    for (const v of picked) {
      out.innerHTML += `<p class="dim">▸ ${v.label}：加载模型…</p>`;
      const { pipe, ms: loadMs } = await loadModel(v.device, v.dtype);
      const coll = `eval_${v.key}`;
      await api('/api/collections', { method: 'POST', body: JSON.stringify({ name: coll, dimension: DIM }) }).catch(() => {});
      await api(`/api/collections/${coll}`, { method: 'DELETE' }).catch(() => {});
      await api('/api/collections', { method: 'POST', body: JSON.stringify({ name: coll, dimension: DIM }) });

      const embedWith = async (texts, isQuery) => {
        const arr = [];
        const t0 = now();
        for (let i = 0; i < texts.length; i += 16) {
          const batch = (isQuery ? texts.slice(i, i + 16).map((t) => QUERY_PREFIX + t) : texts.slice(i, i + 16));
          const o = await pipe(batch, { pooling: 'cls', normalize: true });
          const [n, d] = o.dims;
          for (let r = 0; r < n; r++) arr.push(Array.from(o.data.slice(r * d, (r + 1) * d)));
        }
        return { vectors: arr, ms: now() - t0 };
      };

      const tDoc = await embedWith(corpus.map((d) => d.text), false);
      const items = corpus.map((d, i) => ({ id: d.id, text: d.text, metadata: { source: d.id }, embedding: tDoc.vectors[i] }));
      for (let i = 0; i < items.length; i += 64) {
        await api(`/api/collections/${coll}/docs`, { method: 'POST', body: JSON.stringify({ items: items.slice(i, i + 64), refresh: false }) });
      }
      await api(`/api/collections/${coll}/refresh`, { method: 'POST' });

      const lat = [];
      let recall5 = 0, ndcg10 = 0, mrr = 0;
      for (const q of queries) {
        const qe = await embedWith([q.q], true);
        const t0 = now();
        const r = await api(`/api/collections/${coll}/search`, {
          method: 'POST',
          body: JSON.stringify({ mode: 'hybrid', queryText: q.q, embedding: qe.vectors[0], k: 10 })
        });
        lat.push(now() - t0);
        const ranked = r.result.hits.map((h) => h.id);
        const rel = q.rel;
        recall5 += ranked.slice(0, 5).filter((id) => rel[id]).length / Object.keys(rel).length;
        ndcg10 += ndcgAt(ranked, rel, 10);
        const first = ranked.findIndex((id) => rel[id]);
        mrr += first >= 0 ? 1 / (first + 1) : 0;
      }
      const n = queries.length;
      lat.sort((a, b) => a - b);
      results.push({
        label: v.label, key: v.key,
        loadMs: Math.round(loadMs),
        docThroughput: +(corpus.length / (tDoc.ms / 1000)).toFixed(1),
        recall5: +(recall5 / n).toFixed(4),
        ndcg10: +(ndcg10 / n).toFixed(4),
        mrr: +(mrr / n).toFixed(4),
        p50: Math.round(lat[Math.floor(n * 0.5)]),
        sizeMB: state.modelSizes[v.key] ? +(state.modelSizes[v.key] / 1048576).toFixed(1) : null
      });
      out.innerHTML += `<p class="dim">✓ ${v.label} 完成</p>`;
      await api(`/api/collections/${coll}`, { method: 'DELETE' }).catch(() => {});
      await pipe.dispose?.();
      // 每完成一个变体就落盘，供外部采集（?autorun=eval&variant=q8 单变体模式）
      window.__evalResult = { ts: new Date().toISOString(), backend: state.backend, results: [...results], corpus: evalData.corpus.length, queries: evalData.queries.length, partial: !!onlyKeys };
    }

    const head = `<tr><th>配置</th><th>体积</th><th>Recall@5</th><th>nDCG@10</th><th>MRR</th><th>检索 p50</th></tr>`;
    const body = results.map((r) => `<tr><td>${r.label}</td><td>${r.sizeMB ?? '—'} MB</td><td>${r.recall5.toFixed(3)}</td><td>${r.ndcg10.toFixed(3)}</td><td>${r.mrr.toFixed(3)}</td><td>${r.p50} ms</td></tr>`).join('');
    out.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>
      <p class="dim small" style="margin-top:8px">评测集 ${evalData.corpus.length} 篇 / ${evalData.queries.length} 问；检索均走 seekdb 混合检索，TopK=10。</p>`;
    window.__evalResult = { ts: new Date().toISOString(), backend: state.backend, results, corpus: evalData.corpus.length, queries: evalData.queries.length };
    log('评测完成：' + results.map((r) => `${r.label} R@5=${r.recall5}`).join(' | '));  } catch (e) {
    log('评测失败：' + e.message, 'err');
    out.innerHTML = `<p class="dim">评测失败：${escapeHtml(e.message)}</p>`;
  } finally {
    state.busy = false;
    $('#btnEval').disabled = false;
    await loadCollections().catch(() => {});
  }
}

/* ============================== 性能基准 ============================== */
/**
 * ?autorun=bench 触发：
 *  - 不同批大小的文档向量化吞吐（先预热，重复 3 轮取中位数）
 *  - 单条查询向量化延迟（30 次，p50/p95）
 *  - seekdb 检索延迟（若已有集合，30 次混合检索，p50/p95）
 */
async function runBench() {
  const model = await ensureModel();
  const out = { backend: state.backend, embed: {}, queryP50: null, queryP95: null, searchP50: null, searchP95: null, repeats: 3 };
  const docs = (await (await fetch('/data/eval.json')).json()).corpus.map((d) => d.text);
  const pool = [];
  while (pool.length < 128) pool.push(...docs);
  pool.length = 128;

  for (const bs of [1, 8, 16, 32]) {
    // 预热一轮
    await model(pool.slice(0, bs), { pooling: 'cls', normalize: true });
    const runs = [];
    for (let r = 0; r < out.repeats; r++) {
      const t0 = now();
      for (let i = 0; i < 64; i += bs) {
        await model(pool.slice(i, i + bs), { pooling: 'cls', normalize: true });
      }
      runs.push(now() - t0);
    }
    runs.sort((a, b) => a - b);
    const med = runs[Math.floor(runs.length / 2)];
    out.embed[bs] = { ms: Math.round(med), throughput: +(64 / (med / 1000)).toFixed(1) };
    log(`bench batch=${bs}: ${Math.round(med)} ms / 64 段 → ${out.embed[bs].throughput} 段/s`);
  }

  const lat = [];
  for (let i = 0; i < 30; i++) {
    const t = now();
    await model([QUERY_PREFIX + pool[i]], { pooling: 'cls', normalize: true });
    lat.push(now() - t);
  }
  lat.sort((a, b) => a - b);
  out.queryP50 = +lat[15].toFixed(1);
  out.queryP95 = +lat[28].toFixed(1);

  if (state.current && state.stats?.count > 0) {
    const sl = [];
    for (let i = 0; i < 30; i++) {
      const v = Array.from((await model([pool[i]], { pooling: 'cls', normalize: true })).data);
      const t = now();
      await api(`/api/collections/${state.current}/search`, { method: 'POST', body: JSON.stringify({ mode: 'hybrid', queryText: pool[i].slice(0, 30), embedding: v, k: 10 }) });
      sl.push(now() - t);
    }
    sl.sort((a, b) => a - b);
    out.searchP50 = +sl[15].toFixed(1);
    out.searchP95 = +sl[28].toFixed(1);
    out.searchCount = state.stats.count;
  }
  window.__benchResult = out;
  log('bench 完成');
}

/* ============================== 事件绑定 ============================== */
function bind() {
  $('#btnPick').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { if (e.target.files.length) ingestFiles(Array.from(e.target.files)); });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.(txt|md|markdown|csv)$/i.test(f.name));
    if (files.length) ingestFiles(files); else toast('请拖入 .txt / .md 文件');
  });
  $('#pasteBox').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const text = e.target.value.trim();
      if (text) { e.target.value = ''; ingestTexts([{ name: `paste-${Date.now()}.txt`, text }]); }
    }
  });
  $('#btnIngest').addEventListener('click', () => {
    const text = $('#pasteBox').value.trim();
    if (!text) return $('#fileInput').click();
    $('#pasteBox').value = '';
    ingestTexts([{ name: `paste-${Date.now()}.txt`, text }]);
  });
  $('#btnNewKb').addEventListener('click', async () => {
    const name = prompt('新知识库名称（字母/数字/下划线）：', 'kb' + Date.now().toString().slice(-4));
    if (!name) return;
    try { await createKb(name); toast('已创建 ' + name); } catch (e) { toast(e.message); }
  });
  $('#btnDropKb').addEventListener('click', async () => {
    if (!state.current) return;
    if (!confirm(`删除知识库「${state.current}」及其全部向量？`)) return;
    await api(`/api/collections/${state.current}`, { method: 'DELETE' });
    log(`已删除集合 ${state.current}`);
    state.current = null; state.stats = null;
    localStorage.removeItem('kb.current');
    await loadCollections();
    $('#results').innerHTML = emptyResults();
    renderData();
  });
  $('#btnRefreshList').addEventListener('click', () => loadCollections());
  $('#btnSearch').addEventListener('click', () => doSearch($('#q').value));
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch($('#q').value); });
  $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
    $$('#modeSeg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.mode = b.dataset.mode;
  }));
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    $$('.tab-body').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
    if (b.dataset.tab === 'data') peek();
  }));
  $('#btnPeek').addEventListener('click', peek);
  $('#btnEval').addEventListener('click', runEval);
  $('#chips').innerHTML = ['退款多久到账', '发票怎么开', '会员自动续费能关吗', '忘记密码怎么办', 'API 限流多少']
    .map((q) => `<button class="chip">${q}</button>`).join('');
  $$('#chips .chip').forEach((c) => c.addEventListener('click', () => { $('#q').value = c.textContent; doSearch(c.textContent); }));
}

/* ============================== 启动 ============================== */
async function boot() {
  bind();
  try {
    const h = await api('/api/health');
    state.seekdb = h.seekdb;
    const el = $('#badgeSeekdb');
    el.className = 'badge ok';
    el.textContent = `seekdb ${h.seekdb.version.replace('5.7.25-OceanBase ', '')}`;
    el.title = `${h.seekdb.mode} · ${h.seekdb.target}`;
    log(`seekdb 已连接：${h.seekdb.version}（${h.seekdb.mode} / ${h.seekdb.target}）`);
  } catch (e) {
    $('#badgeSeekdb').className = 'badge err';
    $('#badgeSeekdb').textContent = 'seekdb 未连接';
    log('seekdb 连接失败：' + e.message, 'err');
  }
  await ensureModel().catch((e) => log('模型加载失败：' + e.message, 'err'));
  await loadCollections().catch((e) => log('集合列表加载失败：' + e.message, 'err'));
  renderDiag();

  const autorun = params.get('autorun');
  if (autorun === 'eval') await runEval(params.get('variant') ? params.get('variant').split(',') : null);
  if (autorun === 'bench') await runBench();
}

boot();
