# Plan de Mejora — AMET Radar

App de reportes comunitarios de retenes/AMET sobre **MapLibre GL**, con
publicación de **un toque** (ubicación + categoría; la foto es opcional y se
adjunta después), backend
en Supabase y panel de administración. Desplegada en Cloudflare Workers.

Este archivo lleva el registro de qué falta y por qué. Las versiones
anteriores describían una app sobre Leaflet, con foto obligatoria y RLS
abierta: nada de eso sigue siendo cierto. El detalle de **cómo** funciona cada
cosa está en `CLAUDE.md`; acá va solo lo pendiente y lo cerrado.

Prioridad: 🔴 Alta · 🟡 Media · 🟢 Baja

---

## Ya implementado (no reabrir sin razón)

- **Backend real**: Supabase (`public.reports`). Cualquier dispositivo ve y
  publica sobre los mismos reportes; se autoexpiran.
- **Escritura cerrada** (v12.0 → v14.1): de `/rest/v1/reports` solo queda
  abierto el `GET`. Publicar, votar y borrar pasan por funciones
  `SECURITY DEFINER`. La propiedad de un reporte se resuelve con un token por
  reporte (texto plano en `localStorage`, hash en la base), sin cuentas de
  usuario.
- **Anti-spam del lado del servidor** (v14.0): dedupe por proximidad
  (150 m / 30 min / misma categoría) como control real, más un tope por IP
  generoso (30/h) como cortafuegos. El límite de `localStorage` quedó solo
  como comodidad de UX.
- **Fotos opcionales, adjuntas después de publicar** (v15.0), con denuncia y
  retiro automático. El bucket sigue sin políticas y `create_report` sigue
  rechazando fotos: la subida pasa por el Edge Function `attach-photo`.
  Las **notas** siguen cerradas.
- **`app_config` cerrada** (v12.0): el `update` de `anon` permitía mover la
  definición de "vencido" y vaciar la base por una puerta lateral.
- **Reportar es un toque** (v13.0), con "Deshacer" de 6 s como red de
  seguridad.
- **Confirmación comunitaria** ("Sigue ahí" / "Ya no está"), con el retiro
  decidido por el servidor.
- **Fetch acotado al área visible** (v13.2) y columnas explícitas en el
  sondeo (v12.2): juntos, lo que más bajó el egreso.
- **Fotos fuera de la fila** (Storage en vez de base64).
- **Notificaciones push por cercanía**, con el radio configurable desde el
  panel admin (2 km por default).
- **Compartir**: deep link `?r=` + preview dinámico por reporte para bots,
  servido por el Worker de Cloudflare.
- **Panel de administración** (`admin.html`), con el borrado y la edición de
  parámetros detrás de Edge Functions con password.
- **PWA instalable**; mapa limitado a República Dominicana.
- **14 suites de Playwright** versionadas en `tests/`, más
  `check-base-real.js` contra la base real, con su workflow semanal.

---

## 1. Seguridad

**✅ `push_subscriptions` — resuelto** (v14.2)
Era la última tabla con escritura abierta: `DELETE ?endpoint=neq.x` con la
anon key se llevaba todas las suscripciones, y un `PATCH` podía mover la
posición de cualquiera. Ahora el alta, la baja y la actualización pasan por
`subscribe_push` / `unsubscribe_push` / `update_push_position`, que reciben el
endpoint exacto y tocan una sola fila; la tabla quedó sin ninguna política.

No hizo falta inventar un token como en `reports`: sin política de SELECT
nadie puede enumerar endpoints, y un endpoint de push ya es un secreto largo
que solo tiene el dispositivo. Eso además evitó el backfill — las
suscripciones existentes siguieron funcionando. Ver "Cerrar
push_subscriptions" en `CLAUDE.md`.

**✅ RLS abierta en `reports` y `app_config` — resuelto** (v12.0, v14.0, v14.1)
Ver "Ya implementado". Queda una sola política en `reports`: `public
read:SELECT`.

**✅ Rate-limit de `admin-login` — resuelto**
El contador vive en `public.admin_login_attempts` en vez de un `Map` en
memoria que se reseteaba en cada cold start.

