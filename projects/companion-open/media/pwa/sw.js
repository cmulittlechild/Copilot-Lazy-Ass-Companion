const CACHE = 'sidecar-pwa-v42';
const ASSETS = [
  '/app.js',
  '/styles.css',
  '/codicon.css',
  '/codicon.ttf',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/vendor/marked.min.js',
  '/vendor/highlight.min.js',
  '/vendor/vs2015.min.css',
];

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
  // Always network-first for HTML, app JS/CSS and SW so PWA updates are not permanently stuck behind cache.
  const networkFirst =
    path === '/' ||
    path === '/index.html' ||
    path.endsWith('/index.html') ||
    path === '/app.js' ||
    path === '/styles.css' ||
    path === '/sw.js' ||
    path.endsWith('/app.js') ||
    path.endsWith('/styles.css') ||
    path.startsWith('/vendor/');
  // 缓存键使用裸路径（剥离 ?token= 等查询串），避免 token 持久化进 Cache Storage。
  const barePath = path === '/' ? '/index.html' : path;
  if (networkFirst) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(barePath, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(barePath).then((c) => c || caches.match('/index.html'))),
    );
    return;
  }
  event.respondWith(
    caches
      .match(req)
      .then((cached) => cached || caches.match(barePath))
      .then((c) => c || fetch(req).catch(() => caches.match('/index.html'))),
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
