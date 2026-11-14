// Keeps a copy of Glass Phone on the phone so it opens instantly (and without a
// connection). A new version is downloaded in the background and switched to
// when you tap "Restart" in the app.
const VERSION = "1.4.0-a04d38130b";
const FILES = ["./","api-web.js","app.js","icon.png","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","manifest.webmanifest","mobile.css","mobile.js","motion.css","motion.js","recorder-worklet.js","styles.css","twilio.min.js"];
const CACHE = 'glass-phone-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('glass-phone-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.endsWith('/version.json')) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const page = await c.match('./');
        if (page) return page;
      }
      return fetch(req);
    })
  );
});
