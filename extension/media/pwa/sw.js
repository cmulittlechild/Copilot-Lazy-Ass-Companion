const CACHE = 'sidecar-pwa-v19';
const ASSETS = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const path = url.pathname || '/';
  // Always network-first for app shell JS/CSS so fixes are not stuck behind SW cache.
  const networkFirst = path === '/app.js' || path === '/styles.css' || path === '/sw.js' || path.endsWith('/app.js') || path.endsWith('/styles.css');
  if (networkFirst) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('/index.html'))),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => caches.match('/index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }
  const title = data.title || 'Copilot Lazy Ass';
  const options = {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'copilot-lazy-ass',
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const visible = list.some((c) => c.visibilityState === 'visible');
      if (visible) return;
      return self.registration.showNotification(title, options);
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          try {
            if (client.url && client.url.includes(self.location.origin)) return client.focus();
          } catch {
            /* ignore */
          }
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});
