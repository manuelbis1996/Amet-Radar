<!--
Este repo despliega a producción al mergear a `main`. O sea que aprobar este
PR es publicar. La plantilla es corta a propósito; lo único que no conviene
saltear es la última sección.
-->

## Qué cambia y por qué

<!-- Una o dos frases. El "por qué" importa más que el "qué": el diff ya
     cuenta el qué. -->

## Cómo se verificó

- [ ] `node tests/run.js` en verde (el CI también lo corre solo)
- [ ] Probado a mano en el navegador, si toca la interfaz

<!-- Si el cambio toca RLS, una función de la base, un trigger, un grant o una
     Edge Function, marcá también esto — las suites mockean la red y NUNCA
     llegan a Postgres, que es por donde se colaron los bugs más caros de este
     proyecto (la lista está en tests/README.md). -->

- [ ] Verificado contra la base real con el rol `anon`
      (`begin; set local role anon; ...; rollback;`), **o** no aplica

## Versión

<!-- Si cambió amet-radar.html, sw.js, manifest.json o los íconos, hay que
     subir APP_VERSION y CACHE_NAME juntos, con el mismo sufijo. Si no, la
     PWA instalada se queda con la versión vieja. -->

- [ ] `APP_VERSION` y `CACHE_NAME` subidos juntos, **o** no aplica

## Qué se rompe

<!-- Lo más útil del PR. Si no se rompe nada, escribir "nada" — pero pensarlo
     antes. Cosas que en este proyecto ya mordieron: dejar clientes viejos sin
     poder publicar al cerrar una política antes de desplegar, cambiar el
     contrato de una RPC sin actualizar las suites, publicar un archivo nuevo
     sin agregarlo a .assetsignore. -->
