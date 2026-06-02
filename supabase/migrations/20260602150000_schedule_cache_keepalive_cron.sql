-- Schedule the server-side cache keepalive Edge Function to fire every 5min.
-- The Edge Function itself gates by 08:00–23:00 Asia/Shanghai window, by
-- last_chat_at within 4h, and by a 50min per-user ping cooldown — so the
-- cron job stays simple and the smarts live next to the data.
--
-- To disable (e.g. during debugging or if costs go sideways):
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='cache-keepalive'), active := false);

-- Unschedule the previous version if it exists, then re-create. cron.schedule
-- doesn't have an "if not exists" so this avoids duplicate jobs on re-run.
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
      'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true)
    ),
    body := '{}'::jsonb
  );
  $cron$
);
