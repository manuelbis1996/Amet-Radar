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
- `supabase/migrations/*.sql` — copia versionada de las migraciones
  aplicadas por MCP (tabla `push_subscriptions`, trigger de notificaciones,
  ver "Notificaciones push" abajo). El estado real de la base es el que
  está en Supabase; estos archivos son documentación/histórico, no se
  vuelven a aplicar automáticamente.
- `supabase/functions/notify-nearby/index.ts` — Edge Function que manda
  las notificaciones push (ver "Notificaciones push" abajo).
- `netlify/edge-functions/report-preview.ts` — Edge Function (Netlify, no
  Supabase) que arma el preview dinámico por reporte para bots de
  WhatsApp/Twitter/etc. (ver "Preview dinámico por reporte" abajo).

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

## Notificaciones push por cercanía
La app avisa (aunque esté cerrada) cuando alguien publica un reporte nuevo
cerca de la última posición conocida del dispositivo — pensado para el
efecto "me salvó, se lo cuento a mis contactos" que impulsa el boca a boca
en apps de esta categoría (ver historial de decisiones).

**Flujo**: usuario toca la campana del header (`#push-toggle-btn`, oculta
si el navegador no soporta `PushManager`) → `Notification.requestPermission()`
→ `pushManager.subscribe()` → el cliente guarda la suscripción en
`public.push_subscriptions` (Supabase) → se le pregunta qué categorías le
interesan (hoja de `openPushCategoriesSheet()`, ver "Filtro por
categoría" abajo) → cuando alguien inserta un reporte nuevo, un trigger de
Postgres llama al Edge Function `notify-nearby`, que busca suscripciones
dentro de un radio **y de la categoría elegida** y les manda el push vía
`npm:web-push`. El service worker (`sw.js`) muestra la notificación
(`push`) y al tocarla enfoca/abre la app en el reporte (`notificationclick`,
reusando `openReportById` — la misma función que usa el deep link `?r=`).

- **Tabla `public.push_subscriptions`**: `endpoint text PK`, `p256dh text`,
  `auth text`, `lat/lng double precision`, `created_at`/`updated_at
  timestamptz`. RLS habilitado, **sin política de SELECT** para `anon`
  (a diferencia de `reports`) — nadie necesita leer endpoint/lat/lng de
  otro dispositivo; solo insert/update/delete abiertos. El Edge Function
  usa la `service_role` key (bypassa RLS) para leer todas las filas.
- **Importante para cualquier cambio futuro al insert desde el cliente**:
  como no hay política de SELECT, un upsert (`on_conflict` +
  `Prefer: resolution=merge-duplicates`) o cualquier `Prefer:
  return=representation` **falla con 401** ("new row violates row-level
  security policy"), porque PostgREST necesita poder "leer de vuelta" la
  fila para resolver esas variantes, y esa lectura choca con la ausencia
  deliberada de SELECT. Por eso `subscribeToPush()` en `amet-radar.html`
  hace `DELETE` (no-op si no existía) + `POST` simple, ambos con
  `Prefer: return=minimal` — no un upsert. Confirmado a mano contra la API
  real (ver verificación end-to-end); no es un supuesto teórico.
- **Trigger**: `reports_notify_nearby` (`AFTER INSERT ON public.reports`)
  llama a `net.http_post` (extensión `pg_net`, sus funciones viven en el
  schema fijo `net`, no en el schema que se le pase a `CREATE EXTENSION`)
  hacia `{SUPABASE_URL}/functions/v1/notify-nearby`, autenticado con la
  publishable/anon key del proyecto (la misma que usa el cliente — ya es
  pública, no hace falta Vault para esto). La función del trigger es
  `SECURITY DEFINER`; se le revocó `EXECUTE` a `public`/`anon`/`authenticated`
  porque si no PostgREST la expone como RPC pública (linter de seguridad lo
  marca).
- **Edge Function `notify-nearby`**: recibe el webhook, calcula un bounding
  box desde `lat/lng` del reporte (radio **2 km**, constante
  `RADIUS_METERS` en el archivo — conversión grados↔metros con
  `cos(latitud)`, no es simétrica), refina con Haversine, arma
  `title`/`body` con un mapa propio de las 4 categorías (el service worker
  no tiene acceso a `CATEGORIES`, vive en otro scope), manda el push con
  `npm:web-push`, y borra suscripciones que respondan 404/410 (expiradas).
- **Secrets del Edge Function ya configurados**: `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` se cargaron a mano en Project
  Settings → Edge Functions → Secrets (ninguna herramienta MCP conectada
  permite setearlos, así que si el proyecto se migra a otra cuenta de
  Supabase hay que repetir este paso manual). Verificado con un reporte
  real que la función ya manda el push sin el error de "vapid keys not
  configured". La llave pública vive embebida en `amet-radar.html`
  (`VAPID_PUBLIC_KEY`); la privada nunca debe vivir en el repo ni en el
  cliente.
- **Actualización de posición de la suscripción**: throttleada (solo si
  pasaron ≥5 min o el dispositivo se movió ≥400m desde el último envío),
  enganchada al callback de `watchPosition` ya existente
  (`updatePushSubscriptionPosition` dentro de `startLocationWatch`).
- **Decisiones tomadas, no reabrir sin razón**: onboarding discreto (sin
  banner/modal al abrir la app la primera vez); el autor de un reporte
  recibe su propia notificación (no se excluye); sin colapsar
  notificaciones repetidas en esta versión.
- **Filtro por categoría**: columna `categories text[]` en
  `push_subscriptions` (nullable, `NULL` = todas las categorías — así las
  filas viejas y las nuevas suscripciones sin preferencia explícita
  siguen recibiendo todo, sin backfill). El Edge Function filtra `nearby`
  por esto además del radio (ver el archivo). El cliente nunca puede leer
  su propia fila (sin política de SELECT), así que la preferencia
  "actual" vive en `localStorage` (`amet_push_categories_v1`, un array
  explícito, nunca `null`/`"all"`) — es la única fuente de verdad del
  lado del cliente.
- **La campana, en estado activo, ya NO desuscribe al toque.** Abre un
  panel de gestión (`openPushCategoriesSheet()`, reusa `renderSheet`/
  `closeOverlay`, el mismo mecanismo del flujo de reporte) con los chips
  de categoría y un botón "Desactivar avisos" adentro —
  `unsubscribeFromPush()` solo se dispara desde ahí. Cambio de
  comportamiento deliberado sobre la campana ya en producción: de paso
  corrige que antes un tap accidental desuscribía sin ninguna
  confirmación. Estado `inactive` sigue suscribiendo directo, sin cambios.
- **Gotcha al re-suscribir**: `subscribeToPush()` hace DELETE+POST (no
  upsert, ver el gotcha de arriba), así que un re-suscribe borra
  `categories` del lado del servidor aunque el dispositivo ya tenga
  preferencia guardada en `localStorage`. Por eso, después de un
  `subscribeToPush()` exitoso, se restaura la preferencia guardada
  (`updatePushCategories`) en vez de asumir "primera vez" — la hoja de
  onboarding solo se muestra si `localStorage` nunca tuvo la clave.

## Preview dinámico por reporte (Netlify Edge Function)
Cuando se comparte el link de un reporte puntual (`?r=<id>`) por WhatsApp,
Twitter, Facebook, etc., el bot que arma la tarjeta de preview recibe meta
tags específicos de ESE reporte (categoría, nota, hace cuánto se publicó)
en vez de la tarjeta genérica de la app — así el link se ve como algo real
("🚦 Control de tránsito — AMET Radar") y no como una URL pelada.

- **Archivo**: `netlify/edge-functions/report-preview.ts`. Corre en el
  runtime Deno de Netlify Edge Functions, no en Supabase — es
  infraestructura separada de los Edge Functions de Supabase (que sí
  corren en la sección "Notificaciones push" de arriba). El `path` que
  intercepta (`/` y `/amet-radar.html`) se declara con un `export const
  config` dentro del mismo archivo, no en un `netlify.toml` (Netlify
  soporta ambas formas; esta evita un archivo de config extra).
- **Cómo decide si mostrar el preview**: solo si la request tiene
  `?r=<id>` en la URL **y** el `User-Agent` matchea alguno de los bots de
  link-preview conocidos (`BOT_UA_PATTERNS` en el archivo — WhatsApp,
  Facebook, Twitter/X, LinkedIn, Slack, Telegram, Discord, Pinterest,
  Reddit). Cualquier otro caso (`context.next()`) sigue de largo a la SPA
  normal, sin latencia ni cambio de comportamiento para usuarios reales.
- **De dónde saca los datos**: llama directo a la REST API de Supabase
  (`{SUPABASE_URL}/rest/v1/reports?id=eq.<id>`) con la misma publishable
  key que usa el cliente — no hay backend propio, mismo patrón que el
  resto del proyecto.
- **Reporte ya no existe** (expiró a las 6h, o lo borró la comunidad): cae
  a `context.next()`, la SPA muestra los meta tags genéricos del `<head>`.
  No hay error visible ni para el bot ni para un usuario real.
- **Imagen OG**: reusa `icon-512.png` (card `summary`, no
  `summary_large_image`) — igual que el preview genérico. Generar una
  imagen dinámica por reporte (ej. thumbnail del mapa) quedó fuera de
  alcance a propósito, por simplicidad.
- **Verificado con `curl -A "<user-agent>"` contra producción**, no es un
  supuesto teórico: bot + reporte real → HTML con meta tags del reporte;
  bot + id inexistente → 200, cae a la SPA; navegador normal → SPA
  completa sin cambios.

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
- **Compartir y SEO social**: el botón "Compartir" de cada popup usa
  `navigator.share()` (hoja nativa del sistema) con el clipboard-copy
  anterior como fallback si el navegador no lo soporta. El `<head>` tiene
  meta tags Open Graph/Twitter Card genéricos (título/descripción de la
  app) que se ven cuando no aplica el preview dinámico por reporte (ver
  "Preview dinámico por reporte" abajo).
- **Deep link de reporte usa `?r=`, no `#r=`**: se migró de hash a query
  param porque un fragmento `#` nunca se manda al servidor — un bot de
  preview no puede verlo, así que no podía haber preview distinto por
  reporte mientras se usara hash. `openSharedReportFromUrl()` sigue
  leyendo `#r=` también como fallback (por si queda algún link viejo
  compartido con el esquema anterior), pero todo lo que genera la app
  (botón compartir, `notificationclick` del service worker) ya usa `?r=`.

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
- Se agregaron notificaciones push por cercanía y se mejoró el compartir
  (nativo + meta tags OG) como respuesta directa a "qué mejora haría que
  el proyecto se haga conocido y la gente lo use" — pasar de un modelo
  100% pull (el usuario tiene que abrir la app) a uno push (la app avisa
  sola) es la palanca de retención/boca-a-boca más fuerte para esta
  categoría de app (mismo mecanismo que Waze). Al implementarlo se
  descubrió que un upsert sobre una tabla sin política de SELECT falla en
  PostgREST (ver "Notificaciones push" arriba) — no es intuitivo a partir
  de la documentación de RLS, vale la pena recordarlo si se agregan más
  tablas con este mismo patrón de "sin SELECT para anon".
- Se migró el deep link de reporte de `#r=` a `?r=` y se agregó el Edge
  Function `report-preview` en Netlify para profundizar la palanca de
  amplificación (compartir): entre esto y un filtro de categorías para
  las notificaciones push, se priorizó el preview dinámico porque
  resuelve un problema que ya existe hoy para el 100% de los links
  compartidos, mientras que el filtro habría resuelto un problema
  hipotético (todavía no hay volumen real de suscriptores para que el
  "ruido" de notificaciones sea un dolor real).
