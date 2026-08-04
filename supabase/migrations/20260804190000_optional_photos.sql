-- Reabre las fotos, pero OPCIONALES y por una puerta distinta a la de antes.
--
-- QUÉ CAMBIA RESPECTO DE COMO ERA. Hasta la v13.0 la foto era OBLIGATORIA y se
-- adjuntaba ANTES de publicar; desde la v14.1 estaba cerrada del todo. Ahora
-- es opcional y se adjunta DESPUÉS, sobre un reporte que ya existe.
--
-- POR QUÉ ESE ORDEN, que es lo que define todo el diseño. Reportar es un solo
-- toque y la gente lo hace manejando: cualquier paso antes de publicar retrasa
-- el aviso a los demás justo cuando más urge, y encima empuja a sacar una foto
-- en movimiento. Publicando primero, el reporte ya sirve desde el segundo cero
-- y la foto se agrega cuando se puede (en el semáforo, o parado dos cuadras
-- después).
--
-- LO BUENO DE ESE ORDEN, y la razón de que esta migración sea corta:
--   * `create_report` NO SE TOCA. Sigue rechazando fotos y notas, así que todo
--     el anti-spam de la v14.0 queda exactamente como está.
--   * El bucket `report-photos` SIGUE SIN NINGUNA POLÍTICA. El cliente no
--     sube a Storage: manda la foto al Edge Function `attach-photo`, que
--     valida la propiedad y escribe con la service_role key. O sea que NO se
--     reabre el agujero de la v14.1 (cualquiera con la anon key subiendo
--     archivos arbitrarios al dominio del proyecto).
--   * Para adjuntar hay que haber publicado antes, y publicar ya está limitado
--     por el dedupe de 150 m/30 min y el tope por IP. El piso del abuso sube
--     solo, sin agregar ningún control nuevo.
--
-- Se mantiene la invariante del esquema: ninguna tabla acepta escritura
-- directa, todo pasa por una función SECURITY DEFINER.

-- ---------------------------------------------------------------------------
-- Denuncias de foto
-- ---------------------------------------------------------------------------
alter table public.reports
  add column if not exists photo_flags integer not null default 0;

comment on column public.reports.photo_flags is
  'Cuántas veces se denunció la foto de este reporte. Al llegar al umbral de '
  'flag_photo(), la foto se quita (photo = null) y un trigger la borra de '
  'Storage. El reporte en sí no se toca: puede ser legítimo aunque la foto no '
  'lo sea.';

