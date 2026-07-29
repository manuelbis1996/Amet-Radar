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
  clientes con la PWA instalada bajen la versión nueva
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

## Decisiones de arquitectura ya tomadas
- **Categorías de reporte**: `reten_fijo`, `reten_movil`, `accidente`, `control`
  (objeto `CATEGORIES` dentro del `<script>`, con emoji y color cada una).
- **Modelo de datos por reporte**:
  ```js
  { lat, lng, photo, note, ts, category, confirms, denies }
  ```
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
