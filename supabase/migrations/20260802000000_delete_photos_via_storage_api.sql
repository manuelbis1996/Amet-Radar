-- Corrige un bug de 20260801120000_lock_down_writes.sql: _delete_report()
-- hacía `delete from storage.objects` por SQL, y Supabase lo prohíbe con un
-- trigger propio (storage.protect_delete):
--
--   ERROR 42501: Direct deletion from storage tables is not allowed.
--                Use the Storage API instead.
--
-- Como la excepción se propaga, se llevaba puesta la transacción entera: no
-- se borraba ni la fila del reporte. Rompía los cuatro caminos de borrado
-- (reporte propio, retiro comunitario, vencidos, panel admin).
--
-- ARREGLO: la base borra solo la fila, y un trigger AFTER DELETE le avisa al
-- Edge Function `delete-photo`, que sí puede usar la Storage API. Mismo
-- patrón pg_net -> Edge Function que ya usa notify_nearby_reports. Es
-- best-effort: una foto huérfana es mucho menos grave que un reporte que no
-- se puede borrar.

-- ---------------------------------------------------------------------------
-- _delete_report: ya no toca storage.objects
-- ---------------------------------------------------------------------------
create or replace function public._delete_report(p_id text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- La foto la limpia el trigger reports_delete_photo (ver abajo): no se
  -- puede borrar de storage.objects por SQL.
  delete from public.reports where id = p_id;
end;
$$;

revoke all on function public._delete_report(text) from public, anon, authenticated;
grant execute on function public._delete_report(text) to service_role;

-- ---------------------------------------------------------------------------
-- purge_expired_reports: idem, sin el delete a storage.objects
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_reports()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_max_age integer;
  v_cutoff bigint;
  v_count integer;
begin
  select max_age_minutes into v_max_age from public.app_config where id;
  v_max_age := coalesce(v_max_age, 360);

  -- ts se guarda en epoch milisegundos (ver el modelo de datos en CLAUDE.md)
  v_cutoff := (extract(epoch from now()) * 1000)::bigint - (v_max_age::bigint * 60000);

  with borradas as (
    delete from public.reports where ts < v_cutoff returning 1
  )
  select count(*) into v_count from borradas;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.purge_expired_reports() from public;
grant execute on function public.purge_expired_reports() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trigger: al borrarse un reporte, pedirle a delete-photo que limpie su foto
-- ---------------------------------------------------------------------------
create or replace function public.delete_report_photo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Con la anon key, igual que notify_nearby_reports: ya es pública, y la
  -- función del otro lado se niega a borrar la foto de un reporte que
  -- todavía existe, así que no habilita nada nuevo.
  perform net.http_post(
    url := 'https://nikexwjxxcxzhsuypsjn.supabase.co/functions/v1/delete-photo',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pa2V4d2p4eGN4emhzdXlwc2puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNjc2ODYsImV4cCI6MjEwMDk0MzY4Nn0.09Fm8PTaCr3Qc6uuDUtn_xrviAlJ2JbLczUmVajfe04'
    ),
    body := jsonb_build_object('id', old.id)
  );
  return null;
end;
$$;

-- Sin grant a anon: si no, PostgREST la expondría como RPC pública (el
-- linter de seguridad lo marca). Mismo criterio que notify_nearby_reports.
revoke all on function public.delete_report_photo() from public, anon, authenticated;

drop trigger if exists reports_delete_photo on public.reports;

-- Solo cuando hay una foto de verdad en Storage. Un reporte rápido no tiene
-- (photo is null), y las filas viejas guardaban la imagen como data: URL
-- embebida, sin ningún objeto en el bucket que limpiar.
create trigger reports_delete_photo
after delete on public.reports
for each row
when (old.photo is not null and old.photo not like 'data:%')
execute function public.delete_report_photo();
