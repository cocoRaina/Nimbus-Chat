-- Diagnostics「记忆状态」tab 用：最近 N 天（北京时区、不含今天）每天的
-- 消息数 vs 摘要数，前端据此显示 🟢有摘要 / ⚪消息太少跳过 / 🔴缺摘要。
CREATE OR REPLACE FUNCTION public.digest_coverage(check_days integer DEFAULT 7)
RETURNS TABLE(day date, msg_count integer, digest_count integer)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
  WITH days AS (
    SELECT ((now() AT TIME ZONE 'Asia/Shanghai')::date - offs) AS day
    FROM generate_series(1, GREATEST(1, LEAST(30, check_days))) offs
  )
  SELECT d.day,
    (SELECT count(*)::integer FROM public.messages m
      WHERE (m.created_at AT TIME ZONE 'Asia/Shanghai')::date = d.day) AS msg_count,
    (SELECT count(*)::integer FROM public.session_digests sd
      WHERE sd.digest_date = d.day) AS digest_count
  FROM days d
  ORDER BY d.day DESC;
$function$;
