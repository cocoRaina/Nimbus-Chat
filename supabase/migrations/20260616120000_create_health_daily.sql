-- health_daily: flexible per-(record_type, date) storage for Health Connect
-- aggregation data. More extensible than the fixed-column health_data table —
-- any future record type (weight, blood glucose, etc.) just adds a new row,
-- no schema change needed.
--
-- Populated by writeHealthAggregatesToSupabase() in healthSync.ts, called
-- when Health Connect aggregation data is available in the canonical format:
--   { record_type, aggregations: [{ period_start, period_end, unit, values: [{aggregation_type, value}] }] }

CREATE TABLE IF NOT EXISTS health_daily (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type text        NOT NULL,
  date        date        NOT NULL,
  sum         numeric,
  average     numeric,
  min         numeric,
  max         numeric,
  duration    numeric,
  unit        text,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_type, date)
);

ALTER TABLE health_daily ENABLE ROW LEVEL SECURITY;

-- Single-tenant open policy, matching health_data and other health tables.
CREATE POLICY "Users manage their own health daily"
  ON health_daily FOR ALL USING (true) WITH CHECK (true);
