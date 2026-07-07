// CoolDrive service worker — network-first (always fresh when online, offline-capable).
// Network-first avoids serving stale modules during development while still letting
// the game work with no connection after the first visit.
const CACHE = 'cooldrive-v6';
const CORE = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-180.png',
  './vendor/fonts/chakra-petch-600.woff2', './vendor/fonts/chakra-petch-700.woff2',
  './vendor/es-module-shims.js',
  './vendor/three/build/three.module.min.js',
  './vendor/three/examples/jsm/loaders/GLTFLoader.js',
  './vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  './src/config.js', './src/physics.js', './src/scene.js', './src/car.js', './src/world.js',
  './src/input.js', './src/camera.js', './src/effects.js', './src/scoring.js',
  './src/audio.js', './src/achievements.js', './src/hud.js', './src/main.js',
  './src/rand.js', './src/worldgen.js', './src/chunks.js',
  './src/haptics.js', './src/trials.js', './src/weather.js',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return; // let audio range requests stream
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // ignore cross-origin
  // Vendored libs + fonts are immutable (versioned by CACHE) — serve them CACHE-FIRST so the big
  // three.js bundle isn't re-downloaded + re-cached on every load mid-session. A CACHE bump (above)
  // invalidates them on a real update. Everything else stays network-first (fresh in dev).
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    })));
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
