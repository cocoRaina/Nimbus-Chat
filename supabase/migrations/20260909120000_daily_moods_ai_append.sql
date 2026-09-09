-- 碎碎念：AI 心情从"每天覆盖一条"改为"追加多条"。
-- 删掉原来的全局唯一约束 (user_id, mood_date, author)，
-- 只给 user 端保留 partial unique index（用户每天仍只一条，upsert 仍走通）。
ALTER TABLE public.daily_moods
  DROP CONSTRAINT IF EXISTS daily_moods_user_id_mood_date_author_key;

CREATE UNIQUE INDEX IF NOT EXISTS daily_moods_user_unique
  ON public.daily_moods (user_id, mood_date, author)
  WHERE author = 'user';
