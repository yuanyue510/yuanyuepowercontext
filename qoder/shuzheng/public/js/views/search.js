import { api, el } from '../api.js';
import { evidenceCard } from '../ui/evidence-card.js';
import { renderLocated } from '../ui/highlight.js';

const CONFIDENCE = { sufficient: ['充分', 'ok'], thin: ['单薄', 'warn'], none: ['无依据 · 已拒答', 'bad'] };

function renderCoverage(root, cov) {
  root.textContent = '';
  root.append(
    el('div', { class: 'rules' }, [
      el('h3', { text: cov.covered ? '未覆盖判定：两条规则未同时成立 → 判为已覆盖' : '未覆盖判定：两条规则同时成立 → 判为「资料没讲到」' }),
      el('ul', {}, [
        el('li', { class: cov.rule1LowCoverage ? 'hit' : '', text: `规则① 关键词覆盖率 ${cov.coverage} ${cov.rule1LowCoverage ? '<' : '≥'} 阈值 ${cov.coverageFloor} → ${cov.rule1LowCoverage ? '成立' : '不成立'}` }),
        el('li', { class: cov.rule2NoSharedTermSentence ? 'hit' : '', text: `规则② 没有一句同时包含 ≥2 个查询词（最强的一句含 ${cov.witnessTermCount} 个）→ ${cov.rule2NoSharedTermSentence ? '成立' : '不成立'}` }),
      ]),
      el('p', { class: 'why', text: `查询词：${cov.terms.join('、') || '（未抽出）'}｜命中：${cov.hitTerms.join('、') || '无'}｜未出现：${cov.missedTerms.join('、') || '无'}` }),
      cov.witness?.sentence
        ? el('p', { class: 'why', text: `最强证据句（含 ${cov.witness.terms.length} 个查询词）：${cov.witness.sentence}` })
        : null,
      el('p', { class: 'note', text: '分数不参与任何判定：hybridSearch 的 distances 是融合名次分，无上界且跨查询不可比，只用于排序。' }),
    ]),
  );
}

function renderAnswer(root, data, locate) {
  root.textContent = '';
  const [label, cls] = CONFIDENCE[data.confidence];
  const head = el('div', { class: 'answer-head' }, [
    el('span', { class: `badge ${cls}`, text: label }),
    el('span', { class: 'crumb', text: `依据资料集：${data.datasetName}｜证据 ${data.evidence.length} 条｜${data.timing.totalMs} ms（向量化 ${data.timing.embedMs} + 检索 ${data.timing.searchMs}）` }),
  ]);
  const body =
    data.answer.kind === 'refusal'
      ? el('div', {}, [
          el('p', { class: 'refusal' }, [data.answer.text]),
          data.stuck && data.stuck.stuckId
            ? el('p', { class: 'ok', text: `已写入卡点账本 ${data.stuck.collectionName} → ${data.stuck.stuckId}（state=${data.stuck.state}），GET /api/stuck 可查` })
            : null,
          data.stuck && data.stuck.reviewId
            ? el('p', { class: 'ok', text: `已进入复习队列 sh_review → ${data.stuck.reviewId}（open），「卡点复习」标签页可流转状态` })
            : null,
          data.stuck && data.stuck.error ? el('p', { class: 'bad', text: data.stuck.error }) : null,
        ])
      : el(
          'ol',
          { class: 'statements' },
          data.answer.statements.map((s) =>
            el('li', {}, [
              el('span', { class: 'stmt' }, [s.sentence]),
              el('button', { class: 'locate', onclick: () => locate(s) }, ['看原文']),
            ]),
          ),
        );
  root.append(el('section', { class: `answer ${data.answer.kind}` }, [head, body]));
}

export function initSearch() {
  const select = document.getElementById('q-dataset');
  const input = document.getElementById('q-text');
  const nInput = document.getElementById('q-n');
  const btn = document.getElementById('q-submit');
  const answerRoot = document.getElementById('q-answer');
  const covRoot = document.getElementById('q-coverage');
  const cardsRoot = document.getElementById('q-cards');
  const reader = document.getElementById('reader');
  const readerTitle = document.getElementById('reader-title');
  const readerBody = document.getElementById('reader-body');

  const textCache = new Map();
  let currentDataset = null;

  async function loadText(name) {
    if (!textCache.has(name)) textCache.set(name, await api.datasetText(name));
    return textCache.get(name);
  }

  async function locate({ datasetName = currentDataset, id, charStart, charEnd, sentence }) {
    try {
      const doc = await loadText(datasetName);
      readerTitle.textContent = `${datasetName} · ${doc.filename}（${doc.charCount} 字）`;
      const check = renderLocated(readerBody, doc.text, { sentence, charStart, charEnd });
      reader.querySelector('.offset-check').textContent = `${check.note}${id ? `｜切片 ${id}` : ''}`;
      reader.hidden = false;
    } catch (err) {
      reader.hidden = false;
      reader.querySelector('.offset-check').textContent = `定位失败：${err.message}`;
    }
  }

  document.getElementById('reader-close').addEventListener('click', () => {
    reader.hidden = true;
  });

  async function refreshDatasets() {
    try {
      const datasets = await api.listDatasets();
      select.textContent = '';
      for (const d of datasets) select.append(el('option', { value: d.name, text: `${d.name}（${d.chunkCount} 句）` }));
      if (datasets.length === 0) select.append(el('option', { value: '', text: '（无资料集，请先导入）' }));
      currentDataset = select.value;
    } catch (err) {
      select.textContent = '';
      select.append(el('option', { text: `加载失败：${err.message}` }));
    }
  }

  select.addEventListener('change', () => (currentDataset = select.value));

  btn.addEventListener('click', async () => {
    const query = input.value.trim();
    if (!query || !select.value) {
      answerRoot.textContent = '';
      answerRoot.append(el('p', { class: 'bad', text: '需要资料集与问题内容' }));
      return;
    }
    currentDataset = select.value;
    btn.disabled = true;
    cardsRoot.textContent = '';
    covRoot.textContent = '';
    answerRoot.textContent = '';
    answerRoot.append(el('p', { class: 'busy', text: '多路召回中（本地向量化 + seekdb 混合检索，全程离线）…' }));
    try {
      const data = await api.search({ datasetName: select.value, query, nResults: Number(nInput.value) || 8 });
      renderAnswer(answerRoot, data, (s) => locate({ ...s, id: s.cardId }));
      renderCoverage(covRoot, data.coverage);
      cardsRoot.textContent = '';
      cardsRoot.append(
        el('p', { class: 'note', text: `召回通道：${data.channels.map((c) => (c.type === 'vector' ? `向量 ${c.hits}` : `${c.keyword} ${c.hits}`)).join(' ｜ ')}` }),
        ...data.evidence.map((c) => evidenceCard(c, (card) => locate(card))),
      );
    } catch (err) {
      answerRoot.textContent = '';
      answerRoot.append(el('p', { class: 'bad', text: `检索失败：${err.message}` }));
    } finally {
      btn.disabled = false;
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });

  return { refreshDatasets };
}
