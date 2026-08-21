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
app, no cómo se ve el mapa. El render visual **ya no hay que mirarlo solo en
un teléfono**: desde v17.5 se puede capturar la app real sobre tiles reales
desde acá — Chromium con `--use-angle=swiftshader`, la librería servida desde
el disco (el navegador no alcanza unpkg) y los tiles interceptados con
`page.route` y cumplidos con el `fetch` de node, que sí sale. Ver "Se pueden renderizar mapas
REALES desde el sandbox" en `CLAUDE.md`. Las suites siguen con el stub a
propósito: son rápidas y deterministas; aquello es para decidir cuestiones
visuales, no para probar lógica.

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
| `check-admin-publicar.js` | Que el panel publique por `rpc/create_report` (sin endpoint privilegiado nuevo), mandando las coordenadas **del pin** y no las del dispositivo; que ofrezca las 4 categorías; que dibuje en el mapa los reportes existentes y el recién publicado; que un rechazo se muestre con su motivo; que se pueda **eliminar un reporte tocándolo en el mapa**; que el radio de las notificaciones push se cargue de `app_config` y viaje en el guardado; y que **si MapLibre no carga, el panel no se caiga** y se pueda publicar igual con las coordenadas a mano |
| `check-admin-herramientas.js` | Herramientas de moderación del panel (v16.1): estadísticas que separan **activos de vencidos**; filtros que achican la tabla pero **nunca el mapa**; «Ver» que centra el mapa y abre la ficha; «Link» que copia el mismo `?r=<id>` que comparte la app; CSV con BOM que exporta **lo que la tabla muestra**; purga de vencidos por la misma `rpc/purge_expired_reports` pública; refresco a pedido con marca de hora; y que el aviso de push muestre el **radio configurado**, no un "2 km" fijo; que se pidan las métricas de `admin-metrics` y se dibujen los 14 días (incluidos los que están en cero); y que «Quitar foto» aparezca solo si hay foto y mande `solo_foto:true` en vez de un borrado |
| `check-antispam.js` | Que publicar vaya por `rpc/create_report` y **no** por el `POST` directo (cerrado en v14.0); que un rechazo `duplicate`/`rate_limit` tenga su mensaje, no gaste cupo local ni se encole; y que la cola offline reintente con el **mismo id** tratando `already_exists` como éxito |
| `check-untoque.js` | Reportar es un solo toque: sin pantallas intermedias, categoría `reten_fijo`, `owner_hash` presente, y Deshacer borra en el servidor y devuelve el cupo |
| `check-seguridad.js` | Que la app no emita ningún `DELETE`/`PATCH` directo contra `reports`, `app_config` ni el bucket; que votar vaya por RPC sin mandar totales; que borrar exija el token de propiedad |
| `check-preview.js` | La tarjeta que ve WhatsApp al compartir un reporte (v17.6). Única suite que NO usa Playwright: importa `_worker.js` y le mockea el `fetch` y el binding `ASSETS`. Que el título diga **en qué calle** fue marcado; que si Nominatim se cae el preview **no se rompa**; que la imagen sea la foto real si la hay y si no la tarjeta 1200×630 de su categoría; que una foto vieja en `data:` no se use; y que a un usuario real no se le gaste una llamada de geocodificación |
| `check-arranque.js` | El arranque en frío y la honestidad de los estados: que el loader se suelte con el **mapa y no con el GPS** (más el tope para cuando el estilo nunca carga); que el primer fix **no recentre** el mapa si el usuario ya paneó; que **sin GPS se pueda reportar igual** con el pin, publicando las coordenadas del pin y como punto exacto; que un servidor caído se distinga de un mapa vacío; y que un voto que no llegó **no se dé por bueno** ni queme el reintento |
| `check-crecimiento.js` | Lo que hace que la app se reparta: que se pueda **compartir la app sin ningún reporte** (el estado del día 1); que el enlace de un reporte apunte a la **raíz** y no a `/amet-radar.html`, porque ahí el Worker no corre y no hay preview; que un link a un reporte vencido lo diga; que los avisos se ofrezcan **una vez** tras el primer reporte sin disparar solos el permiso; y que los dos botones de la topbar entren a 320px |
| `check-campana.js` | La campana de los avisos push (v17.9), tres fallos silenciosos: que **responda siempre** —el listener se enganchaba después de esperar a `serviceWorker.ready`, que no resuelve nunca si el service worker no se activa, así que la campana quedaba visible y MUDA—; que no afirme "apagada" antes de saberlo (un dispositivo ya suscripto se veía gris); y que diga la verdad — `aria-label`/`title` que siguen al estado, `aria-pressed`, y un punto que marca el encendido con una diferencia de **forma** y no solo el tinte violeta sobre un ícono idéntico. **Lo que no puede ver**: que el push llegue a un teléfono de verdad |
| `check-instalar.js` | La oferta de instalar la app (v17.7): que **no** aparezca en la primera apertura pero sí en la segunda; que el banner propio de Chrome se frene con `preventDefault` para decidir nosotros cuándo; que aceptar dispare el diálogo **real** del navegador; que no se insista nunca más, ni tras un "Ahora no"; que no se ofrezca si ya está instalada ni si el navegador no puede instalarla; y que en iPhone —donde no hay API— se explique el camino a mano en vez de mostrar un botón que no haría nada. **Lo que no puede ver**: que Chrome emita `beforeinstallprompt` de verdad (no dispara en headless: depende de sus heurísticas de engagement) — acá se despacha un evento sintético con la misma forma, así que se prueba nuestra lógica, no la del navegador. Eso solo se ve en un teléfono |
| `check-acerca.js` | La hoja "Acerca de" (v17.8): que las dos entradas (botón ⓘ de la topbar y enlace de la bienvenida) la abran y que se cierre igual que cualquier hoja; que diga las tres cosas que tiene que decir —autoría y contacto, qué datos se guardan, y que los reportes no están verificados—; que la topbar de **tres** botones siga entrando a 320 px sin solaparse con la marca; y que `admin.html` lleve `noindex`. El chequeo que más importa es el único que **no mira el DOM**: lee `amet-radar.html` del repo y falla si el correo aparece escrito entero, que es lo que lo dejaría a merced de un scraper |
| `check-sync.js` | Que un reporte borrado desde OTRO dispositivo desaparezca de este: el marcador se va, el contador baja, la hoja de detalle abierta se cierra avisando — y que el barrido que hace eso **no se lleve puestos los reportes de la cola offline**, que existen como marcador sin estar en `reportsCache` |
| `check-area.js` | Que el sondeo acote por área visible **y** que un link compartido a un reporte de otra ciudad siga abriendo (es la palanca de crecimiento del proyecto) |
| `check-publicar.js` | Publicación completa con foto + deep link `?r=` |
| `check-maplibre.js` | Migración a MapLibre: estilo, zoom, límites de RD, pines, círculo aproximado, seguimiento |
| `check-gps.js` | Atajo por GPS y comportamiento sin GPS |
| `check-pin.js` | Pin **fijo al centro** para elegir el lugar (v17.3: se mueve el mapa, no el pin): que no intercepte toques, que el punto salga de `map.getCenter()` y que se limpie al confirmar y al cancelar |
| `check-cerrar.js` | Tocar fuera cierra las hojas (y las que están procesando, no) |
| `check-voto.js` | Estado visible del voto y colores de categoría |
| `check-vacio.js` | Píldora "Todo tranquilo por aquí": tamaño y que no tape nada |
| `check-ux.js` | Detalles de diseño (botón Compartir destacado, estado vacío) |
| `check-foto-opcional.js` | Fotos opcionales (v15.0): que publicar siga siendo **un toque** y la foto no meta ningún paso antes; que no viaje en `create_report` sino por `attach-photo` con el token; que la cámara del pin aparezca solo si hay foto; y que una denuncia que alcanza el umbral la saque de la vista |

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

