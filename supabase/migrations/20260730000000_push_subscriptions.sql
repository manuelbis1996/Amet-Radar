-- Suscripciones Web Push por dispositivo, para avisar de reportes cercanos.
-- Aplicada vía MCP (apply_migration); este archivo es la copia versionada
-- para que el estado de la base quede documentado en el repo.

create table public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  lat double precision not null,
  lng double precision not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index push_subscriptions_lat_lng_idx on public.push_subscriptions (lat, lng);

alter table public.push_subscriptions enable row level security;

-- Sin politica de SELECT a proposito: ningun cliente anonimo necesita leer
-- endpoint/lat/lng de otro dispositivo. El Edge Function usa la
-- service_role key (bypassa RLS) para leer todas las filas.
create policy "anon insert own subscription" on public.push_subscriptions
  for insert with check (true);
create policy "anon update own subscription" on public.push_subscriptions
  for update using (true) with check (true);
create policy "anon delete own subscription" on public.push_subscriptions
  for delete using (true);

-- pg_net: permite llamadas HTTP async desde un trigger de Postgres. Sus
-- funciones quedan en el schema `net` (fijo), sin importar el schema que
-- se pase acá.
create extension if not exists pg_net with schema extensions;

-- Dispara el Edge Function notify-nearby en cada reporte nuevo. El
-- Authorization usa la publishable/anon key del proyecto (ya es publica:
-- es la misma que amet-radar.html embebe en el cliente), no la
-- service_role key, asi que no hace falta guardar nada sensible en Vault
-- solo para autenticar esta llamada.
create or replace function public.notify_nearby_reports()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://nikexwjxxcxzhsuypsjn.supabase.co/functions/v1/notify-nearby',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pa2V4d2p4eGN4emhzdXlwc2puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNjc2ODYsImV4cCI6MjEwMDk0MzY4Nn0.09Fm8PTaCr3Qc6uuDUtn_xrviAlJ2JbLczUmVajfe04'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'reports',
      'record', to_jsonb(new)
    )
  );
  return new;
end;
$$;

-- notify_nearby_reports() es SECURITY DEFINER y vive en public, así que
-- PostgREST lo expone por defecto como RPC (/rest/v1/rpc/...). No hace
-- falta que nadie lo llame directo (solo lo dispara el trigger), así que
-- se revoca el permiso de ejecución explícito.
revoke execute on function public.notify_nearby_reports() from public, anon, authenticated;

drop trigger if exists reports_notify_nearby on public.reports;
create trigger reports_notify_nearby
  after insert on public.reports
  for each row execute function public.notify_nearby_reports();
