-- 每日心情：你(user)和小克(ai)每天各一条，可翻历史。两人共享——都挂在同一个
-- user_id 下，RLS auth.uid()=user_id 即可让 App 读到两条(user+ai)；ai 那条由
-- autonomous_wake 用 service role 写(绕过 RLS)。每人每天一条(唯一约束+upsert)。
create table if not exists public.daily_moods (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  mood_date date not null,
  author text not null check (author in ('user','ai')),
  emoji text,
  text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, mood_date, author)
);
alter table public.daily_moods enable row level security;
create policy "own daily_moods" on public.daily_moods
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists daily_moods_date_idx on public.daily_moods (user_id, mood_date desc);
