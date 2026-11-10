async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  health: () => request('GET', '/api/health'),
  listDatasets: () => request('GET', '/api/dataset/list').then((r) => r.datasets),
  importDataset: (payload) => request('POST', '/api/dataset/import', payload),
  datasetText: (name) => request('GET', `/api/dataset/${encodeURIComponent(name)}/text`),
  search: (payload) => request('POST', '/api/search', payload),
  reviewList: ({ dataset, limit } = {}) =>
    request('GET', `/api/review?${new URLSearchParams({ ...(dataset ? { dataset } : {}), limit })}`),
  reviewState: (id, status) => request('POST', `/api/review/${encodeURIComponent(id)}/state`, { status }),
};

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue; // setAttribute('disabled', null) 会得到 "null"，反而等于禁用
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const fmt = (n) => (n == null ? '—' : String(n));
