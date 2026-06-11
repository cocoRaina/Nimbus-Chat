-- Lockable memories: a locked memory is user-pinned and must never be
-- auto-superseded / auto-deleted by conflict resolution (see memory-extract).
alter table public.memories add column if not exists locked boolean not null default false;
create index if not exists memories_locked_idx on public.memories (locked) where locked = true;
