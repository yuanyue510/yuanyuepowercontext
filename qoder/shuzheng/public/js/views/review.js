import { api, el, fmt } from '../api.js';

const STATE_LABEL = { open: '还没懂', reviewing: '在复习', mastered: '已掌握' };
const STATE_CLASS = { open: 'bad', reviewing: 'warn', mastered: 'ok' };

const stamp = (ms) => (ms ? new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) : '—');

export function initReview() {
  const select = document.getElementById('rv-dataset');
  const limit = document.getElementById('rv-limit');
  const btn = document.getElementById('rv-refresh');
  const counts = document.getElementById('rv-counts');
  const list = document.getElementById('rv-list');
  const status = document.getElementById('rv-status');

  let busy = false;

  async function refreshDatasets() {
    const previous = select.value;
    try {
      const datasets = await api.listDatasets();
      select.textContent = '';
      select.append(el('option', { value: '', text: '全部资料集' }));
      for (const d of datasets) select.append(el('option', { value: d.name, text: `${d.name}（${d.chunkCount} 句）` }));
      if (previous) select.value = previous;
    } catch (err) {
      status.textContent = `资料集列表不可用：${err.message}`;
    }
  }

  function rowItem(row) {
    const buttons = Object.entries(STATE_LABEL).map(([target, label]) =>
      el(
        'button',
        {
          class: `state ${target === row.status ? 'current' : ''}`,
          disabled: target === row.status || !row.allowed.includes(target) ? 'disabled' : null,
          onclick: () => setState(row, target),
        },
        [label],
      ),
    );

    return el('div', { class: 'card review' }, [
      el('div', { class: 'card-head' }, [
        el('span', { class: `badge ${STATE_CLASS[row.status]}`, text: STATE_LABEL[row.status] }),
        el('strong', { text: row.concept || row.questionText }),
        el('span', { class: 'ref', text: `错 ${row.missCount} 次` }),
      ]),
      el('p', { class: 'sentence', text: `原问题：${row.questionText}` }),
      el('div', { class: 'card-meta' }, [
        el('span', { text: `资料集：${row.datasetName}｜覆盖率 ${fmt(row.coverage)}｜未出现词：${row.missedTerms || '无'}` }),
        el('span', { text: `最近证据 docId：${row.nearestDocId || '无'}｜卡点 ${row.latestStuckId || '—'}` }),
        el('span', { text: `首次 ${stamp(row.firstSeen)}｜最近 ${stamp(row.lastSeen)}｜状态变更 ${stamp(row.statusChangedAt)}` }),
      ]),
      el('div', { class: 'state-actions' }, buttons),
    ]);
  }

  async function setState(row, target) {
    if (busy) return;
    busy = true;
    status.textContent = `提交 ${row.id} → ${STATE_LABEL[target]}…`;
    try {
      const r = await api.reviewState(row.id, target);
      status.textContent = `${row.id} 已置为「${STATE_LABEL[target]}」${target === 'mastered' ? `（${stamp(r.row.masteredAt)}）` : ''}`;
      await refresh(); // 局部刷新：只重画列表，不整页跳转
    } catch (err) {
      status.textContent = `${STATE_LABEL[target]} 未生效：${err.message}`;
      await refresh(); // 库内状态可能已被别处改走，拉回真值而不是留旧行
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    status.textContent = '加载中…';
    try {
      const data = await api.reviewList({ dataset: select.value, limit: Number(limit.value) || 20 });
      list.textContent = '';
      const c = data.counts;
      counts.textContent = `待复习 ${(c.open ?? 0) + (c.reviewing ?? 0)} 条｜已掌握 ${c.mastered ?? 0} 条`;
      if (data.pending.length === 0) {
        list.append(el('p', { class: 'empty', text: '还没有卡点' }));
        status.textContent = `队列为空（${data.table}）`;
        return;
      }
      status.textContent = `共 ${data.pending.length} 条待复习（表 ${data.table}）`;
      for (const row of data.pending) list.append(rowItem(row));
    } catch (err) {
      status.textContent = `读取失败：${err.message}`;
      list.textContent = '';
      list.append(el('p', { class: 'bad', text: `复习队列读取失败：${err.message}` }));
    }
  }

  btn.addEventListener('click', refresh);
  select.addEventListener('change', refresh);
  limit.addEventListener('change', refresh);

  return {
    refresh,
    // 切进标签页时先定下资料集过滤器，再拉队列，避免列表读到半重建的 select。
    open: async () => {
      await refreshDatasets();
      await refresh();
    },
  };
}
