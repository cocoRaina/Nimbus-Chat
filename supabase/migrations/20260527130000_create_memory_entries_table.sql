CREATE TABLE IF NOT EXISTS memory_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  content TEXT NOT NULL,
  source TEXT DEFAULT 'ai_suggested',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_user_status ON memory_entries(user_id, status, is_deleted);
CREATE INDEX IF NOT EXISTS idx_memory_entries_updated ON memory_entries(user_id, updated_at DESC);

ALTER TABLE memory_entries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can read own memory entries' AND tablename = 'memory_entries'
  ) THEN
    CREATE POLICY "Users can read own memory entries"
      ON memory_entries FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert own memory entries' AND tablename = 'memory_entries'
  ) THEN
    CREATE POLICY "Users can insert own memory entries"
      ON memory_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can update own memory entries' AND tablename = 'memory_entries'
  ) THEN
    CREATE POLICY "Users can update own memory entries"
      ON memory_entries FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;
