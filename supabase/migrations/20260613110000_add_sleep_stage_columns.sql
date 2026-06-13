ALTER TABLE health_data
  ADD COLUMN IF NOT EXISTS deep_sleep_hours  NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS light_sleep_hours NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS rem_sleep_hours   NUMERIC(4,1);
