-- Fila única con los parámetros del sistema que antes estaban hardcodeados
-- en amet-radar.html (STALE_MINUTES, MAX_AGE_MINUTES, DENY_THRESHOLD,
-- REPORT_LIMIT, REPORT_WINDOW_MIN), editable desde el panel admin
-- (admin.html) sin tocar código. Aplicada vía MCP (apply_migration); este
-- archivo es la copia versionada, mismo criterio que
-- 20260730000000_push_subscriptions.sql.
--
-- Truco de "singleton": id boolean con default true + constraint id, así
-- la primary key impide que exista más de una fila.
create table public.app_config (
  id boolean primary key default true,
  constraint app_config_singleton check (id),
  stale_minutes integer not null default 180,
  max_age_minutes integer not null default 360,
  deny_threshold integer not null default 2,
  report_limit integer not null default 3,
  report_window_min integer not null default 60,
  updated_at timestamptz not null default now()
);

insert into public.app_config (id) values (true);

alter table public.app_config enable row level security;

-- Mismo espíritu que public.reports: RLS abierta (`USING (true)`), no hay
-- autenticación de usuarios en la app — el password del panel admin
-- (ver supabase/functions/admin-login) es un gate de conveniencia, no un
-- límite de acceso a nivel de fila.
create policy "anon select config" on public.app_config
  for select using (true);
create policy "anon update config" on public.app_config
  for update using (true) with check (true);
