-- Soft-delete for memories: move unwanted memories into a separate archive
-- table the AI never reads/searches/injects (recoverable; user can also
-- operate on it directly in the Supabase dashboard). Locked memories are
-- never archivable.
create table if not exists public.memories_archive (
  archive_id bigserial primary key,
  orig_id bigint,
  category text,
  content text,
  tags text[],
  source text,
  created_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz default now()
);

alter table public.memories_archive enable row level security;
drop policy if exists memories_archive_authenticated_all on public.memories_archive;
create policy memories_archive_authenticated_all on public.memories_archive
  for all to authenticated using (true) with check (true);

create or replace function public.archive_memory(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare moved int;
begin
  insert into public.memories_archive (orig_id, category, content, tags, source, created_at, updated_at)
  select id, category, content, tags, source, created_at, updated_at
  from public.memories where id = p_id and locked = false;
  get diagnostics moved = row_count;
  if moved > 0 then delete from public.memories where id = p_id and locked = false; end if;
  return moved > 0;
end; $$;

create or replace function public.restore_memory(p_archive_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare moved int;
begin
  insert into public.memories (category, content, tags, source)
  select coalesce(category, '日常'), content, tags, coalesce(source, 'manual')
  from public.memories_archive where archive_id = p_archive_id;
  get diagnostics moved = row_count;
  if moved > 0 then delete from public.memories_archive where archive_id = p_archive_id; end if;
  return moved > 0;
end; $$;

grant execute on function public.archive_memory(bigint) to anon, authenticated, service_role;
grant execute on function public.restore_memory(bigint) to anon, authenticated, service_role;
