-- search_letters: blend vector similarity (60%) + recency (40%) so that
-- newer handoff letters surface even when the query is generic.
-- Recency score decays linearly over 60 days (today=1.0, 30d ago=0.5, 60d+=0.0).
CREATE OR REPLACE FUNCTION public.search_letters(
  query_embedding vector,
  match_count integer DEFAULT 5,
  min_similarity double precision DEFAULT 0.3
)
RETURNS TABLE(
  id bigint,
  date date,
  title text,
  content text,
  signature text,
  similarity double precision,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions'
AS $$
  SELECT
    id, date, title, content, signature,
    (1 - (embedding <=> query_embedding)) AS similarity,
    created_at
  FROM public.handoff_letters
  WHERE
    embedding IS NOT NULL
    AND (1 - (embedding <=> query_embedding)) >= min_similarity
  ORDER BY
    0.6 * (1 - (embedding <=> query_embedding))
    + 0.4 * GREATEST(0.0, 1.0 - EXTRACT(EPOCH FROM (NOW() - created_at)) / (86400.0 * 60))
    DESC
  LIMIT match_count;
$$;
