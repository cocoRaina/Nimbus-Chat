-- proactive_queue: stores AI-scheduled "proactive messages" so the server
-- can dispatch them into the messages table at fire_at even when the app is
-- closed.  The client-side path (insertPendingProactiveRef) still runs as a
-- fast-path when the app is open, but it claims the row via
-- UPDATE WHERE sent=false so whichever side wins, only one insert happens.

CREATE TABLE IF NOT EXISTS proactive_queue (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  session_id uuid        REFERENCES sessions ON DELETE CASCADE,
  text       text        NOT NULL,
  fire_at    timestamptz NOT NULL,
  persist    boolean     NOT NULL DEFAULT false,
  sent       boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE proactive_queue ENABLE ROW LEVEL SECURITY;

-- Users can read/write/delete their own queue entries.
-- UPDATE (to claim / mark sent) is also user-accessible so the client-side
-- path can race the server without needing a separate RPC.
CREATE POLICY "Users manage their own proactive queue"
  ON proactive_queue
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Fast lookup: all unsent entries firing soon (used by proactive_dispatch cron)
CREATE INDEX IF NOT EXISTS proactive_queue_fire_at_sent
  ON proactive_queue (fire_at) WHERE (sent = false);
