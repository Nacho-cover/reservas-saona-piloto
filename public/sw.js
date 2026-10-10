const CACHE = 'reservas-v5';
const ASSETS = ['/', '/style.css', '/app.js', '/manifest.json', '/icons/saona-logo.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Red primero (y se guarda copia) para que un cambio de diseño se vea a la primera;
// la caché solo se usa sin conexión. Las llamadas a /api/ nunca se cachean.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.url.includes('/api/') || !req.url.startsWith(self.location.origin)) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
