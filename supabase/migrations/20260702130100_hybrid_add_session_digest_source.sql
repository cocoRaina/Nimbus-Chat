-- 混合检索加第 7 个源：session_digest（会话摘要）。签名不变，直接 REPLACE。
CREATE OR REPLACE FUNCTION public.search_memories_hybrid(
  query_embedding vector,
  query_keywords text[] DEFAULT NULL::text[],
  match_count integer DEFAULT 5,
  filter_category text DEFAULT NULL::text,
  min_similarity double precision DEFAULT 0.4,
  filter_table text DEFAULT NULL::text,
  filter_tags text[] DEFAULT NULL::text[],
  filter_after timestamp with time zone DEFAULT NULL::timestamp with time zone,
  filter_before timestamp with time zone DEFAULT NULL::timestamp with time zone,
  exclude_locked boolean DEFAULT false
)
RETURNS TABLE(id text, source text, title text, content text, category text, tags text[], similarity double precision, created_at timestamp with time zone)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
  WITH combined AS (
    SELECT id::text, 'memory'::text AS source, NULL::text AS title, content,
      COALESCE(category, '日常')::text AS category, COALESCE(tags, ARRAY[]::text[]) AS tags,
      1 - (embedding <=> query_embedding) AS similarity, created_at
    FROM public.memories
    WHERE embedding IS NOT NULL
      AND (NOT exclude_locked OR NOT COALESCE(locked, false))
      AND (filter_category IS NULL OR category = filter_category)
      AND (filter_table IS NULL OR filter_table = 'memory')
      AND (filter_tags IS NULL OR tags && filter_tags)
      AND (filter_after IS NULL OR created_at >= filter_after)
      AND (filter_before IS NULL OR created_at <= filter_before)
    UNION ALL
    SELECT id::text, 'diary'::text, title, content, COALESCE(mood, '日记')::text, ARRAY[]::text[],
      1 - (embedding <=> query_embedding), date::timestamptz
    FROM public.diaries
    WHERE embedding IS NOT NULL AND (filter_table IS NULL OR filter_table = 'diary')
      AND filter_category IS NULL AND filter_tags IS NULL
      AND (filter_after IS NULL OR date::timestamptz >= filter_after)
      AND (filter_before IS NULL OR date::timestamptz <= filter_before)
    UNION ALL
    SELECT id::text, 'letter'::text, title, content, '交接信'::text, ARRAY[]::text[],
      1 - (embedding <=> query_embedding), date::timestamptz
    FROM public.handoff_letters
    WHERE embedding IS NOT NULL AND (filter_table IS NULL OR filter_table = 'letter')
      AND filter_category IS NULL AND filter_tags IS NULL
      AND (filter_after IS NULL OR date::timestamptz >= filter_after)
      AND (filter_before IS NULL OR date::timestamptz <= filter_before)
    UNION ALL
    SELECT id::text, 'timeline'::text, title, COALESCE(description, title), COALESCE(category, '里程碑')::text, ARRAY[]::text[],
      1 - (embedding <=> query_embedding), event_date::timestamptz
    FROM public.timeline
    WHERE embedding IS NOT NULL AND (filter_table IS NULL OR filter_table = 'timeline')
      AND filter_category IS NULL AND filter_tags IS NULL
      AND (filter_after IS NULL OR event_date::timestamptz >= filter_after)
      AND (filter_before IS NULL OR event_date::timestamptz <= filter_before)
    UNION ALL
    SELECT id::text, 'snack_post'::text, NULL::text, content, '朋友圈'::text, ARRAY[]::text[],
      1 - (embedding <=> query_embedding), created_at
    FROM public.user_posts
    WHERE embedding IS NOT NULL AND NOT is_deleted AND (filter_table IS NULL OR filter_table = 'snack_post')
      AND filter_category IS NULL AND filter_tags IS NULL
      AND (filter_after IS NULL OR created_at >= filter_after)
      AND (filter_before IS NULL OR created_at <= filter_before)
    UNION ALL
    SELECT r.id::text, 'snack_reply'::text, NULL::text, r.content, '朋友圈回复'::text, ARRAY[]::text[],
      1 - (r.embedding <=> query_embedding), r.created_at
    FROM public.user_replies r
    WHERE r.embedding IS NOT NULL AND NOT r.is_deleted AND (filter_table IS NULL OR filter_table = 'snack_reply')
      AND filter_category IS NULL AND filter_tags IS NULL
      AND (filter_after IS NULL OR r.created_at >= filter_after)
      AND (filter_before IS NULL OR r.created_at <= filter_before)
    UNION ALL
    SELECT d.id::text, 'session_digest'::text, NULL::text, d.content, '对话摘要'::text, ARRAY[]::text[],
      1 - (d.embedding <=> query_embedding), d.digest_date::timestamptz
    FROM public.session_digests d
    WHERE d.embedding IS NOT NULL AND (filter_table IS NULL OR filter_table = 'session_digest')
      AND filter_category IS NULL AND filter_tags IS NULL
      AND (filter_after IS NULL OR d.digest_date::timestamptz >= filter_after)
      AND (filter_before IS NULL OR d.digest_date::timestamptz <= filter_before)
  ),
  scored AS (
    SELECT c.*, (
      query_keywords IS NOT NULL AND array_length(query_keywords, 1) > 0 AND EXISTS (
        SELECT 1 FROM unnest(query_keywords) k
        WHERE c.content ILIKE '%' || k || '%' OR (c.title IS NOT NULL AND c.title ILIKE '%' || k || '%')
      )
    ) AS kw_match
    FROM combined c
  ),
  vec AS (
    SELECT id, source, row_number() OVER (ORDER BY similarity DESC) AS rnk
    FROM scored WHERE similarity >= min_similarity
  ),
  lex AS (
    SELECT id, source, rnk FROM (
      SELECT id, source, row_number() OVER (ORDER BY similarity DESC NULLS LAST, created_at DESC) AS rnk
      FROM scored WHERE kw_match
    ) t WHERE rnk <= 50
  ),
  fused AS (
    SELECT COALESCE(v.id, l.id) AS id, COALESCE(v.source, l.source) AS source,
      COALESCE(1.0 / (60 + v.rnk), 0) + COALESCE(1.0 / (60 + l.rnk), 0) AS rrf
    FROM vec v FULL OUTER JOIN lex l ON v.id = l.id AND v.source = l.source
  )
  SELECT s.id, s.source, s.title, s.content, s.category, s.tags, s.similarity, s.created_at
  FROM fused f
  JOIN scored s ON s.id = f.id AND s.source = f.source
  ORDER BY (
      f.rrf
      + 0.05 * exp(- GREATEST(EXTRACT(EPOCH FROM (NOW() - s.created_at)), 0) / (86400.0 * 30))
    ) DESC NULLS LAST,
    s.similarity DESC NULLS LAST
  LIMIT match_count;
$function$;
