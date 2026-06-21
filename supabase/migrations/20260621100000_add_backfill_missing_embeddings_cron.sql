-- Safety net for silent auto_embed failures (e.g. embedding-API key outage at
-- insert time). Each embedding table has an auto_embed AFTER UPDATE trigger
-- guarded by `embedding IS NULL AND content IS NOT NULL`; touching a stale
-- null-embedding row re-fires that trigger, which re-POSTs to the auto_embed
-- Edge Function. We touch `embedding = embedding` (NULL→NULL) so the guard
-- still passes and no other data changes. Without this, rows that fail to embed
-- stay null forever until someone notices by hand (happened to memories on
-- 6/9 + 6/19). See docs/changelog.md 2026-06-21.
CREATE OR REPLACE FUNCTION public.backfill_missing_embeddings()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  tbl text;
  tables text[] := ARRAY['memories','diaries','handoff_letters','timeline','user_posts','user_replies'];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- ctid keeps the batch cap table-agnostic (no need to know each PK).
    -- 10-min age gate avoids racing the normal async embed-on-insert.
    EXECUTE format(
      'UPDATE %1$I SET embedding = embedding
         WHERE ctid IN (
           SELECT ctid FROM %1$I
           WHERE embedding IS NULL
             AND created_at < now() - interval ''10 minutes''
           LIMIT 20)', tbl);
  END LOOP;
END;
$$;

-- (Re)schedule the cron idempotently so this migration can be re-applied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'backfill-embeddings') THEN
    PERFORM cron.unschedule('backfill-embeddings');
  END IF;
END $$;

SELECT cron.schedule(
  'backfill-embeddings',
  '*/15 * * * *',
  'SELECT public.backfill_missing_embeddings();'
);
