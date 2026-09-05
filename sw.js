/* Service worker mínimo: cachea el shell para que abra rápido y offline muestre algo.
   Nunca cachea llamadas a Supabase — los datos siempre van a la red. */
const CACHE = 'solose-workflow-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './config.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('.supabase.co') || url.protocol === 'wss:') return;

  // Network-first: si hay red, siempre la versión fresca; si no, lo cacheado.
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (url.origin === location.origin && r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
