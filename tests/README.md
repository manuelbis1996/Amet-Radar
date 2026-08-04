# Tests

Suites de Playwright que cubren `amet-radar.html`. No hay framework: cada
archivo es un script de Node que imprime `OK` / `FALLA` por chequeo y sale
con código distinto de cero si algo falla — mismo criterio "sin
dependencias" que el resto del proyecto.

```bash
node tests/run.js                 # todas
node tests/run.js seguridad area  # solo las que coincidan con esos nombres
```

`run.js` levanta `server.js` en el puerto 8171 (cambiable con `TEST_PORT`),
corre las suites en serie y apaga el servidor al terminar.

Requiere Playwright con Chromium disponible:

```bash
npm install -g playwright && npx playwright install chromium
```

## Por qué hay un stub de MapLibre

`maplibre-stub.js` reemplaza a la librería real. No es por gusto: el entorno
donde se escribieron estos tests bloquea tanto el CDN de unpkg como los
tiles de OpenFreeMap, así que la librería no puede cargar. El stub imita lo
que la app usa (`Map`, `Marker`, `getBounds`, `easeTo`, `jumpTo`, `panTo`,
eventos) y expone `window.__map` para poder auditar las llamadas.

**Consecuencia importante**: estos tests verifican el *comportamiento* de la
app, no cómo se ve el mapa. El render visual hay que mirarlo en un teléfono.

**El stub solo tiene lo que alguien usó alguna vez.** Es un doble parcial, no
una implementación: si tocás código que llama a un método de MapLibre que
todavía nadie usaba, el test falla con `X is not a function` y **parece un bug
del producto cuando es un hueco del doble**. Ya pasó: `Marker.on()` no
existía —la app nunca engancha eventos del marcador, lee `getLngLat()` al
confirmar— y al usarlo el panel admin, `initAdminMap()` tiraba en los tests
mientras en un navegador real funciona perfecto. Antes de dar por roto el
código, revisá si el método está acá.

## Qué cubre cada una

| Suite | Qué protege |
|---|---|
| `check-admin-publicar.js` | Que el panel publique por `rpc/create_report` (sin endpoint privilegiado nuevo), mandando las coordenadas **del pin** y no las del dispositivo; que ofrezca las 4 categorías; que dibuje en el mapa los reportes existentes y el recién publicado; que un rechazo se muestre con su motivo; y que **si MapLibre no carga, el panel no se caiga** y se pueda publicar igual con las coordenadas a mano |
| `check-antispam.js` | Que publicar vaya por `rpc/create_report` y **no** por el `POST` directo (cerrado en v14.0); que un rechazo `duplicate`/`rate_limit` tenga su mensaje, no gaste cupo local ni se encole; y que la cola offline reintente con el **mismo id** tratando `already_exists` como éxito |
| `check-untoque.js` | Reportar es un solo toque: sin pantallas intermedias, categoría `reten_fijo`, `owner_hash` presente, y Deshacer borra en el servidor y devuelve el cupo |
| `check-seguridad.js` | Que la app no emita ningún `DELETE`/`PATCH` directo contra `reports`, `app_config` ni el bucket; que votar vaya por RPC sin mandar totales; que borrar exija el token de propiedad |
| `check-area.js` | Que el sondeo acote por área visible **y** que un link compartido a un reporte de otra ciudad siga abriendo (es la palanca de crecimiento del proyecto) |
| `check-publicar.js` | Publicación completa con foto + deep link `?r=` |
| `check-maplibre.js` | Migración a MapLibre: estilo, zoom, límites de RD, pines, círculo aproximado, seguimiento |
| `check-gps.js` | Atajo por GPS y comportamiento sin GPS |
| `check-pin.js` | Pin arrastrable para elegir el lugar |
| `check-cerrar.js` | Tocar fuera cierra las hojas (y las que están procesando, no) |
| `check-voto.js` | Estado visible del voto y colores de categoría |
| `check-vacio.js` | Píldora "Todo tranquilo por aquí": tamaño y que no tape nada |
| `check-ux.js` | Detalles de diseño (botón Compartir destacado, estado vacío) |

## Lo que estas suites NO pueden ver

Mockean la red, así que **nunca llegan a Postgres**. Verde acá no dice nada
sobre RLS, funciones RPC, triggers, grants ni Storage.

No es teórico: **los bugs más caros de este proyecto se colaron justo por ese
hueco**, y todos tenían el cliente en verde cuando explotaron.

| Bug | Por qué el cliente no lo vio |
|---|---|
| Supabase prohíbe `delete from storage.objects` por SQL (trigger `storage.protect_delete`); la excepción se llevaba puesta la transacción y rompía los **cuatro** caminos de borrado | El mock del `DELETE` contestaba 200 igual |
| `return query` en plpgsql agrega filas y **sigue ejecutando**: `vote_report` devolvía dos | El cliente lee `rows[0]` y acertaba de casualidad |
| Los nombres de salida de un `returns table(...)` son variables de plpgsql y chocan con las columnas | Nunca se ejecutó una línea de plpgsql |
| `revoke all ... from public` también se lo saca a `service_role` | El panel admin estaba mockeado |
| `app_config` tenía `update` abierto para `anon`, y `purge_expired_reports()` lee su umbral de ahí: dos peticiones vaciaban la base | Nada de eso pasa por el navegador |
| El dedupe corría antes del chequeo de id, así que el reintento de la cola offline recibía `duplicate` sobre un reporte que **sí** se había publicado (v14.0) | El mock contesta lo que se le diga |

Para cualquier cambio que toque RLS, funciones de la base, triggers, grants o
Edge Functions, hay que verificar también así:

```sql
begin;
  -- preparar datos
  set local role anon;
  -- intentar el ataque / el camino legítimo
rollback;
```

Dos cosas prácticas al hacerlo:

- **Siempre `rollback`.** Un `insert` en `reports` dispara
  `reports_notify_nearby`, que manda notificaciones push **a usuarios
  reales**. Dentro de una transacción revertida, la llamada que encola
  `pg_net` se descarta con todo lo demás.
- **Las cabeceras HTTP se pueden simular.** PostgREST las expone en un GUC
  que en SQL no existe, pero se puede setear a mano:

  ```sql
  set local request.headers = '{"cf-connecting-ip":"203.0.113.7"}';
  ```

  Así se ejercita el tope por IP de `create_report` sin salir de SQL.

## Flujo con foto, hoy desactivado

> **⚠️ Punto ciego concreto y actual.** Desde v14.1 el servidor **rechaza
> toda foto y toda nota** (se cerró la política de insert del bucket y
> `create_report` devuelve `invalid` si vienen). Las suites de acá abajo
> siguen publicando con foto contra un mock que contesta `ok`, así que
> **siguen en verde aunque en producción esa publicación falle**. No es un
> bug de las suites: cubren el comportamiento de la interfaz de un flujo que
> se dejó completo a propósito. Pero si alguien reactiva `FLUJO_CON_FOTO`,
> el verde de acá **no** significa que funcione — hay que reabrir la
> política del bucket y el rechazo en `create_report`, y probarlo contra la
> base real.

Desde v13.0 el flujo con foto no tiene entrada en la interfaz, pero el
código sigue completo. Las suites que lo cubren
(`check-maplibre`, `check-pin`, `check-publicar`, `check-gps`, `check-voto`,
`check-cerrar`) lo activan con `window.__ametFlujoConFoto = true` antes de
cargar la página. Ver `FLUJO_CON_FOTO` en `amet-radar.html`.