-- ---------------------------------------------------------------------------
-- Adjuntar la foto a un reporte propio
--
-- La llama el Edge Function `attach-photo` con la service_role key, DESPUÉS de
-- haber subido el archivo a Storage. Acá solo se valida la propiedad y se
-- escribe la URL.
-- ---------------------------------------------------------------------------
create or replace function public._attach_photo(
  p_id    text,
  p_token text,
  p_photo text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  c_photo_max    constant integer := 400;
  c_photo_prefix constant text :=
    'https://nikexwjxxcxzhsuypsjn.supabase.co/storage/v1/object/public/report-photos/';
  v_hash text;
begin
  if p_id is null or p_token is null or p_photo is null then
    return false;
  end if;

  -- Misma validación que tenía create_report antes de la v14.1: la URL tiene
  -- que apuntar al bucket de este proyecto. Sin esto se podría "adjuntar"
  -- cualquier URL de internet y la app la renderizaría en un <img>.
  if length(p_photo) > c_photo_max or position(c_photo_prefix in p_photo) <> 1 then
    return false;
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- `photo is null` no es un detalle: impide REEMPLAZAR una foto ya publicada.
  -- Sin eso, alguien podría adjuntar algo inocente, esperar a que junte
  -- confirmaciones, y recién entonces cambiarla por otra cosa — y de paso
  -- dejaría huérfano el objeto anterior en Storage.
  update public.reports
     set photo = p_photo
   where id = p_id
     and photo is null
     and owner_hash is not null
     and owner_hash = v_hash;

  return found;
end;
$$;

-- Nadie desde el cliente: se llega por el Edge Function, igual que
-- _delete_report.
revoke all on function public._attach_photo(text, text, text) from public, anon, authenticated;
-- `revoke ... from public` también se lo saca a service_role, que no es dueño
-- de la función. Hay que devolvérselo o el Edge Function falla (el mismo
-- gotcha que ya mordió con _delete_report).
grant execute on function public._attach_photo(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Denunciar una foto
--
-- Esta sí la llama el cliente. Devuelve { flags, hidden }.
-- ---------------------------------------------------------------------------
create or replace function public.flag_photo(p_id text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- El umbral vive acá como constante y NO en app_config, por la misma razón
  -- que los umbrales de create_report: una función que lee de una tabla
  -- editable desde afuera es tan segura como esa tabla (ver "app_config
  -- también borraba" en CLAUDE.md). Para cambiarlo, migración nueva.
  --
  -- 3 es deliberadamente bajo. Sin cuentas de usuario, alguien decidido puede
  -- juntar 3 denuncias y tirar abajo una foto legítima — pero el reporte
  -- sobrevive y la foto es un extra, mientras que una foto abusiva a la vista
  -- de todos es mucho más grave. Se elige errar hacia sacarla.
  c_umbral constant integer := 3;
  v_flags  integer;
  v_photo  text;
begin
  if p_id is null then
    return json_build_object('flags', 0, 'hidden', false);
  end if;

  update public.reports
     set photo_flags = photo_flags + 1
   where id = p_id
     and photo is not null
  returning photo_flags, photo into v_flags, v_photo;

  if not found then
    -- No existe, o no tiene foto que denunciar. No se dice cuál de las dos.
    return json_build_object('flags', 0, 'hidden', false);
  end if;

  if v_flags >= c_umbral then
    -- Solo se quita la foto. El reporte puede ser perfectamente válido: lo
    -- denunciado es la imagen, no el aviso de que hay un retén.
    update public.reports set photo = null where id = p_id;
    return json_build_object('flags', v_flags, 'hidden', true);
  end if;

  return json_build_object('flags', v_flags, 'hidden', false);
end;
$$;

revoke all on function public.flag_photo(text) from public;
grant execute on function public.flag_photo(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trigger: cuando la moderación quita la foto, borrarla también de Storage
--
-- Sin esto, poner photo = null solo la esconde de la app: el bucket es público
-- y el objeto se sigue sirviendo por su URL directa a quien la tenga. O sea
-- que "ocultar" no serviría de nada contra quien ya la vio.
--
-- Mismo patrón pg_net -> Edge Function que reports_delete_photo, y de hecho
-- llama a la MISMA función: `delete-photo` pasó a considerar huérfana también
-- a la foto de un reporte cuyo `photo` quedó en null, no solo la de un reporte
-- borrado. La invariante que la hace segura no cambia — sigue negándose a
-- borrar una foto que un reporte esté usando.
-- ---------------------------------------------------------------------------
create or replace function public.clear_report_photo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://nikexwjxxcxzhsuypsjn.supabase.co/functions/v1/delete-photo',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pa2V4d2p4eGN4emhzdXlwc2puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNjc2ODYsImV4cCI6MjEwMDk0MzY4Nn0.09Fm8PTaCr3Qc6uuDUtn_xrviAlJ2JbLczUmVajfe04'
    ),
    body := jsonb_build_object('id', old.id)
  );
  return null;
end;
$$;

-- Sin grant: si no, PostgREST la expone como RPC pública (el linter lo marca).
revoke all on function public.clear_report_photo() from public, anon, authenticated;

drop trigger if exists reports_photo_cleared on public.reports;

create trigger reports_photo_cleared
after update of photo on public.reports
for each row
when (old.photo is not null and old.photo not like 'data:%' and new.photo is null)
execute function public.clear_report_photo();
