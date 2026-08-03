-- Cierra el insert directo de anon sobre public.reports.
--
-- VA SEPARADA DE 20260803120000 A PROPÓSITO, Y SE APLICA DESPUÉS DE
-- DESPLEGAR EL CLIENTE NUEVO. Motivo: la app que está en la calle publica con
-- POST /rest/v1/reports. En el instante en que se corre este archivo, todo
-- navegador que todavía no bajó la versión nueva (v14.0, la que llama a
-- create_report) deja de poder publicar. Con las dos migraciones juntas, la
-- ventana de rotura arranca al aplicar; separadas, arranca recién cuando el
-- cliente nuevo ya está arriba.
--
-- Orden correcto:
--   1. aplicar 20260803120000_server_side_rate_limit.sql   (aditiva, inocua)
--   2. mergear a main y esperar el deploy de Cloudflare
--   3. aplicar ESTE archivo
--
-- Sin este paso todo el anti-spam del servidor es decorativo: la RPC
-- create_report existiría, pero seguiría estando abierto el camino viejo que
-- se la saltea entera.

drop policy if exists "public insert" on public.reports;

-- "public read" queda como estaba: leer es anónimo por diseño del proyecto.
-- Después de esto, las políticas de public.reports son:
--   select -> "public read"  (abierta, a propósito)
--   insert -> ninguna        (pasa por create_report)
--   update -> ninguna        (pasa por vote_report, desde v12.0)
--   delete -> ninguna        (pasa por delete_own_report /
--                             purge_expired_reports / _delete_report)
