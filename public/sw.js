'use strict';
// Service worker: keeps the app shell available offline.
// Strategy: API calls always go to the network (never cached); everything else is
// network-first with a cache fallback, so a new deploy is picked up immediately
// and the app still opens without a connection.
const CACHE = 'lap-shell';
const SHELL = ['/', '/style.css', '/i18n.js', '/i18n-push.js', '/core.js', '/student.js', '/staff.js', '/admin.js', '/push.js', '/main.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---- Web Push ----
// Every push is shown: browsers cancel the subscription of a site that receives pushes without showing anything.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const text = (v) => (typeof v === 'string' ? v : '');
  event.waitUntil(self.registration.showNotification(text(data.title) || 'LAP Rewards', {
    body: text(data.body),
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: text(data.tag) || undefined,
    data: { url: text(data.url) || '/' },
  }));
});

// Tapping a notification brings the app forward (opening it if needed) at the page the message is about.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      try {
        await open.focus();
        if ('navigate' in open) await open.navigate(target.href);
        return;
      } catch { /* fall through and open a new window */ }
    }
    await self.clients.openWindow(target.href);
  })());
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
