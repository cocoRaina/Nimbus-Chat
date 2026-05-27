-- user_settings: add memory extract columns
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS memory_extract_model TEXT DEFAULT 'anthropic/claude-haiku-4-5',
  ADD COLUMN IF NOT EXISTS memory_merge_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_memory_extract_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS memory_extract_interval_hours INT DEFAULT 6,
  ADD COLUMN IF NOT EXISTS last_memory_extract_at TIMESTAMPTZ;

-- memories: add source column
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- timeline: add source column
ALTER TABLE timeline
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- Index for filtering by source
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_timeline_source ON timeline(source);

-- memory_extract_log table
CREATE TABLE IF NOT EXISTS memory_extract_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  messages_scanned INT,
  memories_extracted INT,
  memories_inserted INT,
  memories_skipped INT,
  timeline_extracted INT,
  timeline_inserted INT,
  duration_ms INT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_extract_log_user ON memory_extract_log(user_id, created_at DESC);

-- RLS for memory_extract_log
ALTER TABLE memory_extract_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can read own extract logs' AND tablename = 'memory_extract_log'
  ) THEN
    CREATE POLICY "Users can read own extract logs"
      ON memory_extract_log FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert own extract logs' AND tablename = 'memory_extract_log'
  ) THEN
    CREATE POLICY "Users can insert own extract logs"
      ON memory_extract_log FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
