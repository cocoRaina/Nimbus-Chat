-- exec_sql RPC: lets the VPS backend (service_role) run arbitrary SQL for
-- 小机's vps_exec_sql tool. Hardened so ONLY service_role can call it —
-- the anon/authenticated keys (exposed in the frontend) must never reach it,
-- otherwise anyone could run arbitrary SQL against the database.
--
-- Behaviour: SELECT-ish queries come back as a JSON array of rows
-- (json_agg); DML/DDL that returns nothing comes back as {"ok": true}.

create or replace function public.exec_sql(query text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result json;
begin
  -- Try to capture rows (works for SELECT / RETURNING).
  execute 'select coalesce(json_agg(t), ''[]''::json) from (' || query || ') t'
    into result;
  return result;
exception
  -- Statements that produce no result set (INSERT/UPDATE/DELETE/DDL without
  -- RETURNING) can't be wrapped in a subquery; run them plainly and ack.
  when others then
    begin
      execute query;
      return json_build_object('ok', true);
    exception when others then
      return json_build_object('ok', false, 'error', sqlerrm);
    end;
end;
$$;

-- Lock it down: not callable by the public / anon / authenticated roles.
revoke all on function public.exec_sql(text) from public;
revoke all on function public.exec_sql(text) from anon;
revoke all on function public.exec_sql(text) from authenticated;
grant execute on function public.exec_sql(text) to service_role;
