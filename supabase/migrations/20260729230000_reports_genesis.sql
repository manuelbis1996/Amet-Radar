-- Tabla principal de la app: un reporte de retén/accidente/control.
-- A diferencia del resto de supabase/migrations/*.sql, esta NO se aplicó
-- vía MCP (apply_migration) — la tabla ya existía de cuando se migró el
-- proyecto de localStorage a Supabase, antes de que se empezara a
-- versionar cada cambio de esquema en este directorio. Se agrega acá
-- retroactivamente, reconstruida a partir del esquema real en producción
-- (columnas, constraints, índices, políticas y trigger verificados con
-- `execute_sql` contra el proyecto), para que reconstruir la base desde
-- cero en otro proyecto/cuenta de Supabase no dependa de un paso manual
-- sin documentar. Igual que el resto: es documentación/histórico, no se
-- vuelve a aplicar automáticamente.
create table public.reports (
  id text primary key,
  lat double precision not null,
  lng double precision not null,
  photo text,
  note text not null default '',
  ts bigint not null,
  category text not null check (category = any (array['reten_fijo', 'reten_movil', 'accidente', 'control'])),
  confirms integer not null default 0,
  denies integer not null default 0,
  approx boolean not null default false,
  created_at timestamptz not null default now()
);

create index reports_ts_idx on public.reports (ts);
create index reports_category_idx on public.reports (category);

alter table public.reports enable row level security;

-- RLS abierta a propósito (ver CLAUDE.md "API de Supabase"): no hay
-- autenticación de usuarios en la app, equivalente al CORS abierto que
-- tenía antes server.js.
create policy "public read" on public.reports
  for select using (true);
create policy "public insert" on public.reports
  for insert with check (true);
create policy "public update" on public.reports
  for update using (true) with check (true);
create policy "public delete" on public.reports
  for delete using (true);

-- El trigger reports_notify_nearby (AFTER INSERT) y la función
-- notify_nearby_reports() que dispara se crean en
-- 20260730000000_push_subscriptions.sql, junto con la extensión pg_net
-- que necesitan — no acá, porque dependen de esa migración posterior.
