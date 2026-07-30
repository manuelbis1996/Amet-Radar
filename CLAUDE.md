# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AMET Radar — Contexto del proyecto

## Qué es
App web (HTML/CSS/JS vanilla + Leaflet) de reportes comunitarios de retenes
de tránsito (AMET) en Santo Domingo. Los usuarios marcan en un mapa dónde
hay un retén, categoría, foto obligatoria y nota opcional; otros usuarios
pueden confirmar o desmentir el reporte.

## Estado actual (importante)
Los reportes se guardan en **Supabase** (proyecto `amet-radar`,
`nikexwjxxcxzhsuypsjn`, org `Amet_Radar`), tabla `public.reports` — ya no en
`localStorage` ni en un archivo del servidor. `amet-radar.html` llama
directo a la API REST de Supabase (`SUPABASE_URL`/`SUPABASE_ANON_KEY`
embebidos en el `<script>`) usando una publishable key, que está pensada
para vivir en el cliente; el control de acceso real lo hacen las políticas
RLS de la tabla (ver "Persistencia" más abajo). Cualquier dispositivo que
entre a la app ve, publica, vota y borra sobre los mismos reportes, y esto
ya **no depende de que una PC esté prendida** — es un backend real en
internet.

`server.js` (Node sin dependencias) sigue existiendo solo para servir los
archivos estáticos por `http://` en local (geolocalización, service worker
y el fetch a Supabase no funcionan sobre `file://`); ya no tiene ninguna
API de reportes ni toca `data/reports.json`.

El frontend ya está publicado en internet, no solo corriendo local: ver
"Despliegue (Netlify)" más abajo.

## Archivos
- `amet-radar.html` — toda la app (HTML + CSS + JS en un solo archivo);
  incluye las credenciales de Supabase (`SUPABASE_URL`/`SUPABASE_ANON_KEY`)
  y las llamadas REST a la tabla `reports` (ver "API de Supabase" abajo)
- `server.js` — servidor Node (sin dependencias) que solo sirve los
  archivos estáticos por `http://`; no tiene ninguna API ni toca datos de
  reportes (esos viven en Supabase, no en este servidor)
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
- `_redirects` — regla de Netlify (`/ → /amet-radar.html`, código 200,
  rewrite no redirect) para que la raíz del sitio sirva la app; sin esto
  Netlify devuelve 404 en `/` porque no hay `index.html`. Solo lo lee
  Netlify; `server.js` ya maneja este mismo caso con su propia lógica
  (`pathname === '/' → amet-radar.html`) así que en local no hace falta.

## Cómo correrlo
Requiere Node.js instalado y servirse por `http://` (no abrir con doble
clic / `file://`), porque geolocalización, el service worker y el fetch a
Supabase no funcionan sobre `file://`.

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

## API de Supabase (proyecto `amet-radar`, `nikexwjxxcxzhsuypsjn`)
El cliente (`amet-radar.html`) llama directo a la API REST autogenerada de
Supabase (PostgREST) sobre la tabla `public.reports`, con la publishable
key embebida en el `<script>` — no hay backend propio de por medio.
- `GET  {SUPABASE_URL}/rest/v1/reports?select=*` — todas las filas.
- `POST {SUPABASE_URL}/rest/v1/reports` — body `{ id, ...record }`, inserta
  una fila.
- `PATCH {SUPABASE_URL}/rest/v1/reports?id=eq.<id>` — body con campos a
  mezclar (`confirms`/`denies`).
- `DELETE {SUPABASE_URL}/rest/v1/reports?id=eq.<id>` — borra la fila.
- Headers en todas las llamadas: `apikey` y `Authorization: Bearer
  <SUPABASE_ANON_KEY>`.
- Esquema de `reports`: `id text PK`, `lat/lng double precision`,
  `photo text` (nullable), `note text`, `ts bigint` (epoch ms), `category
  text` (check contra las 4 categorías), `confirms/denies integer`, `approx
  boolean`, `created_at timestamptz`.
