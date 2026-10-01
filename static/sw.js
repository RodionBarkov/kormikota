// Сервис-воркер: даёт установить приложение на телефон и открывать список в магазине без связи.
const SHELL = 'kormikota-shell-v1';
const PHOTOS = 'kormikota-photos-v1';
const SHELL_FILES = ['/', '/static/style.css', '/static/app.js', '/manifest.webmanifest', '/static/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== PHOTOS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(PHOTOS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/photos/')) return e.respondWith(cacheFirst(req));
  if (url.pathname === '/api/state') return e.respondWith(networkFirst(req));
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(networkFirst(req));
});
