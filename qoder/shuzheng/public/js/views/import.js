import { api, el } from '../api.js';

const STATS = [
  ['chunkCount', '切片数', (v) => `${v} 条（句级，一条 = 一个可定位原句）`],
  ['sectionCount', '小节数', (v) => `${v} 个`],
  ['mergedCount', 'R1 合并', (v) => `${v} 条短句被并入相邻句（<15 字不单独成 chunk）`],
  ['residualShort', '残留短句', (v) => `${v} 条（应为 0，非 0 说明有无法合并的孤立短句）`],
  ['offsetOk', 'offset 自检', (v) => (v ? '全部切片 char_start–end 与原文逐字一致' : '存在偏移，禁止进入检索')],
  ['embedMs', '本地向量化', (v) => `${v} ms（bge-small-zh-v1.5，q8，离线）`],
  ['readyMs', '就绪门槛', (v, all) => `等待 ${v} ms：轮询 ${all.readyPolls} 次 × ${all.readyIntervalMs} ms（上限 ${all.readyTimeoutMs} ms），连续 2 次读数相同且 ≥ 期望条数才放行`],
  ['collectionName', '集合名', (v) => `${v}（中文名 → ASCII 映射，用户只看中文）`],
  ['previousRebuilt', '重复导入', (v) => (v ? '该资料集已存在，本次为整体重建（幂等）' : '新建资料集')],
];

function statRows(stats) {
  return el(
    'dl',
    { class: 'stats' },
    STATS.flatMap(([key, label, fmtFn]) => [
      el('dt', { text: label }),
      el('dd', { class: key === 'offsetOk' && !stats[key] ? 'bad' : '', text: fmtFn(stats[key], stats) }),
    ]),
  );
}

function renderTable(root, datasets) {
  root.textContent = '';
  if (!datasets.length) {
    root.append(el('p', { class: 'placeholder', text: '还没有资料集。导入一份 .md / .txt 即可。' }));
    return;
  }
  const table = el('table', { class: 'grid' }, [
    el('tr', {}, ['资料集', '状态', '切片', '文件', '集合名'].map((h) => el('th', { text: h }))),
    ...datasets.map((d) =>
      el('tr', {}, [
        el('td', { text: d.name }),
        el('td', { class: d.status === 'ready' ? 'ok' : 'warn', text: d.status }),
        el('td', { text: String(d.chunkCount) }),
        el('td', { text: d.filename }),
        el('td', { class: 'mono', text: d.collectionName }),
      ]),
    ),
  ]);
  root.append(table);
}

export function initImport(onDone) {
  const nameInput = document.getElementById('ds-name');
  const fileInput = document.getElementById('ds-file');
  const pasteInput = document.getElementById('ds-text');
  const submitBtn = document.getElementById('ds-submit');
  const result = document.getElementById('ds-result');
  const table = document.getElementById('ds-table');

  async function refresh() {
    try {
      renderTable(table, await api.listDatasets());
    } catch (err) {
      table.textContent = '';
      table.append(el('p', { class: 'bad', text: `读取资料集清单失败：${err.message}` }));
    }
  }

  submitBtn.addEventListener('click', async () => {
    const picked = fileInput.files[0];
    const text = picked ? await picked.text() : pasteInput.value;
    const datasetName = (nameInput.value.trim() || (picked ? picked.name.replace(/\.[^.]+$/, '') : '')).trim();
    result.textContent = '';

    if (!datasetName || !text.trim()) {
      result.append(el('p', { class: 'bad', text: '需要资料集名称与文本内容（选文件或粘贴文本任一即可）' }));
      return;
    }

    submitBtn.disabled = true;
    result.append(el('p', { class: 'busy', text: '解析 → 句级切片 → 本地向量化 → 写 seekdb → 就绪门槛…' }));
    try {
      const stats = await api.importDataset({ datasetName, filename: picked?.name ?? 'pasted.txt', text });
      result.textContent = '';
      result.append(el('p', { class: 'ok', text: `入库完成：${stats.datasetName}` }), statRows(stats));
      await refresh();
      onDone?.(stats.datasetName);
    } catch (err) {
      result.textContent = '';
      result.append(el('p', { class: 'bad', text: `导入失败：${err.message}` }));
    } finally {
      submitBtn.disabled = false;
    }
  });

  return { refresh };
}