- RLS habilitado con políticas abiertas (`USING (true)`) para
  select/insert/update/delete — no hay autenticación de usuarios en la app,
  así que es equivalente al CORS abierto que tenía antes `server.js`; el
  linter de Supabase marca esto como warning esperado, no como bug.
- `server.js` ya no expone ninguna ruta `/api/*`.

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
- **Persistencia**: los reportes viven en la tabla `reports` de Supabase
  (Postgres), no en `server.js` ni en un archivo. El cliente mantiene una
  copia en memoria (`reportsCache`) que refresca cada 8s vía `fetch` a la
  REST API de Supabase (`refreshReports()` en el `<script>` de
  `amet-radar.html`), y sigue trayendo el objeto completo `{ [id]: record }`
  en cada refresco (no incremental) — mismo principio de antes de evitar
  N+1 llamadas.
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

## Despliegue (Netlify)
El frontend está publicado en **Netlify**, cuenta del dueño del proyecto
(`manuelbis1996@gmail.com`, team `manuelbis1996`, plan Free).
- **URL pública**: https://amet-radar.netlify.app
- **Site ID**: `8958378d-0be4-42bb-ab5c-4ba7e3181dd8` (nombre del sitio:
  `amet-radar`)
- **No está conectado al repo de GitHub** — no hay auto-deploy en cada
  push. Cada deploy es manual, subiendo el contenido de la carpeta del
  proyecto tal cual (sin build step, coincide 1:1 con lo que hay en git).
  Para redesplegar tras un cambio: usar el MCP de Netlify (herramienta
  `netlify-deploy-services-updater`, operación `deploy-site` con ese
  `siteId`) o, equivalente en CLI, `npx -y netlify-cli deploy --prod
  --site 8958378d-0be4-42bb-ab5c-4ba7e3181dd8 --dir .` desde la raíz del
  proyecto.
- **Control de acceso**: los proyectos nuevos de Netlify vienen con
  "team protection" (SSO login) activado por defecto, lo que bloquea a
  cualquier visitante público — se desactivó explícitamente
  (`requireSSOTeamLogin: false`) porque esta es una app pública sin
  autenticación de usuarios.
- **`_redirects`**: necesario para que `/` sirva `amet-radar.html` (ver
  "Archivos" arriba) — sin este archivo Netlify tira 404 en la raíz.
- **Pendiente, no bloqueante**: conectar el repo de GitHub desde Netlify
  (`Site settings → Build & deploy → Link repository`) para que cada push
  a la rama correspondiente dispare un deploy automático — requiere que el
  dueño autorice el link con GitHub desde la UI de Netlify, no se puede
  hacer por API/MCP.

Mejoras posteriores, no bloqueantes: reemplazar las políticas RLS abiertas
de Supabase por algo más restrictivo si se agrega autenticación, y mover
las fotos (hoy base64 en la columna `photo`) a Supabase Storage si el
tamaño de las filas se vuelve un problema.

## Historial relevante de decisiones (por si se pregunta "por qué así")
- Se partió de una versión anterior que usaba `window.storage` (API propia
  del entorno de artifacts de Claude.ai) — se reemplazó por `localStorage`
  porque el proyecto se está probando fuera de ese entorno.
- Se priorizó reducir llamadas de red/almacenamiento agrupando datos en
  una sola clave en vez de una clave por reporte.
- Se agregaron categorías porque el diseño original solo tenía un ícono fijo.
- Se migró la persistencia de `server.js` + `data/reports.json` a Supabase
  (proyecto `amet-radar`, org `Amet_Radar`) para dejar de depender de que
  una PC específica esté prendida y alcanzable; `server.js` quedó reducido
  a servidor de archivos estático para desarrollo local.
- Se publicó el frontend en Netlify (sitio `amet-radar`) en vez de GitHub
  Pages porque el MCP de Netlify estaba disponible en el entorno y permitió
  hacerlo sin salir del flujo; no hay razón técnica fuerte para preferir
  uno sobre otro en este proyecto (ambos son hosting estático gratuito).
