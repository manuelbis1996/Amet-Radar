-- Anti-spam del lado del servidor: publicar pasa por una RPC con las reglas
-- adentro, y anon pierde el insert directo sobre reports.
--
-- PROBLEMA: canReport() en amet-radar.html miraba amet_report_times_v1 de
-- localStorage. Borrando los datos del sitio se reseteaba, así que el límite
-- no limitaba nada. Peor: publicar era un POST directo a /rest/v1/reports con
-- la política "public insert" (WITH CHECK true), o sea que ni siquiera hacía
-- falta abrir la app — con la anon key (pública por diseño) y un curl en un
-- bucle se podía llenar el mapa de pines falsos, y de paso disparar una
-- notificación push a todos los suscriptores cercanos por cada uno.
--
-- ---------------------------------------------------------------------------
-- QUÉ IDENTIDAD SE USA, Y POR QUÉ NO LA OBVIA
-- ---------------------------------------------------------------------------
-- Sin cuentas de usuario, lo único que hay para agrupar peticiones es la IP.
-- La forma "documentada" de leerla en PostgREST es:
--
--     current_setting('request.headers', true)::json->>'x-forwarded-for'
--
-- y tomar la primera entrada. ESO ES FALSIFICABLE Y NO SIRVE. Verificado a
-- mano contra este mismo proyecto (curl real, no teoría): mandando
-- `X-Forwarded-For: 1.2.3.4` la base recibe
--
--     x-forwarded-for = "1.2.3.4,160.79.106.29"
--
-- o sea que el valor que pone el cliente queda A LA IZQUIERDA y la IP real la
-- appendea Cloudflare a la derecha. Un atacante que mande una IP distinta en
-- cada petición tendría cuota infinita, y el límite sería decorativo.
--
-- Lo que sí resiste (todo verificado con curl contra este proyecto):
--   * `cf-connecting-ip` — si el cliente intenta mandarla, Cloudflare
--     RECHAZA la petición entera con 403 (error code 1000). Nunca llega un
--     valor puesto por el cliente. Esta es la buena.
--   * `sb-forwarded-for` — Supabase la reescribe; el intento de falsificarla
--     se ignora. Sirve de respaldo.
--   * `x-forwarded-for` — solo la ÚLTIMA entrada es confiable (la appendea
--     Cloudflare). Nunca la primera.
--
-- Por eso client_ip() lee en ese orden y, del x-forwarded-for, corta por la
-- derecha. Si algún día se saca Cloudflare de adelante, hay que volver a
-- medir esto: el orden de las cabeceras depende de la infraestructura, no del
-- estándar.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ EL TOPE POR IP ES GENEROSO Y NO ES EL CONTROL PRINCIPAL
-- ---------------------------------------------------------------------------
-- En República Dominicana el NAT de operadora (CGNAT) es la norma en redes
-- móviles: muchísimos usuarios legítimos salen a internet por la misma IP
-- pública. Un tope de 5/hora por IP bloquearía a medio barrio. NO se pudo
-- medir cuánta gente real comparte IP (el proyecto no guarda ninguna IP hoy,
-- así que no hay dato histórico que mirar), así que se asume el peor caso.
--
-- Resultado: el tope por IP queda en 30/hora — un cortafuegos contra la
-- inundación desde un solo origen, no el control fino — y el control real es
-- el dedupe por proximidad, que no depende de ninguna identidad.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ NO HAY UN TOPE GLOBAL (a propósito, no es un olvido)
-- ---------------------------------------------------------------------------
-- Tentador: "máximo N reportes por hora en toda la app" como último
-- cortafuegos contra un atacante que rote IPs. NO se puso, y conviene no
-- agregarlo sin pensarlo: un tope global convierte un ataque de spam
-- (degradación: hay pines de más, molesto pero la app sirve) en un ataque de
-- denegación de servicio (la app entera deja de aceptar reportes para todo el
-- mundo). El atacante quemaría la cuota global a propósito. Publicar es el
-- flujo central del producto: es preferible tragarse pines de más que dejar a
-- la gente sin poder avisar.

