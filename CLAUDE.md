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
"Despliegue (Cloudflare Workers)" más abajo.

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
- `_worker.js`, `wrangler.jsonc`, `.assetsignore` — despliegue en
  Cloudflare Workers (ver "Despliegue" abajo): sirve los assets estáticos
  y el preview dinámico por reporte desde un solo Worker, sin build step.
  `server.js` ya maneja el caso de `/` → `amet-radar.html` con su propia
  lógica para correr en local, así que ahí no hace falta nada extra.
- `supabase/migrations/*.sql` — copia versionada de las migraciones
  aplicadas por MCP (tabla `push_subscriptions`, trigger de notificaciones,
  ver "Notificaciones push" abajo), más `20260729230000_reports_genesis.sql`
  (la tabla `reports`, reconstruida retroactivamente — ver "Reconstruir la
  base de datos desde cero" más abajo). El estado real de la base es el
  que está en Supabase; estos archivos son documentación/histórico, no se
  vuelven a aplicar automáticamente.
- `supabase/functions/notify-nearby/index.ts` — Edge Function que manda
  las notificaciones push (ver "Notificaciones push" abajo).
- `supabase/functions/admin-login/index.ts` — Edge Function que valida el
  password del panel admin (ver "Panel de administración" abajo).
- `admin.html` — panel de administración (moderar reportes, ver
  estadísticas, editar parámetros del sistema), sin backend propio — le
  pega directo a Supabase igual que `amet-radar.html` (ver "Panel de
  administración" abajo).

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
- **`photo` guarda una URL, no base64**: bucket público `report-photos` en
  Supabase Storage, archivo `<id-del-reporte>.jpg`. `uploadPhoto()` en
  `amet-radar.html` sube la foto comprimida (`compressImage()`, sigue
  produciendo un `data:` URL igual que antes) y guarda la URL pública
  (`{SUPABASE_URL}/storage/v1/object/public/report-photos/<id>.jpg`) en
  vez del base64 completo — antes cada fila cargaba la imagen entera y
  `GET .../reports?select=*` la traía completa en cada refresh de 8s, para
  todos los reportes activos. `deleteReportRemote()`
  (`amet-radar.html`)/`deleteReport()` (`admin.html`) borran la foto del
  bucket al borrar el reporte (best-effort, `deletePhoto()`, no bloquea el
  borrado si falla). Bucket con políticas abiertas de insert/delete para
  `anon` en `storage.objects` (mismo criterio que `reports`), sin política
  de select — un bucket `public` sirve sus objetos vía
  `/object/public/<bucket>/<path>` sin pasar por RLS. Las filas existentes
  con foto en base64 (de antes de esta migración) no se reprocesaron —
  siguen renderizando igual, un `data:` URL y una URL de Storage son
  ambos valores válidos de `<img src>`. La cola offline
  (`amet_pending_queue_v1`) sigue guardando el base64 en `localStorage`
  hasta que hay red — recién en `flushPendingQueue()` se sube a Storage
  (detectado por el prefijo `data:` en `record.photo`, para no
  re-subir si ya se subió en un intento previo).

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

## Preview dinámico por reporte (Cloudflare Worker)
Cuando se comparte el link de un reporte puntual (`?r=<id>`) por WhatsApp,
Twitter, Facebook, etc., el bot que arma la tarjeta de preview recibe meta
tags específicos de ESE reporte (categoría, nota, hace cuánto se publicó)
en vez de la tarjeta genérica de la app — así el link se ve como algo real
("🚦 Control de tránsito — AMET Radar") y no como una URL pelada.

- **Archivo**: `_worker.js` (raíz del repo). Corre en el runtime de
  Cloudflare Workers, no en Supabase — es infraestructura separada de los
  Edge Functions de Supabase (que sí corren en la sección "Notificaciones
  push" de arriba). Antes vivía en `netlify/edge-functions/report-preview.ts`
  (Netlify Edge Functions, Deno) — se portó 1:1 a Workers al migrar el
  hosting (ver "Despliegue" abajo), mismo comportamiento verificado.
- **Cómo decide si mostrar el preview**: solo si la request tiene
  `?r=<id>` en la URL **y** el `User-Agent` matchea alguno de los bots de
  link-preview conocidos (`BOT_UA_PATTERNS` en el archivo — WhatsApp,
  Facebook, Twitter/X, LinkedIn, Slack, Telegram, Discord, Pinterest,
  Reddit). Cualquier otro caso cae a `env.ASSETS.fetch(request)`, sigue de
  largo a la SPA normal, sin latencia ni cambio de comportamiento para
  usuarios reales.
- **De dónde saca los datos**: llama directo a la REST API de Supabase
  (`{SUPABASE_URL}/rest/v1/reports?id=eq.<id>`) con la misma publishable
  key que usa el cliente — no hay backend propio, mismo patrón que el
  resto del proyecto.
- **Reporte ya no existe** (expiró a las 6h, o lo borró la comunidad): cae
  a `ASSETS.fetch`, la SPA muestra los meta tags genéricos del `<head>`.
  No hay error visible ni para el bot ni para un usuario real.
- **Imagen OG**: reusa `icon-512.png` (card `summary`, no
  `summary_large_image`) — igual que el preview genérico. Generar una
  imagen dinámica por reporte (ej. thumbnail del mapa) quedó fuera de
  alcance a propósito, por simplicidad.
- **Verificado con `curl -A "<user-agent>"` contra producción bajo
  Netlify** (bot + reporte real → HTML con meta tags del reporte; bot +
  id inexistente → 200, cae a la SPA; navegador normal → SPA completa sin
  cambios) y con un test funcional local (`node` + `env.ASSETS` mockeado)
  para la versión Workers — no se pudo repetir la verificación end-to-end
  contra Supabase real bajo Cloudflare por el bloqueo de red del sandbox,
  pero el código es una traducción 1:1 de la lógica ya verificada.

## Panel de administración
`admin.html` — moderar reportes (verlos todos, borrar cualquiera), ver
estadísticas (total, por categoría, último reporte) y editar en caliente
los parámetros del sistema (antes hardcodeados en `amet-radar.html`) sin
tocar código. Igual que el resto del proyecto desde que se migró a
Supabase: **sin backend propio**, el panel le pega directo a la REST API
de Supabase con la misma publishable key que ya está embebida en
`amet-radar.html` — no hay Netlify Functions ni ningún servidor propio de
por medio.

- **Tabla `public.app_config`**: fila única (`id boolean primary key
  default true` + `check (id)`, truco de "singleton" para que la PK
  impida una segunda fila) con `stale_minutes`, `max_age_minutes`,
  `deny_threshold`, `report_limit`, `report_window_min`. RLS abierta
  (select + update, `USING (true)`), mismo criterio que `reports`.
  `amet-radar.html` la lee al arrancar (`loadConfig()`) hacia un objeto
  `CONFIG` mutable con los valores de antes como default si el fetch
  falla; `admin.html` la edita con `PATCH .../app_config?id=eq.true`.
- **Auth del panel**: password compartido, validado por un Edge Function
  nuevo (`supabase/functions/admin-login`) que compara contra el secret
  `ADMIN_PASSWORD` (mismo mecanismo manual que las VAPID keys — no hay
  herramienta MCP conectada que permita setear secrets) con rate-limit
  básico en memoria (5 intentos/15 min → bloqueo 15 min, best-effort, no
  sobrevive un cold start). **Importante**: como las políticas RLS de
  `reports`/`app_config` ya son abiertas a cualquiera con la publishable
  key (la misma que ya está en `amet-radar.html`, pública por diseño), este
  login **no protege ningún dato real** — es solo un gate de conveniencia
  para que no cualquiera encuentre la pantalla de moderación, mismo
  espíritu que "no hay autenticación de usuarios en la app". Por eso no
  hay tokens de sesión: tras un login exitoso, `admin.html` solo guarda un
  flag en `sessionStorage` y a partir de ahí llama a Supabase igual que
  cualquier visitante.
- **Borrado de reportes desde el panel**: usa el mismo `DELETE
  .../reports?id=eq.<id>` que ya podía hacer cualquiera con la anon key
  desde antes del panel (RLS abierta) — no se introdujo una superficie de
  ataque nueva, solo una forma cómoda de hacer lo que ya era posible.
- **Por qué no quedó en Netlify Functions + Blobs**: la primera versión de
  este panel (antes de este commit) se construyó sobre un backend propio en
  Netlify Functions con Netlify Blobs como reemplazo de un `data/*.json` —
  pensado para un `server.js` con API propia que ya no existe en este
  proyecto desde que se migró a Supabase. Se descartó esa rama entera y se
  reconstruyó el panel contra Supabase directo, coherente con cómo ya
  funciona el resto de la app.

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
  usa el resto del código (`setLatLng`, `map.removeLayer`, el listener de
  `click` que abre la hoja de detalle), así que
  `removeMarker`/`renderVisibleMarkers` no necesitaron cambios.
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
  El callback de error distingue `PERMISSION_DENIED` (código 1) de
  `POSITION_UNAVAILABLE`/`TIMEOUT`: el primero es permanente (el navegador
  no vuelve a preguntar solo, sobre todo en iOS/Safari) y muestra un aviso
  accionable ("activá el permiso en Ajustes") una sola vez (`deniedShown`);
  los otros dos siguen mostrando "está tardando", porque el fix puede
  llegar igual unos segundos después (GPS frío al abrir la PWA).
- **Modo "seguir mi ubicación"** (v9.2, activación manual, no automática):
  tocar el botón de ubicación (`#locate-btn`) alterna la variable
  `following` — al activarse centra una vez con `setView` (preservando el
  zoom si ya es mayor a 16) y pone `data-state="active"` en el botón
  (mismo patrón visual que `#push-toggle-btn[data-state="active"]`, color
  `--brand`); mientras está activo, cada fix nuevo de `watchPosition` hace
  `map.panTo(latlng)` en vez de `setView`, para no resetearle el zoom al
  usuario en cada actualización de posición. Se autodesactiva con
  `map.on('dragstart', ...)` apenas el usuario arrastra el mapa a mano —
  mismo comportamiento que Waze/Google Maps. `panTo`/`setView`
  programáticos no disparan `dragstart` en Leaflet, así que el propio
  seguimiento no se autocancela. Sin este modo activado, el comportamiento
  es el de siempre: un solo centrado en el primer fix (`firstFix`).
- **Diseño (rediseño v9.0, mobile-first)**: el público es casi todo móvil,
  así que la pantalla se organiza alrededor del mapa en vez de alrededor
  de un header. Decisiones que conviene no deshacer sin pensarlo:
  - **El mapa ocupa el 100% de la pantalla** y todo lo demás flota encima
    (`#top` arriba, `#fab-row` abajo). Antes header + chips se comían
    ~110px fijos de alto. `#top` tiene `pointer-events:none` y solo sus
    hijos reales lo reciben, para poder arrastrar el mapa por los huecos.
  - **El detalle de un reporte es una hoja inferior (`#detail`), no el
    popup de Leaflet.** Un globito de ~216px era incómodo en táctil (foto
    chica, botones apretados). Se eliminaron `bindPopup`/`setPopupContent`/
    `openPopup`: el marcador tiene un listener de `click` que llama a
    `openDetail(id)`. La hoja NO se re-renderiza en el sondeo de 8s (te
    cortaría el scroll bajo el dedo); solo con `refreshDetail(id)` después
    de que vos mismo votás.
  - **Tema automático** (`prefers-color-scheme`): claro de día, oscuro de
    noche, para el resto de la UI (header, chips, hojas). El mapa en sí es
    la excepción, a pedido: siempre usa tiles claros de CartoDB de día y de
    noche. Estilo `voyager` (`rastertiles/voyager`, v9.3) en vez de
    `light_all`: mismo proveedor sin API key, pero con calles, nombres de
    lugares y más color — sigue siendo un fondo claro, solo más legible.
  - **Ningún control primario mide menos de 44px** (`--tap`), y todo lo
    que flota respeta `env(safe-area-inset-*)`.
  - Se sacó `maximum-scale=1.0` del viewport: bloqueaba el pinch-zoom, que
    es un problema de accesibilidad real.
  - `zoomControl:false` en el mapa: los botones +/- sobran en un teléfono.
  - **Categorías**: `CATEGORIES` tiene `hex` (color plano, lo necesita el
    renderer SVG de Leaflet y también los chips) e `ink` (color de texto
    legible encima de ese hex). Ya no existe el campo `color` con
    `var(--nombre)`. Los chips activos usan un tinte translúcido derivado
    del hex en JS (`hexTint`, expuesto como `--chip-tint`) en vez de
    rellenarse a full saturación: como las 4 categorías arrancan activas,
    el relleno sólido se veía como una pared de color.
  - **`#flow-overlay.picking`**: durante "Marca el lugar" el overlay tiene
    que dejar ver *y tocar* el mapa, así que esa clase le saca el scrim y
    el `backdrop-filter`. Antes se hacía con `style.background` inline, que
    ya no alcanza porque el overlay tiene desenfoque.
- **Compartir y SEO social**: el botón "Compartir" del detalle usa
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

## Reconstruir la base de datos desde cero (si hay que migrar de cuenta/proyecto)
Todo el esquema de Supabase está versionado en `supabase/migrations/*.sql`
y alcanza, en orden, para recrear la base entera en un proyecto nuevo —
esto quedó completo recién en esta sesión: la tabla `reports` (la
principal) predataba el versionado de migraciones y no estaba
documentada; se agregó retroactivamente en
`20260729230000_reports_genesis.sql` reconstruida a partir del esquema
real (columnas, constraints, índices, políticas), justamente para que
este paso no dependiera de memoria/algo sin documentar. Esto es
documentación de **estructura**, no un backup de los datos que haya
cargados en un momento dado — ver por qué al final de esta sección.

**Orden de aplicación** (nombre de archivo = orden cronológico, ya
ordena alfabéticamente bien):
1. `20260729230000_reports_genesis.sql` — tabla `reports` (RLS abierta,
   sin la que nada más tiene sentido)
2. `20260730000000_push_subscriptions.sql` — tabla `push_subscriptions`,
   extensión `pg_net`, función + trigger `notify_nearby_reports` sobre
   `reports` (por eso va después del genesis)
3. `20260730010000_push_subscriptions_categories.sql` — columna
   `categories` en `push_subscriptions`
4. `20260730180000_app_config.sql` — tabla `app_config` (parámetros del
   panel admin)
5. `20260730193000_admin_login_attempts.sql` — tabla
   `admin_login_attempts` (rate-limit del login del panel admin)
6. `20260730200000_report_photos_bucket.sql` — bucket de Storage
   `report-photos` + políticas

Aplicar cada uno con `apply_migration` (MCP) o pegándolos en el SQL
Editor del proyecto nuevo, en ese orden.

**Lo que las migraciones NO cubren** (pasos manuales aparte, ya
documentados donde corresponde pero listados acá juntos para no
saltearse ninguno al migrar):
- **Edge Functions**: `supabase/functions/notify-nearby/` y
  `supabase/functions/admin-login/` hay que desplegarlas aparte
  (`deploy_edge_function` o Supabase CLI) — el código fuente sí está en
  el repo, solo el deploy es manual.
- **Secrets de Edge Functions** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`, `ADMIN_PASSWORD`): ninguna herramienta MCP conectada
  permite setearlos, se cargan a mano en Project Settings → Edge
  Functions → Secrets en el proyecto nuevo (ver "Notificaciones push" y
  "Panel de administración" arriba).
- **`SUPABASE_URL`/`SUPABASE_ANON_KEY` embebidos en el cliente**: están
  hardcodeados en `amet-radar.html` y `admin.html` (buscar
  `nikexwjxxcxzhsuypsjn` en ambos archivos) — al migrar a otro proyecto
  hay que reemplazarlos ahí y volver a desplegar el frontend.
- **`VAPID_PUBLIC_KEY`** también está embebido en `amet-radar.html`
  (distinto de la privada, que solo va en el secret) — si se regeneran
  las claves VAPID para el proyecto nuevo, hay que actualizarlo ahí
  también.

**Por qué esto es solo estructura y no backup de datos**: dado el perfil
de esta app, casi ningún dato vale la pena preservar entre migraciones —
`reports` se autoexpira a las `max_age_minutes` (6h por default) así que
en cualquier momento dado son en su mayoría reportes recientes y
efímeros; `app_config` son 5 números con default documentado acá mismo;
`admin_login_attempts` es rate-limit transitorio. La única tabla con
datos que un usuario real "perdería" al migrar sin exportar es
`push_subscriptions` (la gente que ya se suscribió a notificaciones
tendría que volver a activarlas) — si en algún momento eso importa, se
exporta con el Table Editor de Supabase (Export as CSV) o `pg_dump`
antes de migrar, no hace falta un mecanismo propio en el repo para algo
que se usa una sola vez.

## Despliegue (Cloudflare Workers)
El frontend está publicado en **Cloudflare Workers + Static Assets**
(cuenta `manuelbis1996`), Worker `amet-radar`, URL en vivo:
**https://amet-radar.manuelbis1996.workers.dev/** — verificado en
producción por el usuario (mapa, reportes, panel admin funcionando).

Antes estuvo en Netlify hasta que se agotó la franja gratuita (banda
ancha/build minutes) y el sitio quedó caído; se migró a Cloudflare (plan
Free, sin límite de banda ancha) en vez de agregar un método de pago —
ver "Historial relevante de decisiones" al final de este archivo para
más contexto de esa decisión.

**Se eligió Workers + Static Assets, no Cloudflare Pages clásico.** El
conector MCP de Cloudflare usado durante la migración solo traía
herramientas de Workers/D1/KV/R2/Hyperdrive (nada de Pages) y traía una
herramienta específica `migrate_pages_to_workers_guide` — señal directa
de que Cloudflare empuja Workers+Assets como el camino nuevo. Esto reusa
el mismo modelo de un solo archivo que tenía la Netlify Edge Function:
`_worker.js` en la raíz sirve tanto los assets estáticos
(`env.ASSETS.fetch`) como la lógica de preview dinámico, sin build step —
mismo criterio "sin dependencias" del resto del proyecto.

### Archivos de la configuración de despliegue
- **`_worker.js`** (raíz del repo) — sirve el preview dinámico por
  reporte: un único `export default { fetch(request, env) }` que (1)
  reescribe `/` → `/amet-radar.html` a mano — Cloudflare no aplica
  `_redirects` cuando hay un Worker con `main` propio — y (2) intercepta
  bots de link-preview en `?r=<id>` con meta tags OG específicas del
  reporte. Todo lo demás cae a `env.ASSETS.fetch(request)`. `SITE_URL` se
  deriva de `url.origin` por request, no está hardcodeado — funciona
  igual en producción y en cualquier preview deploy sin tocar código.
- **`wrangler.jsonc`** — config mínima: `main: "./_worker.js"`,
  `assets.directory: "./"` (todo el repo, ya que el sitio vive en la raíz
  sin carpeta `dist`/`public`), `binding: "ASSETS"`.
- **`.assetsignore`** — **crítico**: a diferencia de Pages, Workers NO
  excluye `.git`/`node_modules` automáticamente del directorio de assets.
  Sin este archivo, `assets.directory: "./"` subiría el `.git` completo
  (historial entero del repo) como archivos públicos descargables. Ojo
  con la sintaxis: los patrones de directorio necesitan `**/` adelante
  (`**/.git`, no `.git/`) para matchear recursivamente — confirmado a
  mano corriendo `wrangler deploy --dry-run` con `WRANGLER_LOG=debug` y
  comparando la lista de "Ignoring asset" contra el árbol real del repo;
  la primera versión del archivo (con `.git/`) NO excluía nada y hubiera
  publicado el repo entero. Verificado que el resultado final sube
  exactamente 6 archivos: `amet-radar.html`, `admin.html`,
  `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`.
- **`amet-radar.html`**: los meta tags OG/Twitter genéricos del `<head>`
  (`og:url`, `og:image`, `twitter:image`) apuntan a
  `https://amet-radar.manuelbis1996.workers.dev/`.
- **Conectado al repo de GitHub** (`manuelbis1996/Amet-Radar`) vía
  `Workers & Pages → Create application → Import a repository`, con
  auto-deploy en cada push a `main`.

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
- Se migró el hosting de Netlify a Cloudflare Workers cuando Netlify
  agotó la franja gratuita (banda ancha/build minutes) y el sitio quedó
  caído — se prefirió migrar de proveedor antes que agregar un método de
  pago, ya que Cloudflare Workers (plan Free) no tiene límite de banda
  ancha. Dentro de Cloudflare se eligió Workers + Static Assets en vez de
  Pages clásico porque las herramientas disponibles apuntaban claramente
  a ese camino (ver "Despliegue" arriba) — verificado en producción por
  el usuario tras el corte.
