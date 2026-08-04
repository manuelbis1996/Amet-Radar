-- Hace configurable el radio de las notificaciones push, que hasta ahora era
-- una constante dentro del Edge Function `notify-nearby` (RADIUS_METERS=2000).
--
-- POR QUÉ. Es el único número del sistema que no se podía tocar sin editar
-- código y redesplegar una función. Y es un número de producto, no de
-- seguridad: cuánto de lejos avisar depende de qué tan grande sea la ciudad y
-- de cuánto ruido tolere la gente — eso se ajusta probando, no en un commit.
--
-- POR QUÉ ES SEGURO LEERLO DE `app_config`, dado el antecedente. La lección de
-- v12.0 fue que una función que lee su umbral de una tabla escribible por
-- cualquiera es tan insegura como esa tabla: `purge_expired_reports()` sacaba
-- `max_age_minutes` de acá y `anon` podía editarlo, o sea vaciar la base en
-- dos peticiones. Eso se cerró: `app_config` ya no tiene política de UPDATE y
-- solo se edita por `admin-update-config`, que valida rangos.
--
-- Además, este parámetro **no decide ningún borrado**. El peor caso de un
-- valor absurdo es mandar avisos de más o de menos; no se pierde nada. Por eso
-- el rango permitido puede ser generoso sin riesgo.

alter table public.app_config
  add column if not exists push_radius_meters integer not null default 2000;

comment on column public.app_config.push_radius_meters is
  'Radio en metros para las notificaciones push por cercanía. Lo lee el Edge '
  'Function notify-nearby en cada disparo; si la lectura falla, cae al valor '
  'por defecto de 2000 para no quedarse sin notificar. Se edita desde el '
  'panel admin, que valida el rango en admin-update-config.';

-- El check es la última red: aunque alguien edite la fila por fuera del
-- endpoint (hoy: solo con la service_role key), no puede dejar un valor que
-- rompa el cálculo del bounding box.
alter table public.app_config
  drop constraint if exists app_config_push_radius_range;
alter table public.app_config
  add constraint app_config_push_radius_range
  check (push_radius_meters between 100 and 50000);
