const CACHE_NAME = 'fund-ai-v57';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/providers.js',
  './js/chat.js',
  './js/holdings.js',
  './js/overview.js',
  './js/compare.js',
  './js/qdii.js',
  './js/briefing.js',
  './js/settings.js',
  './js/utils.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.matchAll()).then(clients => {
      clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 外部请求不拦截
  if (url.origin !== location.origin) return;
  // network-first，但确保永远不返回 null
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp && resp.status === 200) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(() =>
      caches.match(e.request).then(r => r || caches.match('./index.html')).then(r => r || new Response('离线且无缓存，请刷新页面', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }))
    )
  );
});
