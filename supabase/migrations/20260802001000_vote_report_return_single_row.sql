-- Bug de 20260801120000_lock_down_writes.sql, encontrado probando contra la
-- base real: `return query` en plpgsql AGREGA filas al resultado y **sigue
-- ejecutando** — no corta como un `return` normal. Cuando el reporte llegaba
-- al umbral de retiro comunitario, vote_report devolvía DOS filas:
--
--   {"confirms":0,"denies":5,"removed":true}
--   {"confirms":0,"denies":5,"removed":false}
--
-- El cliente lee `rows[0]`, así que acertaba de casualidad; cualquier
-- consumidor que mirara la última fila (o contara filas) leería exactamente
-- lo contrario de lo que pasó.

create or replace function public.vote_report(p_id text, p_dir text)
returns table(confirms integer, denies integer, removed boolean)
language plpgsql
security definer
set search_path = public, extensions
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
  -- hardcodeado, para que siga habiendo un solo lugar de verdad.
  select deny_threshold into v_threshold from public.app_config where id;
  v_threshold := coalesce(v_threshold, 2);

  -- OJO con el alias `r`: los nombres de salida de un `returns table(...)`
  -- son variables de plpgsql dentro de la función, así que un
  -- `coalesce(confirms, 0)` suelto choca con la columna y Postgres corta con
  -- "column reference is ambiguous". Todo lo que lea la fila va calificado.
  update public.reports r
     set confirms = coalesce(r.confirms, 0) + (case when p_dir = 'confirm' then 1 else 0 end),
         denies   = coalesce(r.denies, 0)   + (case when p_dir = 'deny'    then 1 else 0 end)
   where r.id = p_id
   returning r.confirms, r.denies into v_confirms, v_denies;

  if not found then
    raise exception 'reporte inexistente';
  end if;

  if v_denies - v_confirms >= v_threshold then
    perform public._delete_report(p_id);
    return query select v_confirms, v_denies, true;
    return;  -- sin esto, sigue y agrega una segunda fila con removed=false
  end if;

  return query select v_confirms, v_denies, false;
end;
$$;

revoke all on function public.vote_report(text, text) from public;
grant execute on function public.vote_report(text, text) to anon, authenticated;
