-- Schedule the server-side cache keepalive Edge Function to fire every 5min.
-- The Edge Function itself gates by 08:00–23:00 Asia/Shanghai window, by
-- last_chat_at within 4h, and by a 50min per-user ping cooldown — so the
-- cron job stays simple and the smarts live next to the data.
--
-- AUTH NOTE: Supabase's Edge Function gateway rejects requests without an
-- apikey/Authorization header even when the function has verify_jwt:false
-- (UNAUTHORIZED_NO_AUTH_HEADER). We use the anon key here because:
--   1. It's already public (shipped in the web/APK bundle).
--   2. The function itself uses SUPABASE_SERVICE_ROLE_KEY internally to
--      bypass RLS and read cache_keepalive_state — the gateway header is
--      just to get past the apikey check.
--   3. current_setting('supabase.service_role_key', true) returns NULL
--      in pg_cron's session context (it's only populated for sessions
--      that explicitly set it, e.g. PostgREST), so the obvious-looking
--      'Bearer ' || current_setting(...) pattern silently produced an
--      empty bearer and 401'd every cron tick.
--
-- To disable (e.g. during debugging or if costs go sideways):
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='cache-keepalive'), active := false);

do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'cache-keepalive';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end $$;

select cron.schedule(
  'cache-keepalive',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://mnvajjslsbyfywcztjrg.supabase.co/functions/v1/cache_keepalive',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1udmFqanNsc2J5Znl3Y3p0anJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTUyMDgsImV4cCI6MjA5MzUzMTIwOH0.kJ_pUv_RUdW9o8mCOiPA_6Wwr_fTn0G4TVCNXmKyWTk'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
