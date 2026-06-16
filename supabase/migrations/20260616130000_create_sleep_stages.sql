-- sleep_stages: raw Health Connect sleep segment records.
-- Complements health_daily (which holds aggregated total duration) with
-- per-stage breakdowns (Deep / Light / REM / Awake) so we can compute
-- the stage ratios the aggregate query can't give.
--
-- Populated by writeSleepStagesToSupabase() in healthSync.ts.
-- Source value format: "9 (Deep)" → duration=9, stage="Deep"

CREATE TABLE IF NOT EXISTS sleep_stages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  start_time timestamptz NOT NULL,
  end_time   timestamptz NOT NULL,
  duration   numeric     NOT NULL,  -- numeric minutes extracted from "9 (Deep)"
  stage      text        NOT NULL,  -- "Deep" / "Light" / "REM" / "Awake"
  synced_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (start_time, stage)
);

ALTER TABLE sleep_stages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own sleep stages"
  ON sleep_stages FOR ALL USING (true) WITH CHECK (true);
