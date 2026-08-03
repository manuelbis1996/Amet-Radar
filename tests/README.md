# Pruebas de AMET Radar

```bash
node tests/run.js              # todas las suites
node tests/run.js antispam     # solo las que matcheen ese texto
```

Sale con código 0 si todo pasó, 1 si algo falló. No hace falta setear
`NODE_PATH`: el runner ubica solo el `playwright` global (el proyecto no tiene
`package.json` a propósito — cero dependencias).

Requiere Node y Playwright con Chromium instalado.

---

## Lo que estas suites NO pueden ver

**Esto es lo más importante de este archivo.** Las suites levantan un
navegador real, pero **mockean toda la red con `page.route()`**: nunca sale
una petición a Supabase. O sea que **nunca llegan a Postgres**.

Verde acá **no dice nada** sobre:

- políticas RLS (quién puede insertar, actualizar o borrar qué),
- funciones RPC (`create_report`, `vote_report`, `delete_own_report`,
  `purge_expired_reports`),
- triggers (`reports_notify_nearby`, `reports_delete_photo`),
- permisos y grants por rol,
- lo que hace Storage.

No es una limitación teórica: **los bugs más caros de este proyecto se
colaron exactamente por ese hueco**, y todos estaban en verde en el cliente
cuando explotaron:

| Bug | Por qué el cliente no lo vio |
|---|---|
| Supabase prohíbe `delete from storage.objects` por SQL (trigger `storage.protect_delete`), y la excepción se llevaba puesta la transacción entera — rompía los **cuatro** caminos de borrado | El mock del `DELETE` contestaba 200 igual |
| `return query` en plpgsql agrega filas y **sigue ejecutando**: `vote_report` devolvía dos filas | El cliente lee `rows[0]` y acertaba de casualidad |
| Los nombres de salida de un `returns table(...)` son variables de plpgsql y chocan con las columnas | Nunca se ejecutó una línea de plpgsql |
| `revoke all ... from public` también se lo saca a `service_role` | El panel admin estaba mockeado |
| `app_config` tenía `update` abierto para `anon`, y `purge_expired_reports()` lee su umbral de ahí: dos peticiones vaciaban la base | Nada de eso pasa por el navegador |
| El dedupe corría antes del chequeo de id, así que el reintento de la cola offline recibía `duplicate` sobre un reporte que sí se había publicado | El mock contesta lo que se le diga |

**Regla, y no es negociable:** si un cambio toca RLS, una RPC, un trigger o
un grant, hay que probarlo **contra la base real con el rol `anon`**, en una
transacción que se revierta:

```sql
begin;
set local role anon;
-- ... lo que se quiera probar ...
rollback;
```

Dos cuidados al hacerlo:

- **Siempre `rollback`.** Un `insert` en `reports` dispara
  `reports_notify_nearby`, que manda notificaciones push **a usuarios
  reales**. Dentro de una transacción revertida, la llamada encolada por
  `pg_net` se descarta con todo lo demás.
- **Para simular las cabeceras HTTP** (que PostgREST expone y en SQL no
  existen), se puede setear el GUC a mano:

  ```sql
  set local request.headers = '{"cf-connecting-ip":"203.0.113.7"}';
  ```

  Así se puede ejercitar el tope por IP de `create_report` sin salir de SQL.

---

## Las suites

| Archivo | Qué cubre |
|---|---|
| `check-antispam.js` | El flujo de publicar contra la RPC `create_report` (v14.0) — ver detalle abajo |

### `check-antispam.js` (21 chequeos)

Del lado del **cliente**, que es lo único que estas suites alcanzan:

- publicar llama a `rpc/create_report` y **no** al `POST /rest/v1/reports`
  (verificado en los dos flujos: el rápido y el de foto);
- el payload lleva el `owner_hash` — o sea que `stampOwnership()` corre
  **antes** del envío, que es lo que permite borrar el reporte después;
- el reporte rápido va con `approx:true`, categoría `reten_fijo` y sin foto;
- un rechazo `duplicate` muestra su mensaje propio, cierra la hoja, **no
  gasta cupo local** y **no se encola** para reintentar;
- un rechazo `rate_limit` tiene su propio mensaje, distinto del genérico;
- una caída de red sí encola, y el reporte encolado ya lleva su `owner_hash`;
- la cola reintenta con el **mismo id** (no uno nuevo) y trata
  `already_exists` como éxito, vaciando la cola sin mostrar error.

Lo que esta suite **no** prueba, porque vive en el servidor: el dedupe por
proximidad, el tope por IP, las validaciones de entrada y la extracción de la
IP. Todo eso se verificó contra la base real (ver arriba) y está documentado
en CLAUDE.md, "Anti-spam del lado del servidor".

---

## Agregar una suite

Crear `tests/check-loquesea.js`. El runner la toma sola, sin registrarla en
ningún lado. Contrato:

1. Es un script de Node que corre solo (`node tests/check-loquesea.js`).
2. Sale con código 0 si pasó y != 0 si falló.
3. Levanta y baja su propio `server.js`, y toma el puerto de
   `process.env.AMET_TEST_PORT` (el runner le da uno distinto a cada suite).

### `maplibre-stub.js`

No es una suite: es el doble de MapLibre GL que comparten todas. Existe
porque el sandbox bloquea el CDN de unpkg y los tiles de OpenFreeMap, así que
la librería real nunca carga y la app revienta en `new maplibregl.Map(...)`
antes de ejecutar una línea del flujo que se quiere probar.

Cubre **solo** la superficie que `amet-radar.html` usa de verdad. Si la app
empieza a llamar a otro método del mapa, hay que ampliarlo o la suite falla
con `is not a function`. **No dibuja nada**: el render visual no se verifica
acá, eso hay que mirarlo en el teléfono.

---

## Nota sobre el historial

Hubo 11 suites anteriores (`check-publicar.js`, `check-area.js` y otras, que
CLAUDE.md menciona) que vivían en el directorio temporal de una sesión y
**se perdieron** al reciclarse el contenedor. Por eso lo que hay acá está
versionado en el repo, y por eso `tests/` está en `.assetsignore`: sin esa
línea, con `assets.directory: "./"` en `wrangler.jsonc`, estos archivos se
publicarían como assets servibles en producción.