**🟢 El password de admin ya no es solo un "gate de conveniencia"**
Esto cambió y conviene no repetir la frase vieja: cuando la RLS estaba
abierta, el login no protegía nada porque cualquiera con la anon key podía
hacer lo mismo por la API. Hoy **sí** es la única vía para borrar un reporte
ajeno y para editar `app_config`. Sigue siendo un password compartido, sin
usuarios ni sesiones, y `admin.html` lo guarda en `sessionStorage` para
reenviarlo en cada acción — aceptable para el uso actual, pero ya no es cierto
que "no protege nada".
- Esfuerzo: n/a, solo mantenerlo en mente.

---

## 2. Datos y escalabilidad

**✅ Fotos en base64 dentro de `reports.photo` — resuelto**
Pasaron a Storage, y desde v14.1 no se aceptan fotos nuevas.

**✅ Sin límite/paginación en el fetch — resuelto** (v12.2 + v13.2)
El sondeo pide solo columnas explícitas y solo el área visible del mapa, con
un margen del 50%. Un `moveend` que se sale de la caja traída dispara un
refresco, para que el mapa no quede vacío tras panear.

**🟡 Polling de 8s en vez de Supabase Realtime**
Sigue siendo lo que más egreso consume, y el egreso del plan Free (5 GB/mes)
es el primer techo que se toca al crecer. Ya se le sacó bastante con lo de
arriba; el siguiente paso real es reemplazar el `setInterval` por una
suscripción de Realtime, que además bajaría la latencia de ver un reporte
nuevo.
- Esfuerzo: medio-alto, cambio de patrón. Repriorizar cuando el egreso
  vuelva a apretar, no antes.

---

## 3. Producto y funcionalidad

**✅ Fotos opcionales, con moderación — hecho** (v15.0)
Las fotos volvieron, pero por otra puerta: son **opcionales** y se adjuntan
**después** de publicar, no antes. Ese orden es todo el diseño — reportar
sigue siendo un toque, que es lo que hace usable la app manejando.

Y trajo la moderación con él, como decía este plan que había que hacer: se
denuncia una foto desde la hoja de detalle y con 3 denuncias se quita sola,
del mapa **y de Storage**. Se denuncia la imagen, no el reporte, que puede ser
perfectamente válido.

**Lo importante para el próximo cambio**: no hizo falta reabrir nada de lo que
v14.1 cerró. `create_report` sigue rechazando fotos y el bucket sigue sin
políticas — la subida pasa por el Edge Function `attach-photo`, que valida la
propiedad con el token y escribe con la `service_role` key. La invariante del
esquema se mantiene intacta: ninguna tabla acepta escritura directa.

Sigue apagado el flujo con la foto **antes** de publicar (`FLUJO_CON_FOTO`), y
conviene que siga así: obliga a sacarla en el momento, o sea manejando.

**🟢 Editar un reporte propio**
Quedó casi sin sentido: ya no hay nota que corregir ni categoría que elegir
(hay una sola). Lo único editable sería mover el pin, y para eso el "Deshacer"
de 6 s ya cubre el caso del error inmediato.
- Esfuerzo: bajo-medio, pero de valor dudoso hoy.

**🟢 Colapsar notificaciones push repetidas**
Decisión consciente de no hacerlo todavía: sin volumen real de suscriptores,
el ruido no es un dolor. Repriorizar si empiezan las quejas.
- Esfuerzo: medio.

**🟢 Imagen OG dinámica por reporte**
El preview reusa `icon-512.png` en vez de un thumbnail del mapa. Cosmético.
- Esfuerzo: medio-alto.

---

## 4. Accesibilidad

**✅ `admin.html` sin `aria-label` — resuelto**

**🟢 Alternativa por teclado para elegir ubicación**
El pin arrastrable depende del mapa táctil. Hoy solo se usa en el flujo con
foto *previa*, que está apagado, así que en la práctica no bloquea a nadie —
pero vuelve a importar si ese flujo se reactiva. (El panel admin sí tiene vía
por teclado: los inputs de coordenadas son la fuente de verdad.)
- Esfuerzo: medio.

---

## 5. Calidad y DX

**✅ Cero tests — resuelto**
14 suites de Playwright versionadas en `tests/`, con `node tests/run.js` —
incluida `check-admin-publicar.js`, la primera que cubre `admin.html`. Aparte
va `check-base-real.js`, que sí llega a Postgres.

