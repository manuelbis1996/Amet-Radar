# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AMET Radar — Contexto del proyecto

## Qué es
App web (HTML/CSS/JS vanilla + MapLibre GL) de reportes comunitarios de retenes
de tránsito (AMET) en República Dominicana. **Se lanza en La Vega**: el
mapa arranca ahí y los textos de la app hablan de La Vega, aunque el mapa
permite moverse por todo el país (ver `RD_BOUNDS`). Los usuarios marcan en un mapa dónde
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
- `manifest.json` — manifest de PWA. `start_url` es `"./amet-radar.html"`
  (ver "Bug del 307" abajo: en v9.7 se lo movió a `"./"` como workaround y
  en v9.8 se volvió atrás, una vez arreglada la causa real).
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

  **Bug del 307 (v9.8) — leer antes de tocar `wrangler.jsonc` o `sw.js`.**
  Al migrar a Cloudflare, la PWA instalada en Android dejó de abrir:
  `net::ERR_FAILED` en `/amet-radar.html`, mientras que `/` andaba bien.
  Cadena completa, porque cada eslabón es contraintuitivo por separado:
  1. Cloudflare Workers Static Assets trae `html_handling:
     "auto-trailing-slash"` **por defecto**, y eso hace que
     `/amet-radar.html` responda **307 → `/amet-radar`** (documentado en
     developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling).
     Netlify no hacía esto, por eso el problema apareció recién con la
     migración y no antes.
  2. Una request de navegación tiene `redirect: "manual"`. El `fetch`
     handler del service worker hacía `fetch(event.request)` y le pasaba
     esa respuesta redirigida a `respondWith()` → Chrome lo trata como
     error de red → `ERR_FAILED`. Por eso fallaba `/amet-radar.html`
     (única ruta que intercepta, por el chequeo `isAppShell`) y no `/`.
  3. Peor: `cache.addAll()` es **atómico**, y también se comía el 307. El
     `install` del service worker nuevo fallaba entero → nunca se
     instalaba → **el service worker viejo quedaba activo para siempre**,
     sin poder tomar ninguna actualización. Por eso desplegar los fixes de
     v9.6/v9.7 no cambió nada en el dispositivo ya afectado: literalmente
     no había forma de que bajara código nuevo solo.
  4. Además, en Android "Agregar a pantalla de inicio" crea un WebAPK (una
     app instalada de verdad, separada del navegador): borrar el ícono no
     la desinstala ni limpia su service worker.

  **Arreglos aplicados** (los tres, no uno solo): `html_handling: "none"`
  en `wrangler.jsonc` (mata el 307 en origen); `install` cachea de a un
  archivo tolerando fallos en vez de `addAll` atómico (para que un archivo
  roto nunca más pueda congelar las actualizaciones del service worker); y
  el fallback de red fallida devuelve un `Response` real 503 en vez de
  `undefined` (v9.6 — `respondWith(undefined)` también da `ERR_FAILED`).
  **Recuperar un dispositivo ya congelado** exige mano: desinstalar la app
  desde Ajustes → Apps (no alcanza con borrar el ícono), borrar los datos
  del sitio en Chrome, y recién ahí reinstalar.
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
- `supabase/functions/admin-delete-report/index.ts` — Edge Function que
  borra un reporte desde el panel admin, con la `service_role` key detrás
  del mismo `ADMIN_PASSWORD` (ver "Seguridad de escritura" abajo).
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
- **No hay `PATCH` ni `DELETE` contra `/rest/v1/reports`** desde v12.0: esas
  políticas RLS se eliminaron (ver "Seguridad de escritura" abajo). Todo lo
  destructivo pasa por `POST {SUPABASE_URL}/rest/v1/rpc/<funcion>`
  (`vote_report`, `delete_own_report`, `purge_expired_reports`).
- Headers en todas las llamadas: `apikey` y `Authorization: Bearer
  <SUPABASE_ANON_KEY>`.
