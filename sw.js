// sw.js — offline app-shell cache. Recording data lives in IndexedDB, NOT here.
// We cache static assets so the PWA opens without a network. Bump CACHE on
// release to invalidate. Data fetches (there are none) are never cached.
const CACHE = 'muse-recorder-v4';
const ASSETS = [
  './',
  './index.html',
  './viewer.html',
  './manifest.webmanifest',
  './css/styles.css',
  './css/viewer.css',
  './js/app.js',
  './js/recorder.js',
  './js/muse.js',
  './js/xdf-writer.js',
  './js/xdf-reader.js',
  './js/dsp.js',
  './js/viewer.js',
  './js/storage.js',
  './js/streams.js',
  './js/clock.js',
  './js/config.js',
  './js/uploader.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  // cache-first for same-origin app shell; network fallback otherwise
  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      const copy = res.clone();
      if (res.ok && new URL(request.url).origin === location.origin) {
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
