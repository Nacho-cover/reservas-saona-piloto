const CACHE = 'reservas-v3';
const ASSETS = ['/', '/style.css', '/app.js', '/manifest.json'];

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

self.addEventListener('fetch', (event) => {
  // Network-first for API calls, cache-first for static assets.
  if (event.request.url.includes('/api/')) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
