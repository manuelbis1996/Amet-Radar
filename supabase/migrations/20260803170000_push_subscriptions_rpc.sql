-- Mueve el alta/baja/actualización de push_subscriptions a RPCs.
-- ADITIVA: no cambia nada por sí sola. Las políticas abiertas se quitan en
-- 20260803180000_lock_down_push_subscriptions.sql, DESPUÉS de desplegar el
-- cliente nuevo (misma secuencia que v14.0, ver CLAUDE.md).
--
-- EL PROBLEMA. `push_subscriptions` era la última tabla con escritura
-- abierta: `insert`, `update` y `delete` con `USING (true)` / `WITH CHECK
-- (true)`. Con la anon key —pública por diseño— una sola petición se llevaba
-- puestas TODAS las suscripciones:
--
--     DELETE /rest/v1/push_subscriptions?endpoint=neq.x
--
-- y un PATCH podía reescribirle el lat/lng a cualquiera, o sea mandarle las
-- notificaciones de otra ciudad. Verificado contra producción (con un filtro
-- que no matchea ninguna fila, para no borrar nada real): DELETE y PATCH
-- respondían 204.
--
-- Es el mismo agujero que v12.0 cerró para `reports`, y encima el daño es
-- SILENCIOSO: nadie se entera de que dejó de recibir avisos, no hay error
-- visible, y hay que volver a suscribirse a mano dispositivo por dispositivo.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ NO HACE FALTA UN TOKEN COMO EN `reports`
-- ---------------------------------------------------------------------------
-- Para los reportes hubo que inventar un secreto por fila (token en
-- localStorage, hash en la base) porque el `id` de un reporte es público: se
-- lee en la tabla y viaja en los links compartidos.
--
-- Acá no hace falta, y conviene entender por qué antes de "mejorarlo":
--   * la tabla NO tiene política de SELECT (deliberado desde el día uno), así
--     que `anon` no puede enumerar endpoints;
--   * un endpoint de push es una URL con un token aleatorio largo, generada
--     por el navegador — no se adivina;
--   * o sea que **conocer el endpoint ya es la prueba de propiedad**, y es un
--     secreto que el dispositivo ya tiene.
--
-- Ventaja concreta de no inventar un token nuevo: **no hay backfill**. Las
-- suscripciones que ya existen siguen funcionando; con un esquema de token
-- habrían quedado sin poder desuscribirse hasta volver a suscribirse.
--
-- El agujero real nunca fue "cualquiera puede tocar SU fila" sino "cualquiera
-- puede tocar TODAS con un filtro". Por eso alcanza con que las operaciones
-- pasen por funciones que reciben el endpoint EXACTO y tocan una sola fila:
-- desaparece el filtro arbitrario, que era el problema.
--
-- Lo que esto NO cubre, asumido: si un endpoint se filtra (logs, un proxy),
-- quien lo tenga puede desuscribir o mover esa suscripción. Es una fila, no
-- la tabla entera, y ya era así antes.

-- ---------------------------------------------------------------------------
-- Alta (o actualización) de una suscripción
-- ---------------------------------------------------------------------------
create or replace function public.subscribe_push(
  p_endpoint text,
  p_p256dh   text,
  p_auth     text,
  p_lat      double precision,
  p_lng      double precision
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Validación mínima: que sea una URL y no un texto cualquiera, y topes de
  -- longitud para que la tabla no se pueda inflar con basura.
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 500
     or length(p_endpoint) < 20 then
    return false;
  end if;
  if p_p256dh is null or length(p_p256dh) > 200
     or p_auth is null or length(p_auth) > 200 then
    return false;
  end if;
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return false;
  end if;

  -- Un upsert de verdad, que acá sí se puede porque la función es SECURITY
  -- DEFINER y no pasa por PostgREST: el cliente hacía DELETE + POST
  -- justamente porque un upsert por la REST API falla sin política de SELECT
  -- (PostgREST necesita leer de vuelta la fila). Ese rodeo ya no hace falta.
  insert into public.push_subscriptions as s
    (endpoint, p256dh, auth, lat, lng, updated_at)
  values
    (p_endpoint, p_p256dh, p_auth, p_lat, p_lng, now())
  on conflict (endpoint) do update
    set p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        lat        = excluded.lat,
        lng        = excluded.lng,
        updated_at = now();
    -- `categories` NO se toca a propósito: el cliente ya no la escribe
    -- (v13.1) y NULL significa "todas". Con el DELETE+POST anterior, un
    -- re-suscribe la reseteaba; así se preserva si algún día vuelve a usarse.

  return true;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Baja
-- ---------------------------------------------------------------------------
create or replace function public.unsubscribe_push(p_endpoint text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_endpoint is null or p_endpoint = '' then
    return false;
  end if;
  -- Igualdad exacta, nunca un patrón: acá está el cierre del agujero.
  delete from public.push_subscriptions s where s.endpoint = p_endpoint;
  -- Devuelve true aunque no existiera: desuscribirse dos veces no es un
  -- error, y distinguirlo permitiría comprobar si un endpoint está dado de
  -- alta, que es justo lo que la ausencia de SELECT evita.
  return true;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Actualización de posición
-- ---------------------------------------------------------------------------
create or replace function public.update_push_position(
  p_endpoint text,
  p_lat      double precision,
  p_lng      double precision
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_endpoint is null or p_endpoint = ''
     or p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return false;
  end if;
  update public.push_subscriptions s
     set lat = p_lat, lng = p_lng, updated_at = now()
   where s.endpoint = p_endpoint;
  return true;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
revoke all on function public.subscribe_push(text, text, text, double precision, double precision) from public;
revoke all on function public.unsubscribe_push(text) from public;
revoke all on function public.update_push_position(text, double precision, double precision) from public;

grant execute on function public.subscribe_push(text, text, text, double precision, double precision) to anon, authenticated;
grant execute on function public.unsubscribe_push(text) to anon, authenticated;
grant execute on function public.update_push_position(text, double precision, double precision) to anon, authenticated;
