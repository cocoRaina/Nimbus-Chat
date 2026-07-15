-- 🖼 小机的相册。小机自己收藏聊天里出现过的图 → 只存"书签"：图的引用
-- （已在 chat-images bucket，不复制、零额外存储）+ 它写的收藏理由 + 标签。
-- 用户担心的 Supabase 存储占用几乎不存在——真图收不收藏都已经上传过了。
CREATE TABLE IF NOT EXISTS assistant_album (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  image_url  text        NOT NULL,               -- chat-images 公网 URL
  image_path text,                               -- bucket path（可选，将来清理保护用）
  note       text,                               -- 小机写的收藏理由
  tags       text[]      NOT NULL DEFAULT '{}',
  source     text        NOT NULL DEFAULT 'chat', -- 图来源：chat（聊天里的）
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE assistant_album ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own album"
  ON assistant_album
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 同一张图防重复收藏（小机可能忘了自己收过 → save_to_album 先查）
CREATE UNIQUE INDEX IF NOT EXISTS assistant_album_user_url
  ON assistant_album (user_id, image_url);

CREATE INDEX IF NOT EXISTS assistant_album_user_created
  ON assistant_album (user_id, created_at DESC);
