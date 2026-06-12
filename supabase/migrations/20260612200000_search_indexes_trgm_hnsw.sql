-- pg_trgm speeds up ILIKE keyword queries from O(n) full-scan to index lookup
create extension if not exists pg_trgm;

-- GIN trigram indexes on all content columns used by search_memories_hybrid
create index if not exists idx_memories_content_trgm        on public.memories        using gin(content gin_trgm_ops);
create index if not exists idx_diaries_content_trgm         on public.diaries         using gin(content gin_trgm_ops);
create index if not exists idx_handoff_letters_content_trgm on public.handoff_letters  using gin(content gin_trgm_ops);
create index if not exists idx_timeline_content_trgm        on public.timeline         using gin(coalesce(description, '') gin_trgm_ops);
create index if not exists idx_user_posts_content_trgm      on public.user_posts       using gin(content gin_trgm_ops);
create index if not exists idx_user_replies_content_trgm    on public.user_replies     using gin(content gin_trgm_ops);

-- HNSW vector indexes — better recall and no need to pre-specify list count vs ivfflat.
-- m=16 ef_construction=64 are conservative defaults well-suited for <100k rows.
create index if not exists idx_memories_embedding_hnsw        on public.memories        using hnsw(embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_diaries_embedding_hnsw         on public.diaries         using hnsw(embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_handoff_letters_embedding_hnsw on public.handoff_letters  using hnsw(embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_timeline_embedding_hnsw        on public.timeline         using hnsw(embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_user_posts_embedding_hnsw      on public.user_posts       using hnsw(embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_user_replies_embedding_hnsw    on public.user_replies     using hnsw(embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
