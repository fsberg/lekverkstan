// Lekverkstan service worker: appen och kortbilder finns kvar utan nät.
// Appens egna filer hämtas alltid från nätet först (så att uppdateringar syns direkt),
// bibliotek och kortbilder tas från cachen först.
const APP = 'lv-app-1', LIB = 'lv-lib-1', IMG = 'lv-img-1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'backend.js', 'config.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => ![APP, LIB, IMG].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}
async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); if (max) trim(cache, max); }
  return res;
}
async function networkFirst(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.includes('/api/')) return; // lokala serverns api
    e.respondWith(networkFirst(req));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(cacheFirst(req, LIB));
  } else if (url.hostname === 'cards.scryfall.io') {
    e.respondWith(cacheFirst(req, IMG, 400));
  }
});
