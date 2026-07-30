# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AMET Radar — Contexto del proyecto

## Qué es
App web (HTML/CSS/JS vanilla + Leaflet) de reportes comunitarios de retenes
de tránsito (AMET) en Santo Domingo. Los usuarios marcan en un mapa dónde
hay un retén, categoría, foto obligatoria y nota opcional; otros usuarios
pueden confirmar o desmentir el reporte.

## Estado actual (importante)
Los reportes ahora se guardan en un **servidor local compartido**
(`server.js`, Node sin dependencias externas), en `data/reports.json` —
ya no en `localStorage` del navegador. Cualquier dispositivo que entre a la
misma URL (misma red Wi-Fi, o un túnel HTTPS apuntando al mismo servidor)
ve, publica, vota y borra sobre los mismos reportes. Sigue sin ser un
backend desplegado en internet: mientras `server.js` no corra en un hosting
real, solo funciona mientras la PC que lo ejecuta esté prendida y
alcanzable — ese es el bloqueante #1 antes de lanzar a producción real
(ver sección "Pendiente" más abajo).

## Archivos
- `amet-radar.html` — toda la app (HTML + CSS + JS en un solo archivo)
- `server.js` — servidor Node (sin dependencias) que sirve los archivos
  estáticos y expone `/api/reports` (GET/POST/PATCH/DELETE) respaldado por
  `data/reports.json`; reemplaza a un simple servidor de archivos estático
- `manifest.json` — manifest de PWA
- `sw.js` — service worker (cache-first del app shell); subir `CACHE_NAME`
  al cambiar `amet-radar.html`/`manifest.json`/íconos para forzar que los
  clientes con la PWA instalada bajen la versión nueva. Subir junto con
  `CACHE_NAME` la constante `APP_VERSION` al inicio del `<script>` de
  `amet-radar.html` (mismo sufijo, formato `vMAYOR.MENOR` ej. `v4.0`) — se
  muestra en el header junto a "Reportes de la comunidad" para poder
  confirmar a simple vista, sin devtools, que una PWA instalada ya tomó la
  versión nueva. Subir el decimal (`v4.0` → `v4.1`) para cambios chicos
  (ajustes, fixes) y el entero (`v4.1` → `v5.0`) para cambios grandes
  (rediseños, features nuevas).
- `icon-192.png`, `icon-512.png` — íconos de la PWA
- `README.md` — cómo correr el proyecto localmente y qué mejoras de la
  lista ya están implementadas para la prueba local
- `plan-mejora-amet-radar.md` — plan de mejoras original (por prioridad
  🔴/🟡/🟢) que dio origen a las decisiones de arquitectura de abajo; incluye
  el orden sugerido de implementación y el estado de qué falta
- `data/reports.json` — datos en tiempo de ejecución (gitignored, no es
  código fuente; arranca vacío en una PC nueva)

## Cómo correrlo
Requiere Node.js instalado y servirse por `http://` (no abrir con doble
clic / `file://`), porque geolocalización, el service worker y la API de
reportes no funcionan sobre `file://`.

```bash
cd carpeta-del-proyecto
node server.js
```
Abrir `http://localhost:8000/amet-radar.html`.

Para probar desde el móvil necesitas HTTPS (o el flag de Chrome
`unsafely-treat-insecure-origin-as-secure`) porque la Geolocation API exige
contexto seguro — por IP de red simple (`http://192.168.x.x`) los navegadores
móviles la bloquean. Un túnel rápido tipo `npx localtunnel --port 8000`
resuelve esto sin desplegar nada.

No hay build step, linter, ni suite de tests — es HTML/CSS/JS servido tal
cual y un servidor Node sin dependencias. Verificar cambios corriendo
`node server.js` y probando manualmente en el navegador en
`http://localhost:8000/amet-radar.html`.

## API de `server.js`
Puerto por `process.env.PORT` (default `8000`), escucha en `0.0.0.0`. Los
reportes viven en un solo objeto `{ [id]: record }` dentro de
`data/reports.json`.
- `GET /api/reports` — devuelve el objeto completo de reportes.
- `POST /api/reports` — body `{ id, record }`; hace `all[id] = record`.
- `PATCH /api/reports/:id` — body con campos a mezclar (`Object.assign`);
  404 si el id no existe.
- `DELETE /api/reports/:id` — borra la entrada (sin error si no existía).
- CORS abierto (`Access-Control-Allow-Origin: *`) para poder servir el
  frontend desde un túnel/IP distinta del propio `server.js`.
- Cualquier otra ruta se sirve como archivo estático desde la raíz del
  proyecto (`/` → `amet-radar.html`).

