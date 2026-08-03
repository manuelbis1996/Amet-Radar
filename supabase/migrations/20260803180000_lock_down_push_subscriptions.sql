-- Quita las tres políticas abiertas de public.push_subscriptions.
--
-- VA SEPARADA DE 20260803170000 Y SE APLICA DESPUÉS DE DESPLEGAR EL CLIENTE
-- NUEVO. Misma razón que en v14.0 (ver "Anti-spam del lado del servidor" en
-- CLAUDE.md): la app que está en la calle da de alta y de baja las
-- suscripciones con POST/DELETE/PATCH directos contra la tabla. Si se corren
-- las dos migraciones juntas, todo navegador que todavía no bajó la versión
-- nueva deja de poder activar o desactivar los avisos en el instante de
-- aplicarla.
--
-- Orden correcto:
--   1. aplicar 20260803170000_push_subscriptions_rpc.sql   (aditiva, inocua)
--   2. mergear a main y esperar el deploy de Cloudflare
--   3. aplicar ESTE archivo
--
-- Sin este paso las RPC existen pero el agujero sigue abierto: el camino
-- viejo se las saltea enteras.

drop policy if exists "anon insert own subscription" on public.push_subscriptions;
drop policy if exists "anon update own subscription" on public.push_subscriptions;
drop policy if exists "anon delete own subscription" on public.push_subscriptions;

-- La tabla queda con RLS habilitada y SIN NINGUNA política, igual que
-- report_events y rate_limit_salt: nadie llega por PostgREST y todo pasa por
-- las funciones SECURITY DEFINER. Nunca tuvo política de SELECT, así que ese
-- lado ya estaba cerrado.
--
-- El Edge Function notify-nearby NO se ve afectado: usa la service_role key,
-- que bypassa RLS.
--
-- El linter de Supabase va a marcar la tabla con un INFO
-- `rls_enabled_no_policy`. Es lo esperado, igual que las otras dos.
