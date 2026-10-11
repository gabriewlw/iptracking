const CACHE = 'avtrack-offline-v11';
const ASSETS = ["/", "/inventory", "/app.js", "/equipment.js", "/inventory-columns.js", "/inventory-templates.json", "/import-review.js", "/style.css", "/icon.svg", "/favicon.svg", "/example-switcher.png", "/satellite-channels.json", "/fonts/DMSans-Variable.woff2", "/fonts/SpaceGrotesk-Variable.woff2", "/fonts/JetBrainsMono-Variable.woff2", "/broadcastgab-offline", "/broadcastgab-assets/99c587af0b09e348.jpg", "/broadcastgab-assets/2509de87cd2a6ed2.jpg", "/broadcastgab-assets/0ebd30f9e4522736.css", "/broadcastgab-assets/6ec5746ae70a5add.jpg", "/broadcastgab-assets/ba325f4eda249fd8.jpg", "/broadcastgab-assets/07ba2fa083ce2a5a.png", "/broadcastgab-assets/7f20e61f42847170.jpg", "/broadcastgab-assets/54b4107511881050.png", "/broadcastgab-assets/a7c0c0521d21d16e.jpg", "/broadcastgab-assets/7d92686e34884d95.jpg", "/broadcastgab-assets/c4e483c425e2899c.jpg", "/broadcastgab-assets/cc475126aca2df87.jpg", "/broadcastgab-assets/offline.css", "/broadcastgab-assets/00122b6d34334d92.jpg", "/broadcastgab-assets/747d480b108caa00.jpg"];
const PATHS = new Set(ASSETS);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('avtrack-offline-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Inventory data and writes always go to the server; they are never cached.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !PATHS.has(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy)));
      return response;
    }
    return caches.match(url.pathname).then(cached => cached || response);
  }).catch(() => caches.match(url.pathname).then(cached => cached || new Response('Offline copy is not available. Open avtrack online once to save it.', {status:503, headers:{'Content-Type':'text/plain'}}))));
});
