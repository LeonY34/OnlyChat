// Minimal service worker: exists so Chrome treats OnlyChat as an installable PWA.
// It does not cache anything, so chat and API traffic always goes to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
