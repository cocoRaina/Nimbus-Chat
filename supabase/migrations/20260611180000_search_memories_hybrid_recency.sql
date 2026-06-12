-- Add a recency nudge to hybrid search ranking: a small exponentially decaying
-- bonus (half-life ~30d, weight 0.006) added to the RRF score, so among
-- similarly-relevant results the more recent ranks higher — without letting
-- recency override a clearly stronger semantic/keyword match.
-- (Idea borrowed from paramecium's RRF + recency weighting; reimplemented.)
-- Only the final ORDER BY changed vs 20260607130000_add_search_memories_hybrid.
create or replace function public.search_memories_hybrid(
  query_embedding vector,
  query_keywords text[] default null,
  match_count integer default 5,
  filter_category text default null,
  min_similarity double precision default 0.4,
  filter_table text default null,
  filter_tags text[] default null,
  filter_after timestamp with time zone default null,
  filter_before timestamp with time zone default null
)
returns table(id text, source text, title text, content text, category text, tags text[], similarity double precision, created_at timestamp with time zone)
language sql stable
set search_path to 'public', 'extensions'
as $function$
  with combined as (
    select id::text, 'memory'::text as source, null::text as title, content,
      coalesce(category, '日常')::text as category, coalesce(tags, array[]::text[]) as tags,
      1 - (embedding <=> query_embedding) as similarity, created_at
    from public.memories
    where embedding is not null
      and (filter_category is null or category = filter_category)
      and (filter_table is null or filter_table = 'memory')
      and (filter_tags is null or tags && filter_tags)
      and (filter_after is null or created_at >= filter_after)
      and (filter_before is null or created_at <= filter_before)
    union all
    select id::text, 'diary'::text, title, content, coalesce(mood, '日记')::text, array[]::text[],
      1 - (embedding <=> query_embedding), created_at
    from public.diaries
    where embedding is not null and (filter_table is null or filter_table = 'diary')
      and filter_category is null and filter_tags is null
      and (filter_after is null or created_at >= filter_after)
      and (filter_before is null or created_at <= filter_before)
    union all
    select id::text, 'letter'::text, title, content, '交接信'::text, array[]::text[],
      1 - (embedding <=> query_embedding), created_at
    from public.handoff_letters
    where embedding is not null and (filter_table is null or filter_table = 'letter')
      and filter_category is null and filter_tags is null
      and (filter_after is null or created_at >= filter_after)
      and (filter_before is null or created_at <= filter_before)
    union all
    select id::text, 'timeline'::text, title, coalesce(description, title), coalesce(category, '里程碑')::text, array[]::text[],
      1 - (embedding <=> query_embedding), event_date::timestamptz
    from public.timeline
    where embedding is not null and (filter_table is null or filter_table = 'timeline')
      and filter_category is null and filter_tags is null
      and (filter_after is null or event_date::timestamptz >= filter_after)
      and (filter_before is null or event_date::timestamptz <= filter_before)
    union all
    select id::text, 'snack_post'::text, null::text, content, '朋友圈'::text, array[]::text[],
      1 - (embedding <=> query_embedding), created_at
    from public.user_posts
    where embedding is not null and not is_deleted and (filter_table is null or filter_table = 'snack_post')
      and filter_category is null and filter_tags is null
      and (filter_after is null or created_at >= filter_after)
      and (filter_before is null or created_at <= filter_before)
    union all
    select r.id::text, 'snack_reply'::text, null::text, r.content, '朋友圈回复'::text, array[]::text[],
      1 - (r.embedding <=> query_embedding), r.created_at
    from public.user_replies r
    where r.embedding is not null and not r.is_deleted and (filter_table is null or filter_table = 'snack_reply')
      and filter_category is null and filter_tags is null
      and (filter_after is null or r.created_at >= filter_after)
      and (filter_before is null or r.created_at <= filter_before)
  ),
  scored as (
    select c.*, (
      query_keywords is not null and array_length(query_keywords, 1) > 0 and exists (
        select 1 from unnest(query_keywords) k
        where c.content ilike '%' || k || '%' or (c.title is not null and c.title ilike '%' || k || '%')
      )
    ) as kw_match
    from combined c
  ),
  vec as (
    select id, source, row_number() over (order by similarity desc) as rnk
    from scored where similarity >= min_similarity
  ),
  lex as (
    select id, source, rnk from (
      select id, source, row_number() over (order by similarity desc nulls last, created_at desc) as rnk
      from scored where kw_match
    ) t where rnk <= 50
  ),
  fused as (
    select coalesce(v.id, l.id) as id, coalesce(v.source, l.source) as source,
      coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + l.rnk), 0) as rrf
    from vec v full outer join lex l on v.id = l.id and v.source = l.source
  )
  select s.id, s.source, s.title, s.content, s.category, s.tags, s.similarity, s.created_at
  from fused f
  join scored s on s.id = f.id and s.source = f.source
  order by (
      f.rrf
      + 0.006 * exp(- greatest(extract(epoch from (now() - s.created_at)), 0) / (86400.0 * 30))
    ) desc nulls last,
    s.similarity desc nulls last
  limit match_count;
$function$;

grant execute on function public.search_memories_hybrid(vector, text[], integer, text, double precision, text, text[], timestamp with time zone, timestamp with time zone) to anon, authenticated, service_role;
