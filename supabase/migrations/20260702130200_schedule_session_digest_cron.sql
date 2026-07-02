-- 每天北京时间 04:30（UTC 20:30）跑会话摘要（和记忆维护同一个凌晨时段）。
-- Bearer 是项目 anon key（公开值，与 cache-keepalive / proactive-dispatch 同模式）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'session-digest') THEN
    PERFORM cron.unschedule('session-digest');
  END IF;
END $$;

SELECT cron.schedule(
  'session-digest',
  '30 20 * * *',
  $$
  select net.http_post(
    url := 'https://mnvajjslsbyfywcztjrg.supabase.co/functions/v1/session_digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1udmFqanNsc2J5Znl3Y3p0anJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTUyMDgsImV4cCI6MjA5MzUzMTIwOH0.kJ_pUv_RUdW9o8mCOiPA_6Wwr_fTn0G4TVCNXmKyWTk'
    ),
    body := '{}'::jsonb
  );
  $$
);
