-- Sticker library: server-hosted stickers the AI can search and send
CREATE TABLE IF NOT EXISTS stickers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  url         text NOT NULL,
  pack        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE stickers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stickers_select" ON stickers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "stickers_insert" ON stickers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "stickers_delete" ON stickers FOR DELETE USING (auth.uid() = user_id);

-- Cooldown tracking for spontaneous AI-initiated proactive messages
ALTER TABLE cache_keepalive_state
  ADD COLUMN IF NOT EXISTS proactive_ai_cooldown_until timestamptz;