**✅ Cero CI — resuelto**
`.github/workflows/tests.yml` corre `node tests/run.js` en cada push y cada
PR. El workflow manda el dominio de Supabase a 127.0.0.1 por `/etc/hosts`,
para que un hueco de mocking falle ruidoso en vez de tocar producción desde
CI.

**🟡 Que a `main` solo llegue código probado — falta un clic**
El CI ya corre en cada push y cada PR, pero **no frena nada por sí solo**:
Cloudflare despliega al recibir el push a `main`. El cierre es una **regla de
protección sobre `main`** que exija el check `playwright` antes de mergear —
un solo paso en Settings → Rules, sin token ni infraestructura nueva. Los
valores exactos (y el error clásico de poner `Tests` en vez de `playwright`)
están en "Cómo llega el código a producción" en `CLAUDE.md`.

Se evaluaron y descartaron dos alternativas: desplegar con `wrangler` desde el
workflow (redundante con `main` protegido, agrega un token que puede vencer y
duplica el mecanismo de despliegue) y una rama `release` intermedia (no
necesita token, pero agrega una rama para resolver lo mismo).
- Esfuerzo: un clic. ✅ **Hecho**: la regla de rama ya está activa.

**✅ Las suites no ven la base — resuelto en buena parte** (`check-base-real.js`)
Mockean la red y nunca llegan a Postgres: verde ahí no dice nada sobre RLS,
RPC ni triggers, y todos los bugs caros del proyecto se colaron por ese hueco
(la lista está en `tests/README.md`). Ahora hay un segundo script que pega
contra la base real y corre solo una vez por semana.

**Lo que se hizo distinto de lo que decía este plan.** Acá estaba anotado como
esfuerzo medio-alto "porque requiere un proyecto Supabase de pruebas o
`supabase start` local". No hizo falta ninguna de las dos cosas, y evitarlas
resultó ser *mejor*, no un atajo: una base de pruebas verifica una copia de la
configuración, y lo que hay que vigilar es **la de producción**, que es la que
se toca a mano desde el panel de Supabase y la que puede desviarse sin que
nadie lo note. Corriendo con la publishable key —pública por diseño— se mira
el sistema con los permisos exactos del atacante contra el que se cerró todo,
sin gestionar ningún secret.

El costo de esa decisión es que el script escribe en producción para poder
comprobar el borrado de forma concluyente (con un id inventado, un `DELETE`
bloqueado y uno que no encuentra nada devuelven **los dos 204**). Por eso la
sonda va en el medio del Lago Enriquillo y el tramo se saltea si el radio de
push es grande.

- Queda pendiente lo que estructuralmente no se puede ver con la anon key:
  que un `DELETE` directo no se lleve una suscripción push (esa tabla no tiene
  oráculo desde afuera, a propósito) y el tope por IP. Sigue siendo SQL a mano.

**🟢 Vigilar que `server.js` no vuelva a acumular lógica de API**
Hoy es puro servidor estático. Si alguien le agrega rutas `/api/*`, diverge en
silencio del modelo real en Supabase.
- Esfuerzo: n/a, solo revisión.

---

## Orden sugerido

1. ~~CI que corra las suites en cada push~~ ✅ hecho
2. ~~Cerrar `push_subscriptions`~~ ✅ hecho
3. ~~**Proteger `main`**, que exija el check `playwright` antes de
   mergear~~ ✅ hecho (regla de rama creada; ya no se puede pushear directo)
4. ~~Radio de las notificaciones push configurable~~ ✅ hecho (v14.5) — era
   el último número que exigía redesplegar un Edge Function para cambiarlo
5. ~~**Automatizar chequeos contra la base real**~~ ✅ hecho
   (`tests/check-base-real.js` + workflow semanal)
6. **Realtime**, cuando el egreso vuelva a ser el problema. **Es lo de mayor
   prioridad que queda**, y es condicional: no hay nada que hacer hasta que el
   egreso moleste.
7. Resto (imagen OG dinámica, colapsar notificaciones, teclado en el picker,
   editar reporte propio).

**Condicional, fuera del orden**: si algún día se reactiva `FLUJO_CON_FOTO`
(la foto **antes** de publicar), hay que revisar la moderación de nuevo — la
de v15.0 asume que solo el autor puede adjuntar, con su token.
