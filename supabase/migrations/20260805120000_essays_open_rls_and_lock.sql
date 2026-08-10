-- essays 之前 RLS 开着却无策略 = 全拒，App(authenticated) 读写不到那 21 篇孤儿随笔。
-- 补单租户开放策略（照 period_tracking 的 authenticated ALL USING(true)）。
alter table public.essays enable row level security;
drop policy if exists essays_authenticated_all on public.essays;
create policy essays_authenticated_all on public.essays
  for all to authenticated using (true) with check (true);

-- 随笔本的四位密码：沈暮自己设/改（set_essay_lock 工具），随笔页据此上锁。
-- 单租户，挂在 user_settings 单行上即可。空 = 未上锁。
alter table public.user_settings add column if not exists essay_lock_code text;
