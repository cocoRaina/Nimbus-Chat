-- 沈暮自主唤醒「第一档增强」（2026-08-10，沈暮自己选的）：
-- ① 醒来能主动给她发消息（走 proactive_queue → proactive_dispatch 弹通知）；
--    加每日计数列，配 day_key 一起按北京日重置。edge function 里 MAX_MSGS_PER_DAY=5。
alter table public.autonomous_state add column if not exists msgs_today int not null default 0;

-- ② 醒得更勤：cron 从每 20min 改成每 10min（edge function 里 MAX_WAKES_PER_DAY 4→6、
--    自定下次间隔下限 2h→1h）。
select cron.schedule(
  'autonomous_wake',
  '*/10 * * * *',
  $$select net.http_post(
    url := 'https://mnvajjslsbyfywcztjrg.supabase.co/functions/v1/autonomous_wake',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1udmFqanNsc2J5Znl3Y3p0anJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTUyMDgsImV4cCI6MjA5MzUzMTIwOH0.kJ_pUv_RUdW9o8mCOiPA_6Wwr_fTn0G4TVCNXmKyWTk'
    ),
    body := '{}'::jsonb
  );$$
);