### `check-base-real.js` — parte de esto ya está automatizado

Buena parte de esa verificación dejó de ser manual:

```bash
node tests/check-base-real.js                 # todo
node tests/check-base-real.js --solo-lectura  # sin publicar la sonda
```

**No pide ningún secret.** Usa la misma publishable key que ya está en
`amet-radar.html`, o sea que mira el sistema con los mismos permisos que
tendría cualquiera que lea el código fuente de la página — que es exactamente
el atacante contra el que se cerró todo. Si algún día pide credenciales, algo
se desvió.

**Desde v17.1 también comprueba que el push siga vivo** — era el punto ciego
más grande del proyecto. Antes publicaba la sonda, que dispara la notificación
de verdad, pero **no miraba nunca el resultado**: un `notify-nearby` muerto
pasaba en verde, y ningún otro lugar lo habría denunciado (el trigger de
`pg_net` descarta la respuesta y el panel muestra uso, no salud). Ahora llama a
la función por el mismo camino y con la misma key que usa el trigger, así que
en un solo chequeo cubre que la key sirva, que las VAPID estén configuradas,
que la `service_role` pueda leer `push_subscriptions` y que el radio salga de
`app_config`.

Corre solo, semanalmente y a pedido, por `.github/workflows/base-real.yml`.
**Queda fuera de `run.js` a propósito**: la convención es que
`check-*-real.js` no entra en esa corrida, porque el CI manda el dominio de
Supabase a `127.0.0.1` para que ninguna suite toque producción por accidente,
y porque el check que protege `main` no puede depender de que un servicio
externo esté arriba.

