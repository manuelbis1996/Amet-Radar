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

## Qué cubre cada una

| Suite | Qué protege |
|---|---|
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

Mockean la red, así que **nunca llegan a Postgres**. Tres bugs reales de
este proyecto solo aparecieron probando contra la base de verdad con el rol
`anon` (ver "Seguridad de escritura" en `CLAUDE.md`). Para cualquier cambio
que toque RLS, funciones de la base o Edge Functions, hay que verificar
también así:

```sql
begin;
  -- preparar datos
  set local role anon;
  -- intentar el ataque / el camino legítimo
rollback;
```

## Flujo con foto, hoy desactivado

Desde v13.0 el flujo con foto no tiene entrada en la interfaz, pero el
código sigue completo. Las suites que lo cubren
(`check-maplibre`, `check-pin`, `check-publicar`, `check-gps`, `check-voto`,
`check-cerrar`) lo activan con `window.__ametFlujoConFoto = true` antes de
cargar la página. Ver `FLUJO_CON_FOTO` en `amet-radar.html`.
