/* Quantra AI — service worker: offline app-shell + web-push */
const CACHE = 'quantra-v10';
const SHELL = [
  '/', '/index.html', '/discover.html', '/portfolio.html', '/calendar.html',
  '/styles.css?v=29', '/analysis.js', '/auth.js', '/terminal.js', '/pwa.js',
  '/assets/brand/quantra-icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // leave cross-origin to the network
  if (url.pathname.startsWith('/api/')) return;        // never cache API responses
  // documents: network-first (always fresh online), fall back to cache offline
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then((m) => m || caches.match('/index.html')))
    );
    return;
  }
  // static assets (versioned): cache-first
  e.respondWith(
    caches.match(req).then((m) => m || fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
      return r;
    }).catch(() => m))
  );
});

self.addEventListener('push', (e) => {
  let data = {}; try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(data.title || 'Quantra AI', {
    body: data.body || '', icon: '/assets/brand/quantra-icon.svg', badge: '/assets/brand/quantra-icon.svg',
    tag: data.tag || 'quantra-alert', data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if ('focus' in w) { w.navigate && w.navigate(url); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
