-- 数据库瘦身 + 防再堆。免费档 500MB，某次涨到 ~180MB（1/3），排查发现
-- 全是日志垃圾，不是用户数据：
--   net._http_response  47MB —— pg_net 存的 HTTP 响应缓存（每次 cron 调
--                               Edge Function 都留一条；这些函数 fire-and-
--                               forget、从不回读响应，所以可随便清）
--   cron.job_run_details 34MB —— pg_cron 运行日志（proactive-dispatch 每
--                               分钟一跑 → 一天 1440 条）
-- 一次性清理（truncate net._http_response + delete 旧 job_run_details +
-- VACUUM FULL）已手动执行，把库从 ~180MB 压到 ~53MB。
--
-- 下面是防再堆的每日维护 cron（凌晨 4 点）。幂等：先删同名旧任务。
do $$
declare existing bigint;
begin
  select jobid into existing from cron.job where jobname = 'log-tables-cleanup';
  if existing is not null then perform cron.unschedule(existing); end if;
end $$;

select cron.schedule(
  'log-tables-cleanup',
  '0 4 * * *',
  $cron$
    truncate table net._http_response;
    delete from cron.job_run_details where end_time < now() - interval '2 days';
  $cron$
);
