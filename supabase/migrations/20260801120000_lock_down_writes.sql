-- Cierra el agujero de borrado/edición antes del lanzamiento público.
--
-- PROBLEMA: reports tenía políticas RLS abiertas para update y delete, y la
-- SUPABASE_ANON_KEY está pública dentro de amet-radar.html (por diseño, es
-- una publishable key). O sea que cualquiera que mirara el código fuente
-- podía vaciar la tabla entera con un solo DELETE ...?id=neq.x, o poner
-- confirms:99999 en cualquier reporte.
--
-- SOLUCIÓN: se quitan esas dos políticas y las operaciones destructivas
-- pasan por funciones SECURITY DEFINER con reglas adentro. select e insert
-- siguen abiertos: leer y publicar son anónimos por diseño del proyecto (no
-- hay cuentas de usuario).
--
-- La "propiedad" de un reporte, sin usuarios, se resuelve con un secreto por
-- reporte: el cliente guarda el token en localStorage y la base solo conoce
-- su hash SHA-256. Leer la tabla expone el hash, que no sirve para borrar.

-- pgcrypto vive en el schema `extensions` en Supabase; se necesita digest().
create extension if not exists pgcrypto with schema extensions;

alter table public.reports add column if not exists owner_hash text;

comment on column public.reports.owner_hash is
  'SHA-256 (hex) del token de propiedad. El texto plano solo lo tiene el '
  'dispositivo que publicó, en localStorage (amet_report_tokens_v1). Sirve '
  'para que delete_own_report pueda verificar quién puede borrar sin que '
  'existan cuentas de usuario.';

-- ---------------------------------------------------------------------------
-- Cerrar las políticas abiertas
-- ---------------------------------------------------------------------------
drop policy if exists "public update" on public.reports;
drop policy if exists "public delete" on public.reports;
-- "public read" y "public insert" quedan como estaban, a propósito.

-- Las fotos las borra ahora _delete_report (con permisos de definer), así que
-- anon ya no necesita —ni debe— poder borrar del bucket.
drop policy if exists "anon delete report photos" on storage.objects;
-- El insert del bucket queda abierto: sin eso no se puede publicar una foto.

-- ---------------------------------------------------------------------------
-- Helper interno: borra la fila y su foto. SIN grant a anon.
-- ---------------------------------------------------------------------------
create or replace function public._delete_report(p_id text)
returns void
language plpgsql
security definer
set search_path = public, storage, extensions
as $$
begin
  delete from storage.objects
   where bucket_id = 'report-photos' and name = p_id || '.jpg';
  delete from public.reports where id = p_id;
end;
$$;

revoke all on function public._delete_report(text) from public, anon, authenticated;
-- service_role sí lo necesita: el Edge Function admin-delete-report lo llama
-- como RPC para no duplicar la lógica de borrar la fila + su foto. El revoke
-- de arriba (a `public`) también se lo saca a service_role, que no es dueño
-- de la función, así que hay que devolvérselo explícitamente.
grant execute on function public._delete_report(text) to service_role;

-- ---------------------------------------------------------------------------
-- Votar: suma de a 1 (antes el cliente mandaba el total, o sea cualquier
-- número) y decide del lado del servidor el retiro comunitario.
-- ---------------------------------------------------------------------------
create or replace function public.vote_report(p_id text, p_dir text)
returns table(confirms integer, denies integer, removed boolean)
language plpgsql
security definer
set search_path = public, storage, extensions
as $$
declare
  v_threshold integer;
  v_confirms integer;
  v_denies integer;
begin
  if p_dir not in ('confirm', 'deny') then
    raise exception 'direccion de voto invalida';
  end if;

  -- El umbral sale de app_config (editable desde el panel admin), no
  -- hardcodeado, para que siga un solo lugar de verdad.
  select deny_threshold into v_threshold from public.app_config where id;
  v_threshold := coalesce(v_threshold, 2);

  update public.reports
     set confirms = coalesce(confirms, 0) + (case when p_dir = 'confirm' then 1 else 0 end),
         denies   = coalesce(denies, 0)   + (case when p_dir = 'deny'    then 1 else 0 end)
   where id = p_id
   returning reports.confirms, reports.denies into v_confirms, v_denies;

  if not found then
    raise exception 'reporte inexistente';
  end if;

  if v_denies - v_confirms >= v_threshold then
    perform public._delete_report(p_id);
    return query select v_confirms, v_denies, true;
  end if;

  return query select v_confirms, v_denies, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Borrar el propio reporte: hay que presentar el token en texto plano.
-- ---------------------------------------------------------------------------
create or replace function public.delete_own_report(p_id text, p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, storage, extensions
as $$
declare
  v_hash text;
begin
  if p_token is null or p_token = '' then
    return false;
  end if;

  select owner_hash into v_hash from public.reports where id = p_id;

  -- Mismo false para "no existe", "no tiene dueño" y "token equivocado": no
  -- hace falta contarle a quien prueba en qué se equivocó.
  if v_hash is null then
    return false;
  end if;
  if v_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex') then
    return false;
  end if;

  perform public._delete_report(p_id);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Limpieza de vencidos. Es seguro exponerla: solo puede borrar reportes que
-- ya pasaron max_age_minutes, o sea que la app iba a dejar de mostrar igual.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_reports()
returns integer
language plpgsql
security definer
set search_path = public, storage, extensions
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

  with vencidos as (
    select id from public.reports where ts < v_cutoff
  )
  select count(*) into v_count from vencidos;

  delete from storage.objects
   where bucket_id = 'report-photos'
     and name in (select id || '.jpg' from public.reports where ts < v_cutoff);
  delete from public.reports where ts < v_cutoff;

  return coalesce(v_count, 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos: anon solo puede ejecutar las tres públicas, nunca el helper.
-- ---------------------------------------------------------------------------
revoke all on function public.vote_report(text, text) from public;
revoke all on function public.delete_own_report(text, text) from public;
revoke all on function public.purge_expired_reports() from public;

grant execute on function public.vote_report(text, text) to anon, authenticated;
grant execute on function public.delete_own_report(text, text) to anon, authenticated;
grant execute on function public.purge_expired_reports() to anon, authenticated;
