// ===== trend-store.js — 数据缓存（localStorage）=====

export function getCached(key) {
  try {
    const raw = localStorage.getItem('trend_' + key);
    if (!raw) return null;
    return JSON.parse(raw).data;
  } catch { return null; }
}

export function setCache(key, data) {
  try {
    localStorage.setItem('trend_' + key, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* ignore */ }
}
