-- Schedule proactive_dispatch Edge Function every 5 minutes.
-- Same auth pattern as cache-keepalive (anon key in header, service role
-- used internally by the function). See 20260602150000_schedule_cache_keepalive_cron.sql
-- for the full explanation of why anon key is used here.
--
-- To pause:
--   SELECT cron.alter_job(
--     (SELECT jobid FROM cron.job WHERE jobname='proactive-dispatch'),
--     active := false
--   );

do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'proactive-dispatch';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end $$;

select cron.schedule(
  'proactive-dispatch',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://mnvajjslsbyfywcztjrg.supabase.co/functions/v1/proactive_dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1udmFqanNsc2J5Znl3Y3p0anJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTUyMDgsImV4cCI6MjA5MzUzMTIwOH0.kJ_pUv_RUdW9o8mCOiPA_6Wwr_fTn0G4TVCNXmKyWTk'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
