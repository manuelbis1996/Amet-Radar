-- Cierra el último agujero barato que quedaba abierto: subir al bucket.
--
-- PROBLEMA. `20260730200000_report_photos_bucket.sql` creó el bucket sin
-- file_size_limit ni allowed_mime_types, y con una política de insert que
-- solo mira el bucket:
--
--   create policy "anon upload report photos" on storage.objects
--     for insert with check (bucket_id = 'report-photos');
--
-- O sea que cualquiera con la anon key (pública dentro de amet-radar.html,
-- por diseño) podía subir archivos arbitrarios, de cualquier tipo, hasta el
-- tope global del plan (50 MB por archivo). Con 1 GB de cuota en el plan
-- Free, son ~20 peticiones para llenarla — y cuando se llena **nadie puede
-- publicar un reporte con foto**. Más barato de explotar que el agujero de
-- borrado que cerró v12.0.
--
-- LÍMITE ELEGIDO: 512 KB. compressImage() en amet-radar.html reduce a 480px
-- de ancho con JPEG q0.6; midiendo el peor caso plausible (retrato de ruido
-- a todo color, que comprime peor que cualquier foto real) da **76 KB**, así
-- que 512 KB deja 6.7x de margen y no puede rechazar una foto legítima.
-- Baja el techo del ataque unas 100 veces.

update storage.buckets
   set file_size_limit = 524288,                 -- 512 KB
       allowed_mime_types = array['image/jpeg']  -- uploadPhoto() siempre manda image/jpeg
 where id = 'report-photos';

-- Además, el nombre del objeto tiene que parecerse al id que genera la app
-- (`report_<epoch>_<6 al azar>.jpg`, ver publishReport/publishQuickReport).
-- No frena a quien quiera gastar la cuota igual, pero evita que el bucket se
-- llene de archivos con rutas arbitrarias y deja los huérfanos identificables.
drop policy if exists "anon upload report photos" on storage.objects;

create policy "anon upload report photos" on storage.objects
  for insert with check (
    bucket_id = 'report-photos'
    -- `*` y no `+` en el sufijo: Math.random().toString(36).slice(2,8) da 6
    -- caracteres en la práctica (verificado sobre 300k ids), pero podría dar
    -- menos —incluso vacío— y un nombre legítimo no debería rebotar por eso.
    and name ~ '^report_[0-9]+_[a-z0-9]*\.jpg$'
  );

-- NO se agrega política de delete: sigue sin haberla desde v12.0, la
-- limpieza la hace el Edge Function delete-photo (ver "Borrar fotos" en
-- CLAUDE.md).
--
-- LO QUE ESTO NO CUBRE, a propósito:
-- - allowed_mime_types se valida contra el Content-Type que manda el cliente,
--   no olfateando el archivo: quien quiera subir otra cosa solo tiene que
--   mentir en el header. El control real acá es el límite de tamaño.
-- - Fotos huérfanas: uploadPhoto() corre ANTES de insertar la fila, así que
--   si la red se corta en el medio queda un objeto sin reporte. Nada las
--   limpia hoy (el trigger reports_delete_photo solo dispara al borrarse una
--   fila). Con el límite de tamaño el desperdicio es acotado; si algún día
--   molesta, una barrida periódica de objetos sin fila en reports lo resuelve.
