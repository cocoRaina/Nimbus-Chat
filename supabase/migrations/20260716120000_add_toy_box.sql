-- 🧸 玩具库。用户把喜欢的 artifact 小玩具（小机写的自包含 HTML）收藏起来，
-- 记忆库抽屉里随时翻出来玩。和相册不同：玩具的"本体"就是代码文本，所以
-- 这里直接存代码（一个玩具 5-15KB 文本，几百个也才几 MB，无存储压力）——
-- 好处是即使聊天记录被压缩/清理，收藏过的玩具永远完整可玩。
CREATE TABLE IF NOT EXISTS toy_box (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title      text        NOT NULL,               -- 用户给玩具起的名字
  code       text        NOT NULL,               -- 自包含 HTML 源码（玩具本体）
  note       text,                               -- 可选备注（哪天、为什么喜欢）
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE toy_box ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own toy box"
  ON toy_box
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS toy_box_user_created
  ON toy_box (user_id, created_at DESC);