-- ---------------------------------------------------------------------------
-- Tabla de eventos para contar por IP
-- ---------------------------------------------------------------------------
-- OJO: la IP NO puede ir en public.reports — esa tabla tiene select abierto
-- para anon, o sea que publicaría la IP de cada persona que reporta un retén.
-- En una app cuyo propósito es esquivar retenes, eso es exactamente el dato
-- que no hay que guardar en público.
--
-- Además no se guarda la IP en claro ni se la vincula al reporte:
--   * se guarda el SHA-256 de (ip || salt secreto), no la IP  — un hash de
--     IPv4 pelado es fuerza-bruteable (son 4 mil millones), con salt no;
--   * la fila NO tiene report_id, así que ni con la base entera en la mano se
--     puede decir "esta persona publicó ese reporte". Solo sirve para contar.
create table if not exists public.report_events (
  id         bigserial primary key,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);

create index if not exists report_events_ip_created_idx
  on public.report_events (ip_hash, created_at desc);
create index if not exists report_events_created_idx
  on public.report_events (created_at);

alter table public.report_events enable row level security;
-- Sin ninguna política: nadie llega por PostgREST. Solo la entra la función
-- SECURITY DEFINER de más abajo.
revoke all on public.report_events from anon, authenticated;
revoke all on sequence public.report_events_id_seq from anon, authenticated;

-- Salt secreto del hash de IP. Tabla aparte, también sin políticas.
create table if not exists public.rate_limit_salt (
  id   boolean primary key default true,
  salt text not null,
  constraint rate_limit_salt_singleton check (id)
);
alter table public.rate_limit_salt enable row level security;
revoke all on public.rate_limit_salt from anon, authenticated;

