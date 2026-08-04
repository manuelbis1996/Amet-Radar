const CACHE_NAME = 'amet-radar-v15.0';
const APP_SHELL = [
  './amet-radar.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cachear de a uno tolerando fallos, NO con addAll. addAll es atómico:
      // si un solo archivo falla, todo el install falla, el service worker
      // nuevo nunca llega a instalarse y el viejo se queda activo para
      // siempre — deja de tomar cualquier actualización futura. Eso fue
      // exactamente lo que pasó al migrar a Cloudflare (ver el bug de v9.8
      // en CLAUDE.md): el 307 de /amet-radar.html rompía el addAll y los
      // dispositivos ya instalados quedaron congelados en la versión vieja,
      // sin forma de recuperarse solos. Con este patrón, un archivo que
      // falle degrada el offline de ese archivo nomás, no bloquea el update.
      Promise.all(APP_SHELL.map((path) => cache.add(path).catch(() => {})))
    )
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

  // Si no hay nada en caché (ej. justo después de "Agregar a pantalla de
  // inicio", antes de que termine el install) y el fetch a la red falla,
  // NUNCA hay que resolver a `cached` (undefined en ese caso) — respondWith
  // con un valor que no es un Response hace que Chrome tire net::ERR_FAILED
  // ("No se puede acceder a este sitio") en vez de reintentar o mostrar un
  // error entendible.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(
        () => new Response('Sin conexión. Probá de nuevo cuando tengas señal.', {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        })
      );
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
