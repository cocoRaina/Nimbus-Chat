-- 🌙 睡眠巩固 cron：每周一 05:00 北京时间（周日 21:00 UTC）调
-- weekly_consolidate——读近 14 天每日摘要，蒸馏 0-3 条模式级记忆进待确认。
select cron.schedule(
  'weekly-consolidate',
  '0 21 * * 0',
  $$
  select net.http_post(
    url := 'https://mnvajjslsbyfywcztjrg.supabase.co/functions/v1/weekly_consolidate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1udmFqanNsc2J5Znl3Y3p0anJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTUyMDgsImV4cCI6MjA5MzUzMTIwOH0.kJ_pUv_RUdW9o8mCOiPA_6Wwr_fTn0G4TVCNXmKyWTk'
    ),
    body := '{}'::jsonb
  );
  $$
);
