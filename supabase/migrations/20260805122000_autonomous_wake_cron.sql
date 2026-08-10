-- 每 20 分钟叫一次 autonomous_wake edge function（函数自己过四道闸：enabled /
-- 日上限 4 / 北京 0-8 点安静 / 她 45min 内在场则让路）。anon key 是公开的
-- （同 cache_keepalive / proactive_dispatch 的 cron 调用约定）。
select cron.schedule(
  'autonomous_wake',
  '*/20 * * * *',
  $$select net.http_post(
    url := 'https://mnvajjslsbyfywcztjrg.supabase.co/functions/v1/autonomous_wake',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1udmFqanNsc2J5Znl3Y3p0anJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTUyMDgsImV4cCI6MjA5MzUzMTIwOH0.kJ_pUv_RUdW9o8mCOiPA_6Wwr_fTn0G4TVCNXmKyWTk'
    ),
    body := '{}'::jsonb
  );$$
);

-- 关停：select cron.unschedule('autonomous_wake');  或  update autonomous_state set enabled=false where id=1;
