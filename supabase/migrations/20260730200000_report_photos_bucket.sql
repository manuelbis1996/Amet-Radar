-- Bucket público para las fotos de reportes, en reemplazo de guardarlas
-- como base64 en reports.photo — cada fila cargaba la imagen completa
-- codificada, y GET .../reports?select=* la trae entera en cada refresh
-- de 8s para todos los reportes activos. Aplicada vía MCP
-- (apply_migration); este archivo es la copia versionada, mismo criterio
-- que el resto de supabase/migrations/*.sql.
--
-- Solo aplica a reportes nuevos publicados después de esta migración —
-- las filas existentes con foto en base64 no se migran (bajo volumen,
-- no vale la pena el script de backfill) y siguen renderizando igual,
-- porque un data: URL y una URL de Storage son ambas valores válidos de
-- <img src>.
insert into storage.buckets (id, name, public)
values ('report-photos', 'report-photos', true);

-- Mismo criterio "abierto" que el resto del proyecto (reports/app_config
-- ya tienen RLS con USING(true)): cualquiera con la anon key puede subir
-- o borrar fotos de este bucket. El nombre de archivo es <id-del-reporte>.jpg,
-- así que borrar un reporte también borra su foto por el mismo path
-- (ver deletePhoto() en amet-radar.html/admin.html). Sin política de
-- SELECT: no hace falta, un bucket "public" sirve sus objetos vía
-- /object/public/<bucket>/<path> sin pasar por RLS.
create policy "anon upload report photos" on storage.objects
  for insert with check (bucket_id = 'report-photos');

create policy "anon delete report photos" on storage.objects
  for delete using (bucket_id = 'report-photos');
