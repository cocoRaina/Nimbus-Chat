-- 图片→文字描述缓存上云。原本只存手机 localStorage，重装/换设备即丢，
-- 导致历史图片退回原图、在按 base64 计费的中转上把 context 撑到几十万 token。
CREATE TABLE IF NOT EXISTS image_captions (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url_hash   text        NOT NULL,           -- FNV-1a(url) 短哈希，避免用超长 url 当主键
  caption    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, url_hash)
);

ALTER TABLE image_captions ENABLE ROW LEVEL SECURITY;

-- 带 user_id 的表用 auth.uid()=user_id（单租户开放策略的例外，见 CLAUDE.md）
CREATE POLICY "own captions select" ON image_captions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own captions insert" ON image_captions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own captions update" ON image_captions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own captions delete" ON image_captions
  FOR DELETE USING (auth.uid() = user_id);
