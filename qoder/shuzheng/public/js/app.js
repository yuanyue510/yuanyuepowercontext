import './ui/tabs.js';
import { api } from './api.js';
import { initImport } from './views/import.js';
import { initSearch } from './views/search.js';
import { initReview } from './views/review.js';

const badge = document.getElementById('health-badge');
const json = document.getElementById('health-json');

const search = initSearch();
const importer = initImport(() => search.refreshDatasets());
const review = initReview();

async function refreshHealth() {
  try {
    const data = await api.health();
    const seekdb = data.seekdb.portOpen ? `seekdb ${data.seekdb.endpoint} 已连通` : 'seekdb 未连通';
    const model = data.offline.modelPresent ? '本地模型在位' : '本地模型缺失';
    badge.textContent = `离线运行 · ${seekdb} · ${model}`;
    badge.className = `badge ${data.seekdb.portOpen && data.offline.modelPresent ? 'ok' : 'bad'}`;
    json.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    badge.textContent = `服务不可用：${err.message}`;
    badge.className = 'badge bad';
  }
}

window.addEventListener('view:shown', (e) => {
  if (e.detail.view === 'search') search.refreshDatasets();
  if (e.detail.view === 'import') importer.refresh();
  if (e.detail.view === 'status') refreshHealth();
  if (e.detail.view === 'review') review.open();
});

await refreshHealth();
importer.refresh();
