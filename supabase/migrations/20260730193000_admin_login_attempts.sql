-- Rate-limit persistente para el login del panel admin. Reemplaza el Map
-- en memoria de admin-login/index.ts, que se reseteaba en cada cold start
-- de la Edge Function (no era un límite real). Aplicada vía MCP
-- (apply_migration); este archivo es la copia versionada, mismo criterio
-- que el resto de supabase/migrations/*.sql.
create table public.admin_login_attempts (
  ip text primary key,
  count integer not null default 1,
  first_attempt_at timestamptz not null default now(),
  lock_until timestamptz
);

alter table public.admin_login_attempts enable row level security;

-- Sin políticas a propósito: a diferencia de reports/app_config, esta
-- tabla no la toca nunca el cliente directo, solo el Edge Function
-- admin-login usando la service_role key (bypassa RLS) — mismo patrón
-- que notify-nearby con push_subscriptions.
