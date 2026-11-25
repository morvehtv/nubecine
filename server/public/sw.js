// Service worker mínimo: permite instalar la web como app. No guarda vídeos en caché.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
