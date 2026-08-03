-- Cierra la entrada de contenido libre (fotos y notas) a public.reports.
--
-- EL PROBLEMA. El bucket `report-photos` tenía una política de insert abierta
-- (`anon upload report photos`, solo miraba el bucket y el patrón del nombre)
-- y `create_report` aceptaba cualquier `p_photo` que apuntara al bucket. Con
-- la anon key —pública por diseño— eso alcanzaba para publicar una imagen
-- arbitraria y que quedara visible en el mapa para todo el mundo. Verificado
-- de punta a punta contra producción antes de escribir esto: subir el objeto
-- devolvió 200, `create_report` devolvió `ok:true`, y la URL pública devolvió
-- 200. Lo mismo con `note`: ningún flujo de la app la escribe, pero por API
-- se le podía mandar texto arbitrario y el detalle lo renderiza.
--
-- POR QUÉ SE CIERRA EN VEZ DE MODERAR. Desde v13.0 el flujo con foto no tiene
-- entrada en la interfaz (`FLUJO_CON_FOTO` es false en producción) y ningún
-- flujo escribe notas: la app publica solo (ubicación, categoría, momento).
-- O sea que **no existe una foto legítima** — el bucket está en cero objetos —
-- y el 100% de lo que pudiera entrar sería abuso por API. Montar un circuito
-- de denuncias para moderar eso sería vigilar una puerta tapiada mientras la
-- de al lado queda abierta, y además es reactivo: la imagen se ve hasta que
-- alguien la denuncia. Cerrar es preventivo y no cuesta nada de UX, porque
-- nadie puede adjuntar una foto igual.
--
-- CUANDO VUELVA EL FLUJO CON FOTO hay que deshacer las DOS cosas de este
-- archivo (la política del bucket y el rechazo de acá) **y recién entonces**
-- construir la moderación, que ahí sí hace falta. Está anotado también en
-- `FLUJO_CON_FOTO` dentro de amet-radar.html, que es donde va a mirar quien
-- lo reactive.

-- ---------------------------------------------------------------------------
-- 1. Nadie puede subir al bucket
-- ---------------------------------------------------------------------------
-- El límite de tamaño (512 KB) y el de mime (image/jpeg) del bucket se dejan
-- como están: no molestan y siguen valiendo el día que se reabra.
drop policy if exists "anon upload report photos" on storage.objects;

-- Quedan sin política de insert, select, update ni delete sobre
-- storage.objects para anon. Las fotos que ya existan (hoy: ninguna) se
-- siguen sirviendo por /object/public/<bucket>/<path>, que no pasa por RLS,
-- así que los reportes viejos con foto no se rompen.

-- ---------------------------------------------------------------------------
-- 2. create_report rechaza foto y nota
-- ---------------------------------------------------------------------------
create or replace function public.create_report(
  p_id         text,
  p_lat        double precision,
  p_lng        double precision,
  p_photo      text,
  p_note       text,
  p_ts         bigint,
  p_category   text,
  p_approx     boolean,
  p_owner_hash text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  c_ip_limit        constant integer := 30;
  c_ip_window_min   constant integer := 60;
  c_dedupe_meters   constant double precision := 150;
  c_dedupe_minutes  constant integer := 30;
  c_south constant double precision := 17.30;
  c_north constant double precision := 20.10;
  c_west  constant double precision := -72.10;
  c_east  constant double precision := -68.20;

  v_now_ms  bigint := (extract(epoch from now()) * 1000)::bigint;
  v_ts      bigint;
  v_ip      text;
  v_ip_hash text;
  v_salt    text;
  v_n       integer;
  v_lat_pad double precision;
  v_lng_pad double precision;
begin
  if p_id is null or p_id !~ '^report_[0-9]+_[a-z0-9]*$' then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  if p_lat is null or p_lng is null
     or p_lat < c_south or p_lat > c_north
     or p_lng < c_west  or p_lng > c_east then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  if p_category is null
     or p_category not in ('reten_fijo', 'reten_movil', 'accidente', 'control') then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  -- Contenido libre: no se acepta ninguno. Ver la explicación de arriba.
  -- PARA REABRIR las fotos hay que volver a poner acá la validación que
  -- había (longitud <= 400 y que empiece con
  -- 'https://nikexwjxxcxzhsuypsjn.supabase.co/storage/v1/object/public/report-photos/')
  -- y devolver la política de insert del bucket.
  if nullif(btrim(coalesce(p_photo, '')), '') is not null then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  if p_owner_hash is not null and p_owner_hash !~ '^[0-9a-f]{64}$' then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  v_ts := least(coalesce(p_ts, v_now_ms), v_now_ms);
  if v_ts < v_now_ms - 86400000 then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  -- Antes del dedupe a propósito: el reintento de la cola offline manda el
  -- mismo id y tiene que ser idempotente (ver CLAUDE.md).
  if exists (select 1 from public.reports r where r.id = p_id) then
    return json_build_object('ok', true, 'reason', 'already_exists', 'id', p_id);
  end if;

  v_lat_pad := c_dedupe_meters / 111320.0;
  v_lng_pad := c_dedupe_meters / (111320.0 * greatest(cos(radians(p_lat)), 0.01));
  select count(*) into v_n
    from public.reports r
   where r.category = p_category
     and r.ts > v_now_ms - (c_dedupe_minutes * 60000)
     and r.lat between p_lat - v_lat_pad and p_lat + v_lat_pad
     and r.lng between p_lng - v_lng_pad and p_lng + v_lng_pad
     and 6371000 * acos(least(1, greatest(-1,
           sin(radians(p_lat)) * sin(radians(r.lat)) +
           cos(radians(p_lat)) * cos(radians(r.lat)) *
           cos(radians(r.lng) - radians(p_lng))))) <= c_dedupe_meters;
  if v_n > 0 then
    return json_build_object('ok', false, 'reason', 'duplicate', 'id', null);
  end if;

  v_ip := public._client_ip();
  if v_ip is not null then
    select s.salt into v_salt from public.rate_limit_salt s where s.id limit 1;
    v_ip_hash := encode(extensions.digest(v_ip || coalesce(v_salt, ''), 'sha256'), 'hex');
    select count(*) into v_n
      from public.report_events e
     where e.ip_hash = v_ip_hash
       and e.created_at > now() - make_interval(mins => c_ip_window_min);
    if v_n >= c_ip_limit then
      return json_build_object('ok', false, 'reason', 'rate_limit', 'id', null);
    end if;
  end if;

  -- photo y note se fuerzan a su valor vacío en vez de insertar lo que vino:
  -- ya se validó que llegaron vacíos, esto es solo para que la intención
  -- quede explícita en el insert.
  insert into public.reports as r
    (id, lat, lng, photo, note, ts, category, confirms, denies, approx, owner_hash)
  values
    (p_id, p_lat, p_lng, null, '', v_ts, p_category, 0, 0,
     coalesce(p_approx, false), p_owner_hash)
  on conflict (id) do nothing;

  if not found then
    return json_build_object('ok', true, 'reason', 'already_exists', 'id', p_id);
  end if;

  if v_ip_hash is not null then
    insert into public.report_events (ip_hash) values (v_ip_hash);
    delete from public.report_events e
     where e.created_at < now() - make_interval(mins => c_ip_window_min * 2);
  end if;

  return json_build_object('ok', true, 'reason', null, 'id', p_id);
end;
$fn$;

revoke all on function public.create_report(
  text, double precision, double precision, text, text, bigint, text, boolean, text
) from public;
grant execute on function public.create_report(
  text, double precision, double precision, text, text, bigint, text, boolean, text
) to anon, authenticated;