insert into public.rate_limit_salt (id, salt)
values (true, encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- IP confiable del que llama (ver la explicación larga arriba)
-- ---------------------------------------------------------------------------
create or replace function public._client_ip()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_headers json;
  v_xff     text;
begin
  begin
    v_headers := current_setting('request.headers', true)::json;
  exception when others then
    return null;
  end;
  if v_headers is null then
    return null;
  end if;

  -- Cloudflare rechaza con 403 cualquier intento del cliente de mandar esta
  -- cabecera, así que su valor nunca es del cliente.
  if coalesce(v_headers->>'cf-connecting-ip', '') <> '' then
    return v_headers->>'cf-connecting-ip';
  end if;

  -- Respaldo: Supabase la reescribe, el intento de falsificarla se ignora.
  if coalesce(v_headers->>'sb-forwarded-for', '') <> '' then
    return v_headers->>'sb-forwarded-for';
  end if;

  -- Último recurso: la ÚLTIMA entrada de x-forwarded-for, nunca la primera
  -- (la primera la controla el cliente).
  v_xff := v_headers->>'x-forwarded-for';
  if coalesce(v_xff, '') <> '' then
    return btrim(split_part(v_xff, ',', array_length(string_to_array(v_xff, ','), 1)));
  end if;

  return null;
end;
$$;

revoke all on function public._client_ip() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_report: la única vía para publicar
-- ---------------------------------------------------------------------------
-- Devuelve json y no `returns table(...)` a propósito: los nombres de salida
-- de un returns table son variables de plpgsql y chocan con los nombres de
-- columna (ya mordió antes en este proyecto). Con json no hay colisión
-- posible y además garantiza una sola fila, que es el otro bug que hubo acá
-- (`return query` agrega filas y SIGUE ejecutando).
--
-- Respuesta: { ok: bool, reason: text|null, id: text|null }
--   reason = 'duplicate'  ya hay un reporte igual cerca y reciente
--            'rate_limit' demasiados reportes desde esta IP en la ventana
--            'invalid'    datos que el cliente nunca manda (id mal formado,
--                         fuera de RD, categoría inexistente, etc.)
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
as $$
declare
  -- Los umbrales viven acá, como constantes, y NO en app_config. Es
  -- deliberado: la lección de la puerta lateral de app_config (ver CLAUDE.md)
  -- es que una RPC que lee su umbral de una tabla escribible desde afuera es
  -- tan insegura como esa tabla. Para cambiarlos: editar y aplicar una
  -- migración nueva.
  c_ip_limit        constant integer := 30;   -- reportes por IP y ventana
  c_ip_window_min   constant integer := 60;   -- ventana del tope por IP
  c_dedupe_meters   constant double precision := 150;  -- = APPROX_RADIUS_METERS
  c_dedupe_minutes  constant integer := 30;
  c_note_max        constant integer := 280;
  c_photo_max       constant integer := 400;
  c_photo_prefix    constant text :=
    'https://nikexwjxxcxzhsuypsjn.supabase.co/storage/v1/object/public/report-photos/';
  -- Caja de República Dominicana, igual que RD_BOUNDS en amet-radar.html.
  c_south constant double precision := 17.30;
  c_north constant double precision := 20.10;
  c_west  constant double precision := -72.10;
  c_east  constant double precision := -68.20;

  v_now_ms  bigint := (extract(epoch from now()) * 1000)::bigint;
  v_ts      bigint;
  v_note    text;
  v_photo   text;
  v_ip      text;
  v_ip_hash text;
  v_salt    text;
  v_n       integer;
  v_lat_pad double precision;
  v_lng_pad double precision;
begin
  -- ---- Validación de entrada -------------------------------------------
  -- El cliente nunca manda nada de esto mal; es para el que llama a la RPC
  -- a mano con la anon key.
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

  -- La foto solo puede ser null o una URL de nuestro propio bucket. Un data:
  -- URL acá sería base64 crudo dentro de la fila (bloat de la tabla y del
  -- egreso del sondeo); el cliente ya sube a Storage antes de insertar, tanto
  -- en el camino normal como en el de la cola offline.
  v_photo := nullif(btrim(coalesce(p_photo, '')), '');
  if v_photo is not null
     and (length(v_photo) > c_photo_max or position(c_photo_prefix in v_photo) <> 1) then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  if p_owner_hash is not null and p_owner_hash !~ '^[0-9a-f]{64}$' then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  v_note := left(coalesce(p_note, ''), c_note_max);

  -- ts: se acepta el del cliente (la cola offline publica con el ts del
  -- momento en que se creó el reporte, no el de cuando se sincroniza), pero
  -- nunca en el futuro — si no, un ts adelantado hace un reporte que
  -- purge_expired_reports() no se lleva nunca.
  v_ts := least(coalesce(p_ts, v_now_ms), v_now_ms);
  if v_ts < v_now_ms - 86400000 then
    return json_build_object('ok', false, 'reason', 'invalid', 'id', null);
  end if;

  -- ---- ¿Ya existe este id? ----------------------------------------------
  -- VA ANTES DEL DEDUPE, y el orden no es cosmético. La cola offline
  -- (flushPendingQueue) reintenta con el MISMO id: si el insert entró pero la
  -- respuesta se perdió, el reintento llega a un reporte que ya está en la
  -- base, en el mismo punto y de la misma categoría. Con el dedupe primero,
  -- eso contestaba 'duplicate' — o sea, un reporte legítimo que sí se publicó
  -- se le mostraba al autor como error. Contestando por id, el reintento es
  -- idempotente y la cola se vacía limpia.
  if exists (select 1 from public.reports r where r.id = p_id) then
    return json_build_object('ok', true, 'reason', 'already_exists', 'id', p_id);
  end if;

  -- ---- Dedupe por proximidad (el control de verdad) ---------------------
  -- Si ya hay un reporte de la misma categoría a menos de 150 m publicado en
  -- los últimos 30 minutos, este es un duplicado. No depende de ninguna
  -- identidad, así que no lo esquiva ni borrar los datos del sitio ni rotar
  -- de IP, y ataca la amenaza real (llenar el mapa de pines). Además se
  -- defiende como producto: si el pin ya está ahí, lo que corresponde es
  -- confirmarlo, no publicar otro encima.
  v_lat_pad := c_dedupe_meters / 111320.0;
  v_lng_pad := c_dedupe_meters / (111320.0 * greatest(cos(radians(p_lat)), 0.01));

  select count(*) into v_n
    from public.reports r
   where r.category = p_category
     and r.ts > v_now_ms - (c_dedupe_minutes * 60000)
     -- Prefiltro por caja para no calcular Haversine sobre toda la tabla…
     and r.lat between p_lat - v_lat_pad and p_lat + v_lat_pad
     and r.lng between p_lng - v_lng_pad and p_lng + v_lng_pad
     -- …y refinado con la distancia real (la caja es un cuadrado, no un
     -- círculo: en las esquinas da hasta 1.41x el radio).
     and 6371000 * acos(least(1, greatest(-1,
           sin(radians(p_lat)) * sin(radians(r.lat)) +
           cos(radians(p_lat)) * cos(radians(r.lat)) *
           cos(radians(r.lng) - radians(p_lng))
         ))) <= c_dedupe_meters;

  if v_n > 0 then
    return json_build_object('ok', false, 'reason', 'duplicate', 'id', null);
  end if;

  -- ---- Tope por IP (cortafuegos, ver arriba) ----------------------------
  v_ip := public._client_ip();

  -- Sin IP confiable NO se bloquea: se sigue de largo. Meter a todos los
  -- "desconocidos" en un mismo balde haría que, si algún día cambia la
  -- infraestructura y la cabecera deja de llegar, la app entera se quede sin
  -- poder publicar. El dedupe por proximidad sigue aplicando igual.
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

  -- ---- Insert ------------------------------------------------------------
  -- confirms/denies se fuerzan a 0: son del servidor, no del cliente (si no,
  -- se podría nacer con confirms:99999, que es justo lo que cerró v12.0 por
  -- el lado del update).
  insert into public.reports as r
    (id, lat, lng, photo, note, ts, category, confirms, denies, approx, owner_hash)
  values
    (p_id, p_lat, p_lng, v_photo, v_note, v_ts, p_category, 0, 0,
     coalesce(p_approx, false), p_owner_hash)
  on conflict (id) do nothing;

  if not found then
    -- Mismo id dos veces: es el reintento de un reporte que en realidad ya
    -- entró. Se responde ok para que el cliente no lo muestre como error ni
    -- lo deje trabado en la cola offline.
    return json_build_object('ok', true, 'reason', 'already_exists', 'id', p_id);
  end if;

  -- El evento se registra recién acá: un duplicado rechazado no debe gastar
  -- cuota, si no un usuario legítimo en una zona ya reportada se quedaría sin
  -- poder publicar en otro lado.
  if v_ip_hash is not null then
    insert into public.report_events (ip_hash) values (v_ip_hash);
    -- Limpieza oportunista: la tabla solo sirve para contar dentro de la
    -- ventana, todo lo anterior es basura. Barata porque la tabla es chica.
    delete from public.report_events e
     where e.created_at < now() - make_interval(mins => c_ip_window_min * 2);
  end if;

  return json_build_object('ok', true, 'reason', null, 'id', p_id);
end;
$$;

revoke all on function public.create_report(
  text, double precision, double precision, text, text, bigint, text, boolean, text
) from public;
grant execute on function public.create_report(
  text, double precision, double precision, text, text, bigint, text, boolean, text
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- OJO: el insert directo NO se cierra en esta migración
-- ---------------------------------------------------------------------------
-- Está aparte, en 20260803130000_close_direct_insert.sql, y se aplica DESPUÉS
-- de que el cliente nuevo esté desplegado. Si se cierra acá, todo navegador
-- que todavía tenga la versión vieja (que publica con POST /rest/v1/reports)
-- se queda sin poder publicar en el momento mismo de aplicar la migración.
-- Esta migración es puramente aditiva: se puede aplicar en producción sin
-- que cambie nada para nadie.

comment on table public.report_events is
  'Solo para contar reportes por IP dentro de la ventana del anti-spam. '
  'Guarda el hash salteado de la IP y NO el reporte al que corresponde, para '
  'que no se pueda vincular una persona con un reporte. Sin políticas RLS: '
  'únicamente la entra create_report (security definer).';
