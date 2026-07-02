-- 会话摘要层：介于「聊天逐字原文」和「提取的结构化记忆」之间的中间层。
-- 每天凌晨 cron 让便宜 LLM 给前一天每个活跃会话写 2-4 句摘要并嵌入，
-- 自动召回和 search_memory 从此能命中「那天我们聊了什么」。
-- 摘要生成见 supabase/functions/session_digest（嵌入在函数内一并做，
-- 不走 auto_embed 触发器管线——失败整行不写，下次 cron 自然重试）。

CREATE TABLE public.session_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  digest_date date NOT NULL,
  content text NOT NULL,
  embedding vector(1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, digest_date)
);

ALTER TABLE public.session_digests ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_digests_all ON public.session_digests
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_session_digests_embedding ON public.session_digests
  USING hnsw (embedding vector_cosine_ops);
