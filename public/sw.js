'use strict';
// Service worker: keeps the app shell available offline.
// Strategy: API calls always go to the network (never cached); everything else is
// network-first with a cache fallback, so a new deploy is picked up immediately
// and the app still opens without a connection.
const CACHE = 'lap-shell';
const SHELL = ['/', '/style.css', '/i18n.js', '/core.js', '/student.js', '/staff.js', '/admin.js', '/main.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req.mode === 'navigate' ? '/' : req, res.clone());
      return res;
    } catch {
      const hit = (await cache.match(req.mode === 'navigate' ? '/' : req)) || (await cache.match('/'));
      return hit || new Response('You are offline.', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
  })());
});
