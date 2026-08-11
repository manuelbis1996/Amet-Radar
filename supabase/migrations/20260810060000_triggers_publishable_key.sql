-- Los tres triggers de pg_net dejan de usar la anon key LEGACY (formato JWT)
-- y pasan a la publishable key nueva, la misma que ya usan la app y el panel.
--
-- POR QUÉ. Hasta acá `notify_nearby_reports`, `delete_report_photo` y
-- `clear_report_photo` se autenticaban con la key vieja en formato JWT
-- (`eyJhbGciOi...`), embebida en tres migraciones, mientras que todo lo demás
-- del proyecto usa `sb_publishable_...`. Supabase ofrece —y empuja—
-- deshabilitar las legacy JWT keys desde el dashboard, y el día que alguien
-- acepte esa oferta los tres triggers empiezan a recibir 401:
--
--   * las notificaciones push dejan de salir,
--   * las fotos dejan de borrarse de Storage al borrarse su reporte,
--   * y NADA lo denuncia: la app, el panel y las 18 suites siguen en verde,
--     porque ninguno de los tres usa esa key.
--
-- Es el peor tipo de fallo que puede tener este sistema: silencioso, y
-- disparado por una acción de mantenimiento que parece inofensiva. Se elimina
-- la dependencia en vez de dejar una nota pidiendo que nadie toque ese botón.
--
-- VERIFICADO ANTES DE APLICAR, y no es obvio: `notify-nearby` y `delete-photo`
-- tienen `verify_jwt: true`, así que la sospecha razonable era que una key que
-- NO es un JWT fuera rechazada. Se probó con curl contra las dos funciones y
-- el gateway de Supabase acepta el formato nuevo igual (200 en ambas).
--
-- La key publishable es pública por diseño: ya está embebida en
-- amet-radar.html y en admin.html. No hay ningún secreto nuevo acá.

create or replace function public.notify_nearby_reports()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://nikexwjxxcxzhsuypsjn.supabase.co/functions/v1/notify-nearby',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_p8U6gvvBwPVHdfmspjyCXA_g6clP58v'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'reports',
      'record', to_jsonb(new)
    )
  );
  return new;
end;
$function$;

create or replace function public.delete_report_photo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://nikexwjxxcxzhsuypsjn.supabase.co/functions/v1/delete-photo',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_p8U6gvvBwPVHdfmspjyCXA_g6clP58v'
    ),
    body := jsonb_build_object('id', old.id)
  );
  return null;
end;
$function$;

create or replace function public.clear_report_photo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://nikexwjxxcxzhsuypsjn.supabase.co/functions/v1/delete-photo',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_p8U6gvvBwPVHdfmspjyCXA_g6clP58v'
    ),
    body := jsonb_build_object('id', old.id)
  );
  return null;
end;
$function$;

-- Los triggers NO se recrean: `create or replace function` conserva los que
-- ya apuntan a estas funciones (reports_notify_nearby, reports_delete_photo y
-- reports_photo_cleared). Tocarlos sería arriesgar perder el `WHEN` del de
-- borrado de fotos, que es lo que evita llamar a delete-photo por reportes que
-- nunca tuvieron una.

-- Mismo endurecimiento que ya tenían: si PostgREST las expusiera como RPC,
-- cualquiera podría dispararlas. Son funciones de trigger, no de API.
revoke execute on function public.notify_nearby_reports() from public, anon, authenticated;
revoke execute on function public.delete_report_photo() from public, anon, authenticated;
revoke execute on function public.clear_report_photo() from public, anon, authenticated;
