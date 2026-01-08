/* =========================================================
   IMVpedia Piano — Service Worker (Offline-first)
   - App Shell: cache-first
   - content.json: stale-while-revalidate
   - Update: versão controlada
========================================================= */

const CACHE_VERSION = 'imvpedia-piano-v1.0.0';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const APP_SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest'
];

const DATA_FILES = [
  './packs/base/imports/content.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    await cache.addAll(APP_SHELL_FILES);
    const dataCache = await caches.open(DATA_CACHE);
    await dataCache.addAll(DATA_FILES);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k !== APP_SHELL_CACHE && k !== DATA_CACHE) return caches.delete(k);
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;

  // SPA navigation: always serve index.html (hash routing)
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      const cached = await cache.match('./index.html');
      return cached || fetch(req);
    })());
    return;
  }

  // content.json -> stale-while-revalidate
  if (url.pathname.endsWith('/packs/base/imports/content.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      const cached = await cache.match(req);

      const networkPromise = fetch(req).then(async (res) => {
        // Don't cache errors
        if (res && res.ok) await cache.put(req, res.clone());
        return res;
      }).catch(() => null);

      // Return cached immediately if present
      if (cached) {
        // Revalidate in background
        event.waitUntil(networkPromise);
        return cached;
      }

      // No cache -> try network
      const net = await networkPromise;
      if (net) return net;

      // Still nothing -> fallback response
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' }
      });
    })());
    return;
  }

  // App shell: cache-first
  if (APP_SHELL_FILES.some(p => url.pathname.endsWith(p.replace('./', '/')) || url.pathname === p.replace('./', '/'))) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;

      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Default: try cache, then network
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    return fetch(req);
  })());
});

// Optional: notify clients about update availability
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
