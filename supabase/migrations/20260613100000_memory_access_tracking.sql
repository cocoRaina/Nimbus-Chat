-- Add access tracking to memories for decay-based health management.
-- access_count: incremented each time search_memory returns this memory.
-- last_accessed_at: timestamp of last retrieval (NULL = never searched).

alter table public.memories
  add column if not exists access_count integer not null default 0,
  add column if not exists last_accessed_at timestamptz;

-- Index for stale-memory queries (only unlocked rows need decay tracking).
create index if not exists idx_memories_last_accessed
  on public.memories (last_accessed_at nulls first)
  where locked = false;

-- ── bump_memory_access ────────────────────────────────────────────────────────
-- Called fire-and-forget by the search_memory edge function after each search.
-- Uses security definer so the edge function's anon key can still write.
create or replace function public.bump_memory_access(ids bigint[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.memories
  set
    access_count    = access_count + 1,
    last_accessed_at = now()
  where id = any(ids);
$$;

grant execute on function public.bump_memory_access(bigint[]) to anon, authenticated, service_role;

-- ── get_stale_memories ────────────────────────────────────────────────────────
-- Returns unlocked memories that haven't been referenced in a long time.
-- Claude calls this via check_memory_health tool to decide what to archive.
create or replace function public.get_stale_memories(
  days_inactive integer default 90,
  min_days_old  integer default 30,
  max_count     integer default 20
)
returns table(
  id               bigint,
  content          text,
  category         text,
  access_count     integer,
  last_accessed_at timestamptz,
  created_at       timestamptz,
  days_since_access integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id,
    m.content,
    m.category,
    m.access_count,
    m.last_accessed_at,
    m.created_at,
    extract(day from now() - coalesce(m.last_accessed_at, m.created_at))::integer as days_since_access
  from public.memories m
  where
    m.locked = false
    and m.created_at < now() - (min_days_old || ' days')::interval
    and coalesce(m.last_accessed_at, m.created_at) < now() - (days_inactive || ' days')::interval
  order by coalesce(m.last_accessed_at, m.created_at) asc
  limit max_count;
$$;

grant execute on function public.get_stale_memories(integer, integer, integer) to anon, authenticated, service_role;
