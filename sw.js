// Keep the legacy prefix so each hosted path can clean up its earlier caches.
const CACHE_PREFIX = `still-${encodeURIComponent(self.registration.scope)}-`;
const CACHE_NAME = `${CACHE_PREFIX}f588e1ffcf0d`;
const APP_SHELL = [
  './index.html',
  './styles.css',
  './js/app.js',
  './js/main.js',
  './js/offline-support.js',
  './js/duration-picker.js',
  './js/preset-tiles.js',
  './js/phase-labels.js',
  './js/session-view.js',
  './js/install-prompt.js',
  './js/reset-confirmation.js',
  './js/outside-dismissal.js',
  './js/preset-delete-confirmation.js',
  './js/viewport-layout.js',
  './js/section-scroller.js',
  './js/preset-editor.js',
  './js/session-driver.js',
  './js/phase-cues.js',
  './js/zen-navigator.js',
  './js/wake-lock-guard.js',
  './js/breathing-engine.js',
  './js/preset-store.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  // A new shell must not inherit stale bytes from the browser's HTTP cache.
  const requests = APP_SHELL.map((path) => new Request(new URL(path, self.registration.scope), { cache: 'reload' }));
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(requests);
    // Activate only after the complete new version is available offline.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const previousVersions = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    await Promise.all(previousVersions.map((key) => caches.delete(key)));
    await self.clients.claim();
    if (previousVersions.length) {
      // Each page decides when it is safe to reload. Legacy clients use the
      // complete new shell on their next launch without losing a session.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.postMessage({ type: 'APP_UPDATED' });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Serve HTML and assets from the same installed app version.
    const appRoot = new URL(self.registration.scope);
    const index = new URL('./index.html', appRoot);
    const isAppNavigation = request.mode === 'navigate'
      && (url.pathname === appRoot.pathname || url.pathname === index.pathname);
    const key = isAppNavigation ? index : request;
    const cached = await cache.match(key);
    return cached || fetch(request);
  })());
});
