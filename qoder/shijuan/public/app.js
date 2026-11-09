const $ = (s) => document.querySelector(s);
const state = {
  collections: [],
  current: localStorage.getItem('sj.collection') || '',
  learner: localStorage.getItem('sj.learner') || 'demo',
  lastAsk: null,
  loading: false
};

const toast = (msg) => {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false, message: '返回不是 JSON' }));
  if (!res.ok || data.ok === false) throw new Error(data.message || `请求失败 ${res.status}`);
  return data;
}

/* ---------------- 启动 ---------------- */

(async function init() {
  $('#learner').value = state.learner;
  $('#learner').addEventListener('change', (e) => {
    state.learner = e.target.value.trim() || 'demo';
    localStorage.setItem('sj.learner', state.learner);
    $('#btn-export').href = `/api/export/review?learner=${encodeURIComponent(state.learner)}`;
    loadMemory();
    toast(`学习者切换为 ${state.learner}`);
  });
  $('#btn-export').href = `/api/export/review?learner=${encodeURIComponent(state.learner)}`;

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $(`#panel-${t.dataset.tab}`).classList.add('active');
      if (t.dataset.tab === 'memory') loadMemory();
    })
  );

  document.querySelectorAll('#examples .chip').forEach((c) =>
    c.addEventListener('click', () => {
      $('#q').value = c.textContent;
      ask();
    })
  );

  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ask();
  });
  $('#btn-new-col').addEventListener('click', newCollection);
  $('#btn-import').addEventListener('click', importDocs);
  $('#btn-pick').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', pickFiles);
  $('#btn-mark-weak').addEventListener('click', markWeak);
  $('#mode').addEventListener('change', updateModeHint);

  await refreshStatus();
  await loadCollections();
  loadMemory();
})();

async function refreshStatus() {
  try {
    const h = await api('/api/health');
    const m = h.seekdb.version.match(/seekdb-v[\d.]+/);
    $('#pill-db').textContent = m ? m[0] : 'seekdb 已连接';
    $('#pill-db').className = 'pill ok';
    const total = h.collections.reduce((s, c) => s + c.count, 0);
    $('#pill-docs').textContent = `${h.collections.length} 个资料集 · ${total} 片段`;
    $('#mode-hint').textContent = `本地 bge ${h.model.dimension} 维 · ${h.model.dtype.toUpperCase()}`;
  } catch (e) {
    $('#pill-db').textContent = 'seekdb 未连接';
    $('#pill-db').className = 'pill bad';
  }
}

async function loadCollections() {
  try {
    const { collections } = await api('/api/collections');
    state.collections = collections;
    if (!collections.some((c) => c.name === state.current)) {
      state.current = collections[0]?.name || '';
      localStorage.setItem('sj.collection', state.current);
    }
    renderCollections();
    updateDocsTable();
  } catch (e) {
    toast(e.message);
  }
}

function renderCollections() {
  const ul = $('#col-list');
  ul.innerHTML = '';
  if (!state.collections.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = '还没有资料集，点右上「新建」';
    ul.appendChild(li);
    return;
  }
  for (const c of state.collections) {
    const li = document.createElement('li');
    li.className = c.name === state.current ? 'active' : '';
    const label = document.createElement('span');
    label.textContent = c.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = c.count;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '删除';
    del.title = '删除该资料集（表会一起删掉）';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`删除资料集「${c.name}」？seekdb 里的表会一起删除。`)) return;
      await api(`/api/collections/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
      toast('已删除');
      await loadCollections();
      await refreshStatus();
    });
    li.append(label, count, del);
    li.addEventListener('click', () => {
      state.current = c.name;
      localStorage.setItem('sj.collection', c.name);
      renderCollections();
    });
    ul.appendChild(li);
  }
}

function updateDocsTable() {
  const tb = $('#chunk-table tbody');
  tb.innerHTML = '';
  for (const c of state.collections) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td></td><td></td><td></td>`;
    tr.children[0].textContent = c.name;
    tr.children[1].textContent = c.count;
    tr.children[2].textContent = c.dimension ? `${c.dimension} 维` : '-';
    tr.children[3].textContent = 'HNSW(cosine) + ngram2 全文';
    tb.appendChild(tr);
  }
}