Qué cubre: que leer siga abierto (si esto falla, lo demás son falsos
positivos); que `POST`/`PATCH`/`DELETE` directos estén cerrados en `reports`,
`app_config`, `push_subscriptions` y el bucket; que `report_events`,
`rate_limit_salt` y las funciones privadas no le respondan a `anon`; que
`create_report`, `subscribe_push` y `flag_photo` validen la entrada; y un
**ciclo de sonda** que publica un reporte propio para poder comprobar de forma
concluyente que un `DELETE` directo no se lo lleva, que un `PATCH` no infla los
votos, que `vote_report` suma de a uno y devuelve una sola fila, que la
propiedad se valida por token, y todo el camino de la foto opcional (adjuntar
con el token equivocado se rechaza, con el correcto no; la foto queda servida
con cache corto; no se puede reemplazar; tres denuncias la esconden y el
reporte sobrevive).

Tres trampas que este archivo encapsula, y que ya dieron un rojo falso y un
verde falso mientras se escribía:

- **Un `PATCH`/`DELETE` contra una tabla sin política devuelve `204`, no
  `401`.** RLS hace que no matchee ninguna fila y PostgREST contesta lo mismo
  que si no hubiera habido nada que tocar: el status **no distingue
  "bloqueado" de "no había nada"**. Por eso el payload lleva un valor que
  además viola un `CHECK` de la columna — así un `400` delata que la política
  volvió, y de paso nada se escribe si eso pasa. (El `POST` sí da `401`,
  porque ahí RLS rechaza la fila nueva explícitamente.)
- **Un `404` de PostgREST no quiere decir "no tenés permiso"**, quiere decir
  "no encontré una función con esa firma". Llamar a `_client_ip()` con
  `{p_id:'x'}` da `404` por firma que no matchea, y el chequeo pasaría en
  verde aunque la función estuviera abierta a todo el mundo. Por eso cada
  función se llama con su firma real y se mira el **código de Postgres**
  (`42501` = permiso denegado; `PGRST202` = no está en el schema cache, que es
  lo esperable en las de trigger).
- **Probar el borrado con un id inventado da un verde falso**, por lo mismo
  del primer punto. Hay que borrar algo que sabemos que existe y después mirar
  si sigue existiendo: para eso está la sonda.

**La sonda escribe en producción**, así que tiene dos guardas. Se publica en
el medio del **Lago Enriquillo** (dentro de la caja de RD, que `create_report`
exige, pero es agua salada y no vive nadie), y si `push_radius_meters` está
por encima de 8 km el ciclo **se saltea entero** en vez de arriesgar que a
alguien real le suene el teléfono por una prueba — este archivo no puede leer
`push_subscriptions` para comprobar que no hay nadie cerca, y está bien que no
pueda. Se borra sola en un `finally`; si ni eso funciona, imprime el id para
sacarla a mano (y se autoexpira igual al llegar a `max_age_minutes`).

Se comprobó que la guarda **no es decorativa**, con una mutación real y
reversible: dándole `execute` sobre `_client_ip()` a `anon`, el chequeo pasa a
`FALLA` con `status=200`; al revocarlo, vuelve a verde.

### Lo que sigue necesitando SQL a mano

`check-base-real.js` solo tiene la anon key, así que hay cosas que
estructuralmente no puede ver:

- que un `DELETE`/`PATCH` directo **no se lleve una suscripción push**. La
  tabla no tiene política de SELECT (bien) y `unsubscribe_push` devuelve
  `true` aunque el endpoint no exista (también bien, si no se podría averiguar
  si un endpoint está dado de alta), o sea que no hay ningún oráculo desde
  afuera. Ojo al probarlo por SQL: **contar filas con el rol `anon` puesto
  siempre da 0**; hay que hacer `reset role` antes de verificar.
- el **tope por IP** de `create_report` (haría falta emitir 31 reportes).
- cualquier cosa que dependa de la `service_role` key o de mirar el plan de
  una consulta.
- que la notificación **llegue a un teléfono de verdad**. La sonda comprueba
  que `notify-nearby` responde bien, no que el push aterrice: eso solo se ve a
  mano, en un dispositivo real.
- **Y ojo con el workflow**: GitHub apaga los workflows programados a los 60
  días sin actividad en el repo. Un proyecto estable —que es el objetivo— deja
  de commitear y el chequeo semanal se desactiva solo. Tampoco avisa a nadie
  cuando falla.

Para eso, y para cualquier cambio que toque RLS, funciones de la base,
triggers, grants o Edge Functions:

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