- Esquema de `reports`: `id text PK`, `lat/lng double precision`,
  `photo text` (nullable), `note text`, `ts bigint` (epoch ms), `category
  text` (check contra las 4 categorías), `confirms/denies integer`, `approx
  boolean`, `created_at timestamptz`, `owner_hash text` (nullable, ver
  "Seguridad de escritura").
- RLS habilitado. `select` e `insert` siguen abiertos (`USING (true)`): leer
  y publicar son anónimos por diseño, no hay cuentas de usuario. `update` y
  `delete` **ya no tienen política** — ver "Seguridad de escritura" abajo.
  El linter de Supabase marca las dos políticas abiertas que quedan como
  warning esperado, no como bug.
- `server.js` ya no expone ninguna ruta `/api/*`.
- **`photo` guarda una URL, no base64**: bucket público `report-photos` en
  Supabase Storage, archivo `<id-del-reporte>.jpg`. `uploadPhoto()` en
  `amet-radar.html` sube la foto comprimida (`compressImage()`, sigue
  produciendo un `data:` URL igual que antes) y guarda la URL pública
  (`{SUPABASE_URL}/storage/v1/object/public/report-photos/<id>.jpg`) en
  vez del base64 completo — antes cada fila cargaba la imagen entera y
  `GET .../reports?select=*` la traía completa en cada refresh de 8s, para
  todos los reportes activos. La foto se borra junto con la fila, del lado
  de la base (`_delete_report()`), no desde el cliente: `anon` perdió el
  `delete` sobre `storage.objects` en v12.0, si no cualquiera con la anon
  key podía vaciar el bucket entero. Queda abierto solo el `insert` (sin
  eso no se puede publicar una foto) y no hay política
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
  espíritu que "no hay autenticación de usuarios en la app". Eso **sigue
  siendo cierto para leer y para editar `app_config`** (esas políticas RLS
  siguen abiertas), pero ya **no** para borrar reportes — ver el punto
  siguiente.
- **Borrado de reportes desde el panel** (v12.0): pasa por el Edge Function
  `admin-delete-report`, que revalida el `ADMIN_PASSWORD` y borra con la
  `service_role` key (llamando a `_delete_report` en la base, para no
  duplicar la lógica de borrar la fila + su foto). Antes usaba el mismo
  `DELETE .../reports?id=eq.<id>` que podía hacer cualquiera con la anon
  key; al cerrar esa política RLS (ver "Seguridad de escritura"), el panel
  se quedaba sin forma de borrar y necesitaba una vía propia.
  Consecuencia: `admin.html` guarda el **password** en `sessionStorage`
  (clave `amet_admin_pw_v1`) y lo reenvía en cada borrado, en vez de un
  flag `'1'`. No es ideal, pero cualquiera con XSS en esa página podría
  llamar al endpoint igual, y montar una tabla de sesiones para un panel
  que ya se describe como "gate de conveniencia" era desproporcionado. Si
  el endpoint responde 401 (el password cambió con la pestaña abierta), el
  panel limpia la sesión y vuelve al login.
- **Por qué no quedó en Netlify Functions + Blobs**: la primera versión de
  este panel (antes de este commit) se construyó sobre un backend propio en
  Netlify Functions con Netlify Blobs como reemplazo de un `data/*.json` —
  pensado para un `server.js` con API propia que ya no existe en este
  proyecto desde que se migró a Supabase. Se descartó esa rama entera y se
  reconstruyó el panel contra Supabase directo, coherente con cómo ya
  funciona el resto de la app.

## Seguridad de escritura (v12.0) — leer antes de tocar RLS o los flujos de borrado

**El problema que cierra.** `public.reports` tenía políticas RLS abiertas
para `update` y `delete`, y la `SUPABASE_ANON_KEY` está pública dentro de
`amet-radar.html` (por diseño: es una publishable key). La combinación
significaba que cualquiera que mirara el código fuente de la página podía
vaciar la base entera con una sola petición:

