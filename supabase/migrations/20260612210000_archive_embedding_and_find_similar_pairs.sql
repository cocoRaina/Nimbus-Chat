-- 1. Preserve embedding when archiving a memory (so it can be semantically
--    searched if ever restored; also keeps the data intact for potential
--    future archive-search features).
alter table public.memories_archive add column if not exists embedding vector(1024);

-- 2. Update archive_memory to copy the embedding alongside other fields.
create or replace function public.archive_memory(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare moved int;
begin
  insert into public.memories_archive
    (orig_id, category, content, tags, source, embedding, created_at, updated_at)
  select id, category, content, tags, source, embedding, created_at, updated_at
  from public.memories where id = p_id and locked = false;
  get diagnostics moved = row_count;
  if moved > 0 then
    delete from public.memories where id = p_id and locked = false;
  end if;
  return moved > 0;
end; $$;

-- 3. Update restore_memory to carry embedding back on restore.
create or replace function public.restore_memory(p_archive_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare moved int;
begin
  insert into public.memories (category, content, tags, source, embedding)
  select coalesce(category, '日常'), content, tags, coalesce(source, 'manual'), embedding
  from public.memories_archive where archive_id = p_archive_id;
  get diagnostics moved = row_count;
  if moved > 0 then
    delete from public.memories_archive where archive_id = p_archive_id;
  end if;
  return moved > 0;
end; $$;

-- 4. find_similar_memory_pairs: returns pairs of memories whose embeddings
--    exceed similarity_threshold. Used by the AI garden_memories tool to
--    identify duplicates / near-duplicates for merging or archiving.
create or replace function public.find_similar_memory_pairs(
  similarity_threshold double precision default 0.85,
  max_pairs integer default 15
)
returns table(
  id_a bigint, id_b bigint,
  content_a text, content_b text,
  category_a text, category_b text,
  similarity double precision
)
language sql stable security definer
set search_path to 'public', 'extensions'
as $$
  select
    a.id        as id_a,
    b.id        as id_b,
    a.content   as content_a,
    b.content   as content_b,
    coalesce(a.category, '日常') as category_a,
    coalesce(b.category, '日常') as category_b,
    1 - (a.embedding <=> b.embedding) as similarity
  from public.memories a
  join public.memories b on a.id < b.id
  where a.embedding is not null
    and b.embedding is not null
    and 1 - (a.embedding <=> b.embedding) >= similarity_threshold
  order by similarity desc
  limit max_pairs;
$$;

grant execute on function public.find_similar_memory_pairs(double precision, integer)
  to anon, authenticated, service_role;