## Decisiones de arquitectura ya tomadas
- **Categorías de reporte**: `reten_fijo`, `reten_movil`, `accidente`, `control`
  (objeto `CATEGORIES` dentro del `<script>`, con emoji y color cada una).
- **Modelo de datos por reporte**:
  ```js
  { lat, lng, photo, note, ts, category, confirms, denies, approx }
  ```
  `photo` es `null` y `note` es `''` en un reporte rápido; `approx: true`
  marca que `lat`/`lng` no son la posición exacta del usuario (ver "Reporte
  rápido" abajo).
- **Reporte rápido (sin foto, para cuando el usuario va manejando)**: botón
  "Reportar ubicación" ahora primero pregunta el modo (`askReportMode` en
  el `<script>`). El modo rápido (`startQuickReport`/`askForCategoryQuick`/
  `publishQuickReport`) salta la selección manual del punto en el mapa, la
  foto obligatoria y la nota: toma `lastKnownLatLng` (del `watchPosition`
  ya activo), le aplica un `jitterLocation()` pequeño (0–30 m) solo para
  variar el centro, y publica en cuanto se toca una categoría. El modo
  detallado existente (`startManualPick` → `askForCategory` → foto →
  confirmación) no cambió.
- **Renderizado del reporte rápido como círculo, no pin**: los reportes con
  `approx: true` no se dibujan con `L.marker`/`makeIcon` como los demás —
  `upsertMarker` los desvía a `upsertApproxCircle`, que dibuja un
  `L.circle` de radio `APPROX_RADIUS_METERS` (150 m) centrado en el punto.
  La idea es comunicar "está en algún punto dentro de esta zona", no un
  punto marcado con precisión falsa. `markersById[id]` puede ser un
  `L.marker` o un `L.circle` según el reporte; ambos comparten la API que
  usa el resto del código (`bindPopup`, `setPopupContent`, `setLatLng`,
  `map.removeLayer`), así que `removeMarker`/`renderVisibleMarkers` no
  necesitaron cambios. Los colores de categoría tienen ahora un campo
  `hex` además de `color` (`var(--nombre)`) porque el renderer SVG de
  Leaflet necesita un valor de color plano para el círculo.
- **Persistencia**: `server.js` guarda todos los reportes en un único
  archivo `data/reports.json` (mismo principio que antes de evitar N+1: una
  sola lectura/escritura del set completo en vez de una llamada por
  reporte). El cliente mantiene una copia en memoria (`reportsCache`) que
  refresca cada 8s vía `fetch('/api/reports')` (`refreshReports()` en el
  `<script>` de `amet-radar.html`).
- **Preferencias por dispositivo**: qué reportes son "míos"
  (`amet_my_reports_v1`), en cuáles ya voté (`amet_voted_v1`) y el
  historial de anti-spam (`amet_report_times_v1`) siguen en `localStorage`
  del navegador — son intencionalmente locales, no se comparten.
- **Confirmación comunitaria**: si `denies - confirms >= 2` el reporte se
  borra automáticamente.
- **Filtrado por zona visible**: los marcadores solo se dibujan si están
  dentro del `bounds` actual del mapa (recalculado en `moveend`/`zoomend`).
- **Mi ubicación**: `navigator.geolocation.watchPosition` centra el mapa en
  el primer fix y mantiene un marcador azul (`meMarker`) actualizado.
- **Mapa**: tiles claros de CartoDB Positron (`light_all`); antes eran los
  oscuros (`dark_all`) a juego con el resto de la UI, se cambió a pedido.

## Pendiente (siguiente paso lógico, bloqueante para producción real)
Desplegar `server.js` en un hosting real (Render, Railway, Fly.io, una VPS,
etc.) con un dominio estable, en vez de correrlo en la PC de quien lo
prueba. El almacenamiento en un archivo JSON plano también es un límite de
esta prueba — para producción real conviene migrar `data/reports.json` a
una base de datos real (Postgres/Supabase, SQLite, etc.) y las fotos a un
bucket en vez de base64 en el JSON. La lógica de negocio (categorías,
votos, filtrado por zona, anti-spam) no debería necesitar cambios grandes
al migrar — solo el punto de persistencia y el hosting.

## Historial relevante de decisiones (por si se pregunta "por qué así")
- Se partió de una versión anterior que usaba `window.storage` (API propia
  del entorno de artifacts de Claude.ai) — se reemplazó por `localStorage`
  porque el proyecto se está probando fuera de ese entorno.
- Se priorizó reducir llamadas de red/almacenamiento agrupando datos en
  una sola clave en vez de una clave por reporte.
- Se agregaron categorías porque el diseño original solo tenía un ícono fijo.