```
DELETE /rest/v1/reports?id=neq.x
```

y también poner `confirms: 99999` en cualquier reporte, o vaciar el bucket
de fotos. Mientras el proyecto era una prueba entre conocidos daba igual;
al lanzarlo en La Vega por WhatsApp, alcanzaba una persona molesta para
tumbarlo. Migración: `20260801120000_lock_down_writes.sql`.

**Cómo se resuelve la "propiedad" sin cuentas de usuario.** Con un secreto
por reporte: al publicar, el cliente genera un token al azar, guarda el
**texto plano en `localStorage`** (`amet_report_tokens_v1`) y manda a la
base solo su **hash SHA-256** (columna `reports.owner_hash`). Para borrar
hay que presentar el token; leer la tabla solo expone el hash, que no sirve
para nada. Es el mismo espíritu que `amet_my_reports_v1` ("mis reportes"),
pero **verificable del lado del servidor** — antes "es mío" se validaba
solo en el cliente, o sea que no validaba nada.

**Las funciones de la base** (todas `SECURITY DEFINER` con `search_path`
fijo). `grant execute` a `anon` **solo** en las tres públicas:

| Función | Quién la llama | Qué hace |
|---|---|---|
| `vote_report(p_id, p_dir)` | cliente (`voteReport`) | suma **1** al contador de `confirm`/`deny` y decide ella el retiro comunitario (lee `deny_threshold` de `app_config`). Devuelve `{confirms, denies, removed}` |
| `delete_own_report(p_id, p_token)` | cliente (`deleteReportRemote`) | compara `encode(digest(p_token,'sha256'),'hex')` contra `owner_hash`. `false` si no coincide, sin decir por qué |
| `purge_expired_reports()` | cliente (`purgeExpiredRemote`) | borra solo filas con `ts` vencido. Es seguro exponerla: no puede borrar nada que no fuera a desaparecer igual |
| `_delete_report(p_id)` | **nadie desde el cliente** | borra la fila + su foto de `storage.objects`. Sin grant a `anon`; sí a `service_role`, porque el Edge Function `admin-delete-report` la usa |

**Gotcha del grant a `service_role`**: `revoke all ... from public` también
se lo saca a `service_role`, que no es dueño de la función. Hay que
devolvérselo explícitamente o el panel admin falla al borrar.

**Del lado del cliente** (`amet-radar.html`):
- El voto ya no calcula ni manda los totales — solo `(id, dirección)` — y
  **obedece** el `removed` que responde el servidor en vez de decidirlo
  con `CONFIG.denyThreshold`.
- La limpieza de vencidos ya no manda un `DELETE` por cada reporte viejo:
  los saca de la vista y llama a `purge_expired_reports()` throttleada
  (`PURGE_EVERY_MS`, 10 min — `renderVisibleMarkers` se dispara en cada
  paneo del mapa).
- `stampOwnership()` se llama **antes** de cualquier envío, para que el
  `owner_hash` viaje también si el reporte se va a la cola offline.
- `deletePhoto()` **ya no existe en el cliente**, ni en `amet-radar.html`
  ni en `admin.html`.

**Lo que se rompe, asumido**: los reportes creados antes de la migración no
tienen `owner_hash`, así que sus autores no pueden borrarlos (la app avisa
"Se retirará solo al vencer"). Se van solos a las `max_age_minutes`. No se
hace backfill porque no hay forma de saber de quién era cada uno.

