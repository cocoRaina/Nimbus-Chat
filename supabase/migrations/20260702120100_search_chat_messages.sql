-- 聊天原文检索层：长期记忆之前全是蒸馏物（提取记忆/日记/摘要），
-- messages 表里的完整聊天原文没有任何工具能搜。这个 RPC 给
-- search_chat_history 工具用：纯关键词 ILIKE（消息没做 embedding，
-- 原文检索关键词就够用），按命中关键词数 + 时间倒序排。
--
-- 最近 10 分钟的消息排除在外：它们本来就在对话上下文里（含刚发出的
-- 这条触发搜索的消息本身），搜出来只会自己命中自己。

CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
  ON public.messages USING gin (content public.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_chat_messages(
  query_keywords text[],
  match_count integer DEFAULT 20,
  filter_after timestamp with time zone DEFAULT NULL,
  filter_before timestamp with time zone DEFAULT NULL
)
RETURNS TABLE(id text, session_id text, role text, content text, created_at timestamp with time zone, matched integer)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT m.id::text, m.session_id::text, m.role,
    CASE WHEN length(m.content) > 300 THEN left(m.content, 300) || '…' ELSE m.content END AS content,
    m.created_at,
    (SELECT count(*)::integer FROM unnest(query_keywords) k WHERE m.content ILIKE '%' || k || '%') AS matched
  FROM public.messages m
  WHERE m.content IS NOT NULL AND length(m.content) > 0
    AND m.created_at < NOW() - INTERVAL '10 minutes'
    AND (filter_after IS NULL OR m.created_at >= filter_after)
    AND (filter_before IS NULL OR m.created_at <= filter_before)
    AND EXISTS (SELECT 1 FROM unnest(query_keywords) k WHERE m.content ILIKE '%' || k || '%')
  ORDER BY matched DESC, m.created_at DESC
  LIMIT match_count;
$function$;
