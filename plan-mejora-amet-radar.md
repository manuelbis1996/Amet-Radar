# Plan de Mejora — AMET Radar

App de reportes comunitarios de retenes/AMET sobre **MapLibre GL**, con
publicación de **un toque** (ubicación + categoría, sin foto ni nota), backend
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
- **Fotos y notas cerradas** (v14.1): sin política de insert en el bucket y
  `create_report` las rechaza. Era el último bloqueante conocido.
- **`app_config` cerrada** (v12.0): el `update` de `anon` permitía mover la
  definición de "vencido" y vaciar la base por una puerta lateral.
- **Reportar es un toque** (v13.0), con "Deshacer" de 6 s como red de
  seguridad.
- **Confirmación comunitaria** ("Sigue ahí" / "Ya no está"), con el retiro
  decidido por el servidor.
- **Fetch acotado al área visible** (v13.2) y columnas explícitas en el
  sondeo (v12.2): juntos, lo que más bajó el egreso.
- **Fotos fuera de la fila** (Storage en vez de base64), aunque hoy el flujo
  esté cerrado.
- **Notificaciones push por cercanía** (radio 2 km).
- **Compartir**: deep link `?r=` + preview dinámico por reporte para bots,
  servido por el Worker de Cloudflare.
- **Panel de administración** (`admin.html`), con el borrado y la edición de
  parámetros detrás de Edge Functions con password.
- **PWA instalable**; mapa limitado a República Dominicana.
- **12 suites de Playwright** versionadas en `tests/`.

---

## 1. Seguridad

**🔴 `push_subscriptions` es la última tabla con escritura abierta**
Es el mismo agujero que v12.0 cerró para `reports`, y sigue vivo. Las tres
políticas son `USING (true)` / `WITH CHECK (true)`, así que con la anon key
—pública por diseño— una sola petición se lleva puestas **todas** las
suscripciones:

```
DELETE /rest/v1/push_subscriptions?endpoint=neq.x
```

y un `PATCH` puede reescribirle el `lat`/`lng` a cualquiera, o sea mandarle
las notificaciones de otra ciudad. **Verificado contra producción** (con un
filtro que no matchea ninguna fila, para no borrar nada real): `DELETE` y
`PATCH` responden 204, o sea que la política los permite.

Lo peor es que **el daño es silencioso**: nadie se entera de que dejó de
recibir avisos, no hay error visible, y hay que volver a suscribirse a mano
dispositivo por dispositivo. Es justamente la palanca de retención del
proyecto.

Por qué no se cerró junto con lo demás: no hay forma obvia de probar
"esta suscripción es mía" — el `endpoint` es el identificador y a la vez el
secreto. La salida más limpia es el mismo patrón que ya se usa para los
reportes: que el cliente guarde un token al suscribirse, que la base guarde su
hash, y mover el alta/baja/actualización a una RPC. La tabla no tiene política
de `select`, así que la RPC además resuelve el gotcha de PostgREST que ya está
documentado.
- Esfuerzo: medio. Es el único ítem 🔴 que queda.

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

**🟢 Moderación / denuncia de abuso — solo si vuelven las fotos**
Estaba como bloqueante y se cerró de raíz en v14.1 quitando la posibilidad de
subir fotos y escribir notas, que era por donde entraba el contenido abusivo.
Mientras la app publique solo (ubicación, categoría, momento) **no hay
contenido que moderar**. El día que se reactive `FLUJO_CON_FOTO` esto vuelve a
ser un requisito y hay que construirlo **junto con** la reapertura, no después.
- Esfuerzo: medio-alto. Bloqueante condicional.

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
foto, que está apagado, así que en la práctica no bloquea a nadie — pero
vuelve a importar si ese flujo se reactiva.
- Esfuerzo: medio.

---

## 5. Calidad y DX

**✅ Cero tests — resuelto**
12 suites de Playwright versionadas en `tests/`, con `node tests/run.js`.

**✅ Cero CI — resuelto**
`.github/workflows/tests.yml` corre `node tests/run.js` en cada push y cada
PR. El workflow manda el dominio de Supabase a 127.0.0.1 por `/etc/hosts`,
para que un hueco de mocking falle ruidoso en vez de tocar producción desde
CI.

**🟡 El CI no frena un despliegue malo**
Cloudflare está conectado al repo y despliega al recibir el push a `main`, en
paralelo con el workflow: si las suites fallan, la regresión ya salió a
producción y el CI solo avisa. Para cerrarlo hay que desconectar la
integración de git de Cloudflare y desplegar desde el workflow con
`wrangler deploy`, condicionado a que los tests pasen, con un
`CLOUDFLARE_API_TOKEN` en los secrets del repo.
- Esfuerzo: bajo-medio. El riesgo no es técnico sino operativo: si el token o
  el workflow se rompen, deja de haber despliegue hasta arreglarlo.

**🟡 Las suites no ven la base, y eso ya costó caro**
Mockean la red y nunca llegan a Postgres: verde ahí no dice nada sobre RLS,
RPC ni triggers. Todos los bugs caros del proyecto se colaron por ese hueco
(la lista está en `tests/README.md`). Hoy la verificación contra la base real
es manual, con `begin; set local role anon; ...; rollback;`. Automatizar
aunque sea un puñado de esos chequeos contra una base de pruebas cerraría el
agujero de verdad.
- Esfuerzo: medio-alto (requiere un proyecto Supabase de pruebas o
  `supabase start` local).

**🟢 Vigilar que `server.js` no vuelva a acumular lógica de API**
Hoy es puro servidor estático. Si alguien le agrega rutas `/api/*`, diverge en
silencio del modelo real en Supabase.
- Esfuerzo: n/a, solo revisión.

---

## Orden sugerido

1. ~~CI que corra las suites en cada push~~ ✅ hecho
2. **Cerrar `push_subscriptions`** — el único 🔴 que queda, y el mismo tipo de
   agujero que ya se cerró en `reports`.
3. **Que el CI frene el despliegue** — hoy avisa tarde; desplegar desde el
   workflow lo convierte en una barrera de verdad.
4. **Automatizar algunos chequeos contra la base real** — es donde
   históricamente aparecen los bugs.
5. **Realtime**, cuando el egreso vuelva a ser el problema.
6. Resto (imagen OG dinámica, colapsar notificaciones, teclado en el picker,
   editar reporte propio).

**Condicional, fuera del orden**: si se reactiva el flujo con foto, la
moderación deja de ser 🟢 y pasa a ser bloqueante en el mismo cambio.