**Lo que este cambio NO cubre** (bloqueantes conocidos, quedan para
después): el anti-spam sigue siendo del lado del cliente (`canReport()`
mira `localStorage`, se resetea borrando los datos del sitio), y subir
fotos sigue abierto a cualquiera con la anon key — no hay moderación
automática ni forma de reportar abuso.

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
- **Mapa: MapLibre GL + OpenFreeMap (v10.0, reemplazó a Leaflet)**: tiles
  vectoriales en vez de raster — texto nítido en cualquier zoom y se ven
  comercios/puntos de referencia. Librería `maplibre-gl@5.24.0` por CDN
  (unpkg), **pineada a la última v5 a propósito**: la v6 salió días antes
  y trae breaking changes, no vale el riesgo en un proyecto sin tests.
  Estilo `https://tiles.openfreemap.org/styles/bright` — gratis, sin API
  key ni límite de requests; los datos son de OpenStreetMap y OpenFreeMap
  regenera el planeta **una vez por semana** (miércoles), así que un
  negocio mapeado hoy puede tardar días en aparecer. Gotchas de la
  migración, todos con su comentario en el código:
  - **El zoom no es el mismo número que en Leaflet.** MapLibre usa tiles de
    512px y Leaflet de 256px, así que para la misma escala el zoom de
    MapLibre es **uno menos**. Toda conversión pasa por `zoomFromLeaflet()`
    para no tener que acordarse del offset en cada llamada.
  - **Los marcadores son elementos del DOM, no íconos.** No existe
    `setIcon`: `paintPin()` repinta el div existente y guarda una firma en
    `dataset.sig` para no reescribir el `innerHTML` en cada sondeo de 8s
    (sin eso, cada pin parpadearía cada 8 segundos).
  - **El círculo de zona aproximada ya no tiene radio en metros.** No hay
    equivalente de `L.circle`: es un div circular al que
    `sizeApproxCircle()` le calcula el diámetro **en píxeles** vía
    `metersToPixels()`, y hay que recalcularlo en el evento `zoom`
    (continuo, no `zoomend`) o el círculo "salta" mientras se hace pinch.
  - `markersById[id]` ya no es un layer sino `{ kind, el, marker, lat }` —
    hacen falta el elemento (para repintarlo) y la latitud (para el radio).
  - `getBounds().pad(0.25)` no existe: el margen del 25% se calcula a mano
    en `renderVisibleMarkers`.
  - `moveend` ya cubre el fin de un zoom, y `on()` no acepta varios eventos
    separados por espacio como sí hacía Leaflet.
  - El click del mapa trae `e.lngLat`, no `e.latlng`; y `flyTo` recibe la
    duración en **milisegundos**, no en segundos.
  - Rotación e inclinación **deshabilitadas** a propósito
    (`dragRotate:false`, `touchPitch:false`, `touchZoomRotate.disableRotation()`):
    girar el mapa sin querer con dos dedos desorienta más de lo que aporta.
  - **Atribución de OpenStreetMap** (v10.1): la licencia ODbL de los datos
    la exige. El mapa se crea con `attributionControl:false` y después se
    agrega con `addControl(new maplibregl.AttributionControl({compact:true}))`
    — así es un ⓘ chiquito que solo se despliega al tocarlo, en vez de una
    línea de texto fija. El CSS la sube 84px sobre el safe-area para que
    `#fab-row` no la tape, con `z-index:390` (debajo de `#fab-row`, para no
    robarle toques al botón de reportar).
  - **Limitado a República Dominicana** (v10.2): `maxBounds: RD_BOUNDS` —
    el mapa no deja arrastrar fuera del país. **`minZoom: 8` va de la mano
    y no es cosmético**: cuando el viewport se hace más grande que
    `maxBounds`, MapLibre deja de respetar el centro y lo clava en el medio
    de la caja, o sea el mapa "se escapa" solo al centro del país al alejar
    (se detectó probando, cae justo sobre la zona de La Vega/Bonao). Con 8,
    el alto de pantalla de un teléfono siempre entra dentro de RD y no
    llega a pasar. Si se agranda `RD_BOUNDS` o se baja `minZoom`, revisar
    que no vuelva (en pantallas muy altas, tipo desktop, todavía puede
    aparecer — no es el público objetivo).
  - **`DEFAULT_CENTER` es La Vega**, no Santo Domingo: el proyecto se lanza
    ahí. Es solo el punto de arranque mientras no hay GPS — apenas llega el
    primer fix el mapa se centra en el usuario (`firstFix`). Ojo que
    `DEFAULT_CENTER` está en `[lat, lng]` y MapLibre pide `[lng, lat]`.
  - Verificado con un stub de MapLibre + Playwright (16 chequeos: estilo,
    zoom, pines, círculo y su re-escalado, hoja de detalle, seguimiento,
    `dragstart`, flujo de "marca el lugar"), porque este sandbox bloquea
    tanto el CDN como los tiles reales. **El render visual en sí no se pudo
    verificar acá** — eso hay que mirarlo en el teléfono.
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
  programáticos no disparan `dragstart` en MapLibre, así que el propio
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
    popup del mapa.** Un globito de ~216px era incómodo en táctil (foto
    chica, botones apretados): el marcador tiene un listener de `click` que llama a
    `openDetail(id)`. La hoja NO se re-renderiza en el sondeo de 8s (te
    cortaría el scroll bajo el dedo); solo con `refreshDetail(id)` después
    de que vos mismo votás.
  - **Tema automático** (`prefers-color-scheme`): claro de día, oscuro de
    noche, para el resto de la UI (header, chips, hojas). El mapa en sí es
    la excepción, a pedido: siempre usa un estilo claro de día y de noche
    (ver "Mapa: MapLibre GL + OpenFreeMap" abajo).
  - **Ningún control primario mide menos de 44px** (`--tap`), y todo lo
    que flota respeta `env(safe-area-inset-*)`.
  - Se sacó `maximum-scale=1.0` del viewport: bloqueaba el pinch-zoom, que
    es un problema de accesibilidad real.
  - Sin controles de zoom en el mapa: los botones +/- sobran en un teléfono.
  - **Estado vacío** (v10.4): cuando no hay ningún reporte en la zona
    visible se muestra `#empty-state` ("Todo tranquilo por aquí"). **Es una
    píldora chica debajo del header, no una tarjeta en el medio del mapa**
    (v11.4): aun autoocultándose, un cartel grande y centrado tapaba justo
    lo que el usuario vino a mirar y molestaba — reportado dos veces. El
    texto se mantiene corto a propósito para que entre en una línea hasta
    en 320px (verificado por medición, no a ojo). Sin eso
    el usuario ve un mapa mudo y no sabe si la app falló, si no cargó o si
    de verdad no hay nada — y al lanzar en una ciudad nueva ese es
    literalmente el primer estado que ve todo el mundo. El contenedor va
    con `pointer-events:none` para no bloquear el arrastre del mapa (la
    tarjeta sí los recibe, para poder cerrarla), y solo aparece después del
    primer fetch que responde (`reportsLoadedOnce`), porque si no saldría
    durante el arranque. **Se muestra una sola vez por sesión y se va solo
    a los 7s** (v10.5): la primera versión lo dejaba fijo mientras no
    hubiera reportes, y con la app recién lanzada (donde puede no haber
    ninguno en horas) quedaba pegado en el medio de la pantalla para
    siempre, tapando el mapa — reportado por el usuario. Tampoco reaparece
    al pasar por otra zona vacía. Mientras hay una hoja abierta se difiere
    (quedaría tapado por el scrim y se auto-ocultaría sin que nadie lo
    lea); por eso `closeOverlay()` llama a `updateCount()` al cerrar, si no
    habría que esperar hasta 8s al próximo sondeo.
  - **La versión NO se muestra en el header** (v10.4): a un usuario final
    "v10.4" no le dice nada. Sigue siendo consultable **manteniendo
    presionado el logo** (600ms → toast), que es como se confirma a simple
    vista, sin devtools, que una PWA instalada ya tomó la versión nueva.
  - **El botón Compartir del detalle va con el color de marca**
    (`.mini-btn.primary` + ícono), no gris como Eliminar: compartir es la
    palanca de crecimiento del proyecto (ver "Historial de decisiones") y
    antes no se distinguía de una acción destructiva.
  - **Hoja de bienvenida, una sola vez** (v10.4, `amet_onboarded_v1` en
    `localStorage`): explica qué es la app y cómo reportar. No se muestra
    si la visita viene de un link compartido (`?r=`), porque ese reporte ya
    es el contexto y taparlo sería peor. Vive al final del `<script>` a
    propósito: necesita `overlay`/`renderSheet`/`closeOverlay` ya definidos.
  - **Los filtros no están sueltos sobre el mapa** (v10.6): vivían como 4
    chips fijos arriba y era fácil apagar una categoría sin querer al
    arrastrar el mapa (reportado por el usuario), además de comerse ~90px
    de alto en un teléfono. Ahora se abren desde `#filter-btn` (embudo, al
    lado de la campana) en una hoja con los mismos chips en grilla 2x2 —
    las etiquetas ("Control tránsito") son muy largas para meter las 4 en
    una fila sin recortarlas. **El botón muestra un punto naranja
    (`data-filtered="true"`) cuando hay alguna categoría apagada**: si no,
    el mapa quedaría filtrado sin ninguna señal visible y faltarían
    reportes sin que se entienda por qué. La hoja trae "Ver todas" para
    restaurar de un toque. Verificado con Playwright que en la franja donde
    estaban los chips ahora el toque llega directo al mapa.
  - **El color de la categoría se usa también al reportar** (v10.7): las
    opciones de `askForCategory`/`askForCategoryQuick` llevan el `hex` de
    su categoría (borde + tinte de fondo), el mismo que ya usan el
    marcador, el chip de filtro y la etiqueta del detalle. Antes eran 4
    cajas grises idénticas: el usuario aprendía los colores en el mapa y al
    reportar no tenía ninguna pista visual, justo en el momento en que más
    apura (a veces manejando).
  - **El voto emitido es visible** (v10.7): tras votar, los dos botones
    quedan `disabled` y el elegido se marca ("Tu voto" + anillo de marca).
    Antes se veían idénticos hubieras votado o no — el estado existía en
    `localStorage` pero era invisible, y solo te enterabas al tocar y
    recibir un "ya votaste". La dirección del voto va en una clave nueva
    (`amet_vote_dir_v1`) y no cambiando el formato de `amet_voted_v1`, para
    no romper los votos ya guardados en los teléfonos que vienen usando la
    app (esos quedan sin dirección conocida: se deshabilitan los dos
    botones y no se marca ninguno).
  - **Con GPS, el paso de marcar se saltea** (v11.3): tras la foto, si hay
    `lastKnownLatLng` se usa esa ubicación y se va directo a la categoría.
    El pin arrastrable sigue disponible desde el enlace **"Ajustar
    ubicación en el mapa"** (`#adjust-loc`) de la hoja de categoría, y al
    confirmarlo se vuelve a esa misma hoja con el punto corregido. Sin GPS
    no hay atajo posible: ahí sí se pide marcar a mano. `startManualPick()`
    arranca el pin en `pendingLocation` si ya existe, para que "Ajustar" no
    descarte una corrección previa volviendo al GPS. **El enlace va solo en
    `askForCategory` (flujo detallado), NO en `askForCategoryQuick`**: el
    modo rápido usa zona aproximada a propósito (ver "Reporte rápido"), un
    ajuste fino ahí sería contradictorio. Ojo al editar: las dos hojas de
    categoría tienen markup casi idéntico y es fácil tocar la equivocada.
  - **El flujo detallado arranca por la foto** (v11.2): el orden es
    **foto → marcar el lugar → categoría → publica**. Antes era lugar →
    categoría → foto. El motivo es que la foto es lo urgente (el retén está
    ahí en ese momento y hay que capturarlo ya); marcar el punto y elegir
    la categoría se pueden hacer después, con el vehículo detenido. El
    botón del selector de modo dice "📸 Foto + marcar en el mapa" para que
    el orden quede claro antes de entrar.
  - **La foto ya no abre una pantalla de confirmación** (v11.1): el flujo
    detallado era marcar lugar → categoría → foto → **hoja de confirmación
    con vista previa y nota** → Publicar. A pedido, ahora la foto publica
    directo: reportar suele hacerse con apuro (a veces manejando) y ese
    paso extra costaba tiempo justo al final. **Consecuencias asumidas**:
    (1) se perdió la nota opcional — ningún flujo la escribe ya, aunque la
    columna sigue en la base y el detalle la renderiza si existe, así que
    los reportes viejos con nota se siguen viendo bien; (2) ya no se ve la
    foto antes de mandarla. La red de seguridad de (2) es `showUndoToast()`:
    un toast con botón **Deshacer** que dura 6s (`UNDO_MS`, más que los
    2.6s de un toast normal, porque acá hay que dar tiempo real a
    reaccionar) y que borra el reporte del servidor, quita el marcador y
    **devuelve el cupo del anti-spam** (`unregisterLastReportTime`) — si la
    foto salió movida, repetirla no debería gastar uno de los 3 reportes
    por hora.
  - **`map.setView()` NO existe en MapLibre** (bug corregido en v11.0):
    quedaron 3 llamadas de Leaflet vivas tras la migración a MapLibre
    (v10.0), y cada una lanzaba `TypeError` en tiempo de ejecución:
    `publishReport()` (dos veces) y `openReportById()`. La de publicar era
    especialmente confusa: el reporte **sí se guardaba** (el `insert` ya
    había pasado) y recién después reventaba el `setView`, así que el catch
    mostraba "Hubo un problema guardando el reporte" sobre un reporte que
    estaba perfectamente guardado — reportado por el usuario. La de
    `openReportById` rompía abrir un reporte por link compartido o desde
    una notificación push. Reemplazadas por `map.easeTo({center:[lng,lat],
    zoom})` — ojo también con el orden, Leaflet usa `[lat,lng]` y MapLibre
    `[lng,lat]`. **Por qué no lo agarraron los tests**: ninguna suite
    ejercitaba una publicación completa ni el deep link; el stub tampoco
    tiene `setView`, así que habría fallado de haberse ejecutado. Se agregó
    `check-publicar.js`, que publica un reporte con foto de punta a punta
    (incluye `setInputFiles` para la cámara) y abre un `?r=`.
  - **Elegir el lugar es un pin arrastrable** (v10.9): antes había que
    acertar el punto exacto de un solo toque, con el dedo tapando justo lo
    que se quería marcar y sin poder corregir. Ahora `startManualPick()`
    coloca un `maplibregl.Marker({ draggable:true, anchor:'bottom' })` en la
    ubicación del usuario (o el centro del mapa si no hay GPS): se arrastra
    para afinar, se puede tocar el mapa para saltos grandes, y recién
    "Confirmar lugar" avanza a la categoría. `anchor:'bottom'` importa — la
    punta del pin es el punto real, así el dedo nunca lo tapa. **Ojo con el
    CSS**: MapLibre posiciona el marcador escribiendo `transform` en el
    elemento que se le pasa, así que la animación de entrada va en un hijo
    (`.pick-inner`); animar `transform` en `.pick-marker` pelearía con el
    posicionamiento. `closeOverlay()` y el confirmar llaman a
    `removePickMarker()` para que no quede un pin huérfano.
  - **`renderSheet()` oculta el estado vacío** (v10.9): la tarjeta "Todo
    tranquilo por aquí" tiene `pointer-events:auto` (para poder cerrarla), y
    en modo "Marca el lugar" —donde el overlay deja pasar los toques al
    mapa— se comía el toque justo en el centro de la pantalla, que es donde
    uno naturalmente marca.
  - **Tocar fuera de una hoja la cierra** (v10.8): un listener de `click`
    en `#flow-overlay` que cierra cuando `e.target === overlay` (o sea, el
    toque cayó en el fondo oscurecido y no dentro de `.sheet`). El detalle
    ya lo hacía con `.detail-backdrop`; ahora también las hojas del flujo.
    Dos casos que quedan afuera a propósito: **las hojas que están
    procesando algo** ("Publicando…", "Procesando foto") se marcan con
    `renderSheet(html, { dismissible:false })` porque ahí no hay nada que
    cancelar y cerrarlas dejaría la operación corriendo por detrás con la
    UI ya cerrada; y **"Marca el lugar"**, donde el overlay tiene
    `pointer-events:none` y el toque va al mapa a elegir el punto — no
    hizo falta ningún caso especial, sale solo de cómo ya estaba armado.
  - **El toast se va arriba cuando hay una hoja abierta** (`.toast.top`,
    v10.7): en su posición normal caía sobre el contenido de la hoja — al
    votar tapaba los propios botones de votar, o sea justo lo que acababa
    de cambiar.
  - **Categorías**: `CATEGORIES` tiene `hex` (color plano, lo aplican inline
    el marcador y el círculo de zona, y también los chips) e `ink` (color de texto
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
7. `20260801120000_lock_down_writes.sql` — cierra `update`/`delete` de
   `reports` y el `delete` del bucket, agrega `owner_hash` y las funciones
   `vote_report` / `delete_own_report` / `purge_expired_reports` /
   `_delete_report` (ver "Seguridad de escritura")

Aplicar cada uno con `apply_migration` (MCP) o pegándolos en el SQL
Editor del proyecto nuevo, en ese orden.

**Lo que las migraciones NO cubren** (pasos manuales aparte, ya
documentados donde corresponde pero listados acá juntos para no
saltearse ninguno al migrar):
- **Edge Functions**: `supabase/functions/notify-nearby/`,
  `supabase/functions/admin-login/` y
  `supabase/functions/admin-delete-report/` hay que desplegarlas aparte
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
  sin carpeta `dist`/`public`), `binding: "ASSETS"`, y
  **`html_handling: "none"`** — no es opcional: el default
  (`auto-trailing-slash`) responde un 307 de `/amet-radar.html` a
  `/amet-radar` y eso rompe la PWA instalada de una forma que no se
  recupera sola (ver "Bug del 307" en la entrada de `sw.js` arriba, en
  "Archivos"). La raíz `/` no depende de esto: la reescribe `_worker.js`.
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

