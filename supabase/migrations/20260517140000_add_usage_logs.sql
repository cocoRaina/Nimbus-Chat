create table if not exists public.usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  source text not null default 'chat',
  created_at timestamptz not null default now()
);

create index if not exists usage_logs_user_id_created_at_idx
  on public.usage_logs (user_id, created_at desc);

create index if not exists usage_logs_user_id_model_idx
  on public.usage_logs (user_id, model);

alter table public.usage_logs enable row level security;

drop policy if exists "usage_logs_select_own" on public.usage_logs;
create policy "usage_logs_select_own"
  on public.usage_logs
  for select
  using (auth.uid() = user_id);

drop policy if exists "usage_logs_insert_own" on public.usage_logs;
create policy "usage_logs_insert_own"
  on public.usage_logs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "usage_logs_delete_own" on public.usage_logs;
create policy "usage_logs_delete_own"
  on public.usage_logs
  for delete
  using (auth.uid() = user_id);
