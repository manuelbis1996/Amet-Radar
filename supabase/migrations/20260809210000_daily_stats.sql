-- Contador diario de publicaciones, para que el panel pueda mostrar si la app
-- se está usando más o menos con el tiempo.
--
-- POR QUÉ HACE FALTA UNA TABLA NUEVA. Hoy el proyecto no guarda NINGÚN
-- histórico, y es a propósito en los dos casos:
--   * `reports` se autoexpira a los max_age_minutes (6 h);
--   * `report_events` se poda sola a las 2 h — solo existe para contar dentro
--     de la ventana del tope por IP, todo lo anterior es basura.
-- O sea que no hay forma de saber cuánto se usó la app ayer, ni la semana
-- pasada. Para administrar el proyecto eso es un punto ciego.
--
-- QUÉ SE GUARDA, Y QUÉ NO. Solo un contador por día. Sin IP, sin coordenadas,
-- sin vínculo con ningún reporte: una fila diaria con un número. Eso mantiene
-- intacta la decisión de privacidad de report_events (ver "La IP se guarda
-- hasheada y sin vínculo con el reporte" en CLAUDE.md) — con esta tabla en la
-- mano no se puede saber quién publicó qué, ni dónde, ni a qué hora.
create table if not exists public.daily_stats (
  day     date primary key,
  reports integer not null default 0
);

comment on table public.daily_stats is
  'Un contador de publicaciones por día, y nada más. Sin IP, sin ubicación y '
  'sin vínculo con ningún reporte: solo sirve para ver la tendencia de uso '
  'desde el panel admin. Lo escribe create_report; lo lee admin-metrics con '
  'la service_role key.';

-- Igual que report_events y rate_limit_salt: RLS sin ninguna política, o sea
-- que nadie llega por PostgREST. Solo las funciones SECURITY DEFINER.
alter table public.daily_stats enable row level security;
revoke all on public.daily_stats from anon, authenticated;

-- El incremento vive en su propia función para no volver a tocar
-- create_report, que es el camino más delicado del sistema (todo el anti-spam
-- de v14.0 pasa por ahí). Se la llama desde un trigger AFTER INSERT sobre
-- reports: así cuenta exactamente lo que se publicó de verdad, sin importar
-- por dónde entró, y un fallo del contador nunca puede tumbar una publicación.
create or replace function public.bump_daily_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.daily_stats (day, reports)
  values (current_date, 1)
  on conflict (day) do update set reports = public.daily_stats.reports + 1;
  return null;
end;
$$;

revoke all on function public.bump_daily_stats() from public, anon, authenticated;

drop trigger if exists reports_bump_stats on public.reports;
create trigger reports_bump_stats
after insert on public.reports
for each row
execute function public.bump_daily_stats();
