const CACHE_NAME = 'amet-radar-v9.2';
const APP_SHELL = [
  './amet-radar.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first para el app shell; deja pasar todo lo demás (mapas, tiles) a la red.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAppShell = APP_SHELL.some((path) => url.pathname.endsWith(path.replace('./', '')));
  if (!isAppShell) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => cached);
    })
  );
});

// Notificaciones push de reportes cercanos (ver notify-nearby en Supabase).
// El payload ya viene armado con title/body listos — el SW no conoce
// CATEGORIES (vive en otro scope), así que no arma texto acá, solo lo muestra.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'AMET Radar';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'Hay un reporte nuevo cerca de tu ubicación.',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { id: data.id }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) {
          client.focus();
          if (id) client.postMessage({ type: 'open-report', id });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(id ? `./amet-radar.html?r=${encodeURIComponent(id)}` : './amet-radar.html');
      }
    })
  );
});