async function newCollection() {
  const name = prompt('新资料集名称（例如：期末复习、论文-推荐系统）');
  if (!name) return;
  try {
    const r = await api('/api/collections', { method: 'POST', body: { name } });
    state.current = r.name;
    localStorage.setItem('sj.collection', r.name);
    await loadCollections();
    await refreshStatus();
    toast(r.created ? `已创建「${r.name}」` : `「${r.name}」已存在`);
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- 提问 ---------------- */

function updateModeHint() {
  const m = $('#mode').value;
  const map = {
    hybrid: '全文 + 向量双路召回，RRF 在 seekdb 内融合',
    vector: 'HNSW 近邻，纯语义',
    fulltext: 'ngram2 全文倒排，纯关键词'
  };
  $('#mode-hint').textContent = map[m];
}

async function ask() {
  if (state.loading) return;
  const q = $('#q').value.trim();
  if (!q) return;
  if (!state.current) return toast('先新建或选择一个资料集');
  state.loading = true;
  const btn = $('#ask-form .primary');
  btn.textContent = '检索中';
  btn.disabled = true;
  try {
    const t0 = performance.now();
    const r = await api('/api/ask', {
      method: 'POST',
      body: {
        collection: state.current,
        query: q,
        learner: state.learner,
        mode: $('#mode').value,
        k: Number($('#topk').value)
      }
    });
    state.lastAsk = { question: q, collection: state.current, ...r };
    renderAnswer(r, q);
    renderHits(r.hits);
    await refreshStatus();
    await loadMemoryCount();
    if (r.weak) toast('资料里没讲到，已记入复习清单');
    console.log(`ask done ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    toast(e.message);
  } finally {
    state.loading = false;
    btn.textContent = '检索';
    btn.disabled = false;
  }
}

function renderAnswer(r, q) {
  const box = $('#answer-box');
  box.classList.remove('hidden', 'warn');
  if (!r.covered) box.classList.add('warn');
  $('#ans-tag').textContent = r.covered ? '资料已覆盖' : '资料未覆盖 · 已记录';
  $('#ans-tag').className = `tag${r.covered ? '' : ' warn'}`;
  $('#ans-meta').textContent = `${r.hits.length} 个片段 · 查询词覆盖 ${(r.coverage * 100).toFixed(0)}% · 向量化 ${r.times.embedMs}ms · 检索 ${r.times.searchMs}ms · 合计 ${r.times.totalMs}ms`;
  const body = $('#ans-body');
  body.innerHTML = '';
  for (const line of r.answer.split('\n')) {
    const p = document.createElement('div');
    p.textContent = line;
    body.appendChild(p);
  }
  $('#btn-mark-weak').dataset.question = q;
}

function renderHits(hits) {
  const wrap = $('#hits');
  wrap.innerHTML = '';
  if (!hits.length) return;
  hits.forEach((h) => {
    const d = document.createElement('details');
    d.className = 'hit';
    const s = document.createElement('summary');
    s.innerHTML = `<span class="rank"></span><span class="src"></span><span class="sim"></span>`;
    s.children[0].textContent = h.rank;
    s.children[1].textContent = h.metadata?.source || h.id;
    s.children[2].textContent = `cos ${(h.similarity ?? 0).toFixed(3)} · ${h.id}`;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = h.text;
    d.append(s, body);
    wrap.appendChild(d);
  });
}

async function markWeak() {
  const a = state.lastAsk;
  if (!a) return;
  try {
    await api('/api/memory/weak', {
      method: 'POST',
      body: {
        learner: state.learner,
        collection: a.collection,
        question: a.question,
        evidence: a.hits[0]?.text?.slice(0, 220) || '',
        score: a.coverage,
        miss: 1
      }
    });
    toast('已记入复习清单，下次打开还在');
    loadMemory();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- 导入 ---------------- */

async function pickFiles(e) {
  const files = [...e.target.files];
  if (!files.length) return;
  const docs = [];
  for (const f of files) docs.push({ name: f.name, text: await f.text() });
  $('#doc-name').value = docs.map((d) => d.name).join('、').slice(0, 40);
  $('#doc-text').value = docs.map((d) => d.text).join('\n\n');
  $('#doc-text').dataset.batch = JSON.stringify(docs);
  toast(`已载入 ${docs.length} 个文件，点「导入」写入 seekdb`);
}

async function importDocs() {
  if (!state.current) return toast('先新建或选择一个资料集');
  let files;
  if ($('#doc-text').dataset.batch) {
    files = JSON.parse($('#doc-text').dataset.batch);
  } else {
    const text = $('#doc-text').value.trim();
    if (!text) return toast('先粘贴内容或选择文件');
    files = [{ name: $('#doc-name').value.trim() || `笔记-${Date.now()}.md`, text }];
  }
  const btn = $('#btn-import');
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const r = await api('/api/docs', { method: 'POST', body: { collection: state.current, files } });
    $('#doc-text').value = '';
    delete $('#doc-text').dataset.batch;
    $('#doc-name').value = '';
    const rep = $('#import-report');
    rep.classList.remove('hidden');
    rep.innerHTML = '';
    const line = document.createElement('div');
    line.textContent = `「${r.collection}」新增 ${r.chunks} 个片段（${r.files.length} 篇）；导入后自检：${r.selfCheck ? '新内容已可检索 ✓' : '未命中 ✗'}`;
    const ms = document.createElement('div');
    ms.className = 'hint';
    ms.textContent = `切片 ${r.ms.chunk}ms · 向量化 ${r.ms.embed}ms · 写入 ${r.ms.write}ms · 刷新索引 ${r.ms.refresh}ms · 自检 ${r.ms.verify}ms`;
    rep.append(line, ms);
    await loadCollections();
    await refreshStatus();
    toast('导入完成');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '导入当前资料集';
  }
}

/* ---------------- 记忆 ---------------- */

async function loadMemoryCount() {
  try {
    const { overview } = await api(`/api/memory?learner=${encodeURIComponent(state.learner)}`);
    $('#pill-mem').textContent = `${overview.open} 条待复习 · 累计提问 ${overview.questions}`;
  } catch {}
}

async function loadMemory() {
  try {
    const { items, overview } = await api(`/api/memory?learner=${encodeURIComponent(state.learner)}`);
    $('#pill-mem').textContent = `${overview.open} 条待复习 · 累计提问 ${overview.questions}`;
    const stats = $('#mem-stats');
    stats.innerHTML = '';
    const cards = [
      [overview.questions, '累计提问'],
      [overview.open, '待复习薄弱点'],
      [overview.mastered, '已掌握'],
      [overview.avgScore == null ? '-' : (overview.avgScore * 100).toFixed(0) + '%', '平均查询覆盖率']
    ];
    for (const [v, k] of cards) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = `<b></b><span></span>`;
      d.children[0].textContent = v;
      d.children[1].textContent = k;
      stats.appendChild(d);
    }

    const list = $('#mem-list');
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="mem-empty">还没有待复习的内容。提问时如果资料没讲到，或点「没懂，记下来」，这里就会出现。</div>';
    }
    for (const w of items) {
      const div = document.createElement('div');
      div.className = 'mem-item';
      const info = document.createElement('div');
      info.innerHTML = `<h4></h4><p></p>`;
      info.children[0].textContent = w.concept;
      const p = info.children[1];
      p.textContent = `${w.collection} · 提问 ${w.asks} 次 · 标记没懂 ${w.misses} 次 · 查询覆盖 ${w.last_score == null ? '-' : (Number(w.last_score) * 100).toFixed(0) + '%'}`;
      p.className = w.misses > 1 ? 'miss' : '';
      const acts = document.createElement('div');
      acts.className = 'mem-actions';
      const ok = document.createElement('button');
      ok.className = 'ghost';
      ok.textContent = '懂了';
      ok.addEventListener('click', () => review(w.id, 'understood'));
      const no = document.createElement('button');
      no.className = 'ghost';
      no.textContent = '还是不懂';
      no.addEventListener('click', () => review(w.id, 'still_lost'));
      acts.append(ok, no);
      div.append(info, acts);
      list.appendChild(div);
    }
    $('#mem-hint').textContent = `学习者 ${state.learner} 的记忆存在 seekdb 的 sj_weakpoints 表，换会话仍在`;
  } catch (e) {
    toast(e.message);
  }
}

async function review(id, result) {
  try {
    await api('/api/memory/review', { method: 'POST', body: { weakId: id, result } });
    toast(result === 'understood' ? '已标记掌握' : '保留在复习清单');
    loadMemory();
    refreshStatus();
  } catch (e) {
    toast(e.message);
  }
}
