-- Filtro de categorías por suscripción: qué categorías de reporte quiere
-- recibir cada dispositivo. Sin "default" explícito -> las filas
-- existentes quedan en NULL automáticamente, que significa "todas las
-- categorías" (mismo comportamiento que antes de esta migración, sin
-- backfill necesario).
alter table public.push_subscriptions
  add column categories text[];

-- Sin cambios de RLS: las políticas de insert/update ya son
-- `with check (true)` / `using (true) with check (true)` sin restricción
-- por columna (ver 20260730000000_push_subscriptions.sql), así que
-- cubren esta columna nueva automáticamente.