Mejoras posteriores, no bloqueantes: mover el anti-spam al servidor (hoy
`canReport()` mira solo `localStorage`) y agregar moderación/reporte de
abuso para las fotos — son los dos bloqueantes conocidos que quedaron fuera
del cierre de escritura de v12.0 (ver "Seguridad de escritura").

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
- Al analizar qué faltaba para lanzar en La Vega apareció el agujero de
  borrado (RLS abierta + anon key pública = cualquiera vacía la base) y se
  priorizó cerrarlo por encima de las otras dos cosas que faltaban
  (anti-spam del lado del servidor, moderación de fotos): esas dos son
  degradaciones graduales, mientras que un `DELETE ?id=neq.x` es la app
  entera caída de un golpe, y sin forma de recuperarla. Se eligió el
  esquema de token por reporte en vez de agregar autenticación de usuarios
  porque el anonimato es parte del producto (nadie se registra para avisar
  de un retén) y una cuenta sería justo la fricción que mata el uso.
- Se migró el hosting de Netlify a Cloudflare Workers cuando Netlify
  agotó la franja gratuita (banda ancha/build minutes) y el sitio quedó
  caído — se prefirió migrar de proveedor antes que agregar un método de
  pago, ya que Cloudflare Workers (plan Free) no tiene límite de banda
  ancha. Dentro de Cloudflare se eligió Workers + Static Assets en vez de
  Pages clásico porque las herramientas disponibles apuntaban claramente
  a ese camino (ver "Despliegue" arriba) — verificado en producción por
  el usuario tras el corte.
