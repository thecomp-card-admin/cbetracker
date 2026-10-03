// sw.js — offline cache. Bump VERSION on every deploy so phones pick up the new files on next launch.
const VERSION = 'cbe-v1.0.0';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'logic.js',
  'store.js',
  'routine.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'tests.html',
  'tests.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' skips the HTTP cache so a fresh deploy never caches stale files
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cbe-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      // tell open pages a new version took over (queued until the page starts listening)
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => clients.forEach((c) => c.postMessage({ type: 'sw-activated', version: VERSION }))),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || fetch(req).catch(() => caches.match('index.html'))),
    );
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
