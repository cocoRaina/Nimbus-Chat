-- autonomous_state 之前只有 authenticated 的 SELECT 策略（读），没有 UPDATE 策略。
-- 设置页「自主唤醒」板块要从客户端改 enabled/wake_provider/max_wakes_per_day，
-- 没有 UPDATE 策略时 PostgREST 会静默影响 0 行（不报错、也没写进去）——踩过的坑。
-- 补一条单租户开放的 UPDATE 策略（照 memory/period_tracking 那套 USING(true)）。
-- 服务端 cron（autonomous_wake）用 service_role，绕过 RLS，不受影响。

create policy autonomous_state_authenticated_write
  on public.autonomous_state
  for update
  to authenticated
  using (true)
  with check (true);
