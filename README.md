# AMET Radar

App web de reportes comunitarios de retenes de tránsito (AMET) en República
Dominicana, **lanzada en La Vega**. Los usuarios marcan dónde hay un retén y
otros lo confirman o lo desmienten. HTML/CSS/JS vanilla + MapLibre GL, sin
build step y sin dependencias.

## En producción

**https://amet-radar.lavega.workers.dev** — Cloudflare Workers, con HTTPS
(necesario para la geolocalización en el celular) y sin depender de que
ninguna PC esté prendida: los reportes viven en Supabase.

**Cómo se publica**: el trabajo va en una rama, se abre un PR, y `main` no
acepta el merge hasta que los tests estén en verde. Al mergear, Cloudflare
despliega solo. O sea que a producción solo llega código probado, y el gate
es la regla de protección de `main` — no un paso del CI. Detalle en
[CLAUDE.md](CLAUDE.md), "Cómo llega el código a producción".

El resto de este README es para correr el proyecto en local.

## Requisitos

[Node.js](https://nodejs.org/) (cualquier versión reciente). **No hace falta
`npm install`**: el proyecto no tiene dependencias y `server.js` solo usa
módulos nativos.

## Cómo correrlo

La geolocalización, el service worker (PWA) y el fetch a Supabase no funcionan
abriendo el archivo con doble clic (`file://`), así que hay que servirlo por
`http://`:

```bash
node server.js
```

Y abrir `http://localhost:8000/amet-radar.html`.

`server.js` **solo sirve archivos estáticos**: no tiene ninguna API ni guarda
reportes. Aun corriendo en local, la app lee y escribe contra el Supabase de
producción.

Para probar desde el teléfono en la misma Wi-Fi hace falta HTTPS: por IP de
red (`http://192.168.x.x`) los navegadores móviles bloquean la geolocalización.
Lo más rápido es un túnel, `npx localtunnel --port 8000`.

## Pruebas

```bash
node tests/run.js                 # las 13 suites
node tests/run.js seguridad area  # solo las que coincidan
```

Requieren Playwright con Chromium (`npm install -g playwright && npx
playwright install chromium`), que tampoco es dependencia del proyecto.

En cada push y cada PR las corre GitHub Actions
([.github/workflows/tests.yml](.github/workflows/tests.yml)), junto con un
`wrangler deploy --dry-run` que valida la configuración de despliegue sin
necesitar credenciales.

**Verde ahí no alcanza.** Las suites mockean la red y nunca llegan a Postgres,
así que no dicen nada sobre RLS, funciones de la base ni triggers — que es por
donde se colaron los bugs más caros de este proyecto. Cualquier cambio que
toque eso hay que probarlo además contra la base real con el rol `anon`. El
detalle, con la lista de esos bugs y cómo probarlos, está en
[tests/README.md](tests/README.md).

## Cómo funciona

Los reportes viven en la tabla `reports` de un proyecto Supabase.
`amet-radar.html` llama directo a la API REST con una publishable key embebida
en el cliente (está pensada para vivir ahí); el control de acceso real lo hacen
las políticas RLS y unas funciones en la base, no `server.js`. Cualquier
dispositivo ve los mismos reportes, y el cliente refresca cada 8 segundos —
pidiendo solo el área visible del mapa.

**Todo lo que escribe pasa por una RPC.** De `/rest/v1/reports` solo queda
abierto el `GET`: publicar, votar y borrar tienen su propia función con las
reglas adentro, y lo mismo vale para las suscripciones a notificaciones. No
queda ninguna tabla con escritura directa. Sin cuentas de usuario, "este reporte es mío" se resuelve con
un token por reporte — el texto plano queda en `localStorage` del dispositivo y
la base solo guarda su hash. Publicar aplica anti-spam del lado del servidor
(dedupe por cercanía y tope por IP).

Los reportes se autoexpiran, así que el mapa siempre muestra cosas recientes.

## Qué hace la app hoy

- **Reportar es un toque.** El botón publica un retén fijo en tu ubicación,
  sin pantallas intermedias. La red de seguridad es un aviso de 6 segundos con
  **Deshacer**, que lo borra del servidor y te devuelve el cupo.
- **Confirmar o desmentir** desde la hoja de detalle de cada reporte; con
  suficientes negaciones se retira solo. Tu voto queda visible.
- **Notificaciones push por cercanía** (campana del header): avisan aunque la
  app esté cerrada cuando alguien publica cerca de tu última posición. El
  radio se ajusta desde el panel admin, sin tocar código.
- **Mapa** MapLibre GL + OpenFreeMap (tiles vectoriales, sin API key),
  limitado a República Dominicana y centrado en La Vega al abrir. Botón de
  ubicación con modo "seguir", que se desactiva solo al arrastrar el mapa.
- **Compartir** con la hoja nativa del sistema; el link de un reporte muestra
  una tarjeta de preview propia en WhatsApp y redes, generada por el Worker.
- **PWA instalable**, con el shell cacheado por el service worker.
- **Sin fotos ni notas.** El flujo con foto sigue completo en el código pero
  no tiene entrada en la interfaz, y desde v14.1 el servidor rechaza fotos y
  notas: como nadie podía adjuntarlas, lo único que entraba por ahí era abuso
  por API. Reactivarlo exige reabrir el servidor **y** construir moderación —
  ver el comentario de `FLUJO_CON_FOTO` en `amet-radar.html`.
- **Solo se reporta una categoría** (retén fijo). Las otras tres siguen
  existiendo para dibujar reportes viejos y para el texto de las
  notificaciones.

## Panel de administración

`admin.html` — ver todos los reportes y borrar cualquiera, estadísticas,
editar en caliente los parámetros del sistema (cuánto dura un reporte, cuántas
negaciones lo retiran, el límite local de reportes, el radio de las
notificaciones push) y **publicar un reporte en
cualquier punto del mapa sin estar cerca**, eligiendo entre las cuatro
categorías. Sin backend propio: le pega a Supabase igual que la app, con el
borrado y la edición detrás de un password validado por un Edge Function.

Publicar desde el panel usa la misma RPC pública que la app, así que le
aplican las mismas reglas anti-spam — y **manda notificaciones push reales**
a quien esté suscrito cerca.

Es un **gate de conveniencia**, no una barrera de seguridad: sirve para que no
cualquiera encuentre la pantalla de moderación.

## Archivos

| Archivo | Qué es |
|---|---|
| `amet-radar.html` | Toda la app: HTML, CSS y JS en un solo archivo |
| `admin.html` | Panel de administración |
| `server.js` | Servidor estático para desarrollo local, sin API |
| `_worker.js`, `wrangler.jsonc`, `.assetsignore` | Despliegue en Cloudflare Workers y preview de links |
| `sw.js`, `manifest.json`, `icon-*.png` | PWA |
| `supabase/migrations/` | Historial del esquema de la base |
| `supabase/functions/` | Edge Functions (push, panel admin, borrado de fotos) |
| `tests/` | Las 13 suites de Playwright |
| `.github/` | CI (corre las suites en cada push y PR) y plantilla de PR |

## Más detalle

[CLAUDE.md](CLAUDE.md) tiene el contexto completo: por qué cada decisión de
arquitectura está tomada así, los bugs históricos con su causa raíz, el modelo
de seguridad, cómo reconstruir la base desde cero y qué pasos del despliegue
son manuales. Si vas a tocar RLS, una función de la base o el flujo de
publicar, leelo antes.
