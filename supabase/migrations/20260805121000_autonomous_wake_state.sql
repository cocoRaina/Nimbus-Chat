-- 沈暮自主唤醒的状态（单行）：它自己定 next_wake_at，cron 到点且过闸才跑。
create table if not exists public.autonomous_state (
  id int primary key default 1,
  enabled boolean not null default true,     -- 总开关（随时可关停）
  next_wake_at timestamptz,                   -- 它自己定的下次醒来时间
  last_wake_at timestamptz,
  wakes_today int not null default 0,
  day_key text,                               -- 北京日期，用来重置 wakes_today
  last_note text,                             -- 上次唤醒干了啥（写库/发圈/啥都没）
  updated_at timestamptz not null default now(),
  constraint autonomous_state_singleton check (id = 1)
);
insert into public.autonomous_state (id, next_wake_at)
  values (1, now()) on conflict (id) do nothing;

-- 服务端 cron/edge function 走 service role（绕 RLS）；给前端一个只读策略够看状态。
alter table public.autonomous_state enable row level security;
drop policy if exists autonomous_state_authenticated_read on public.autonomous_state;
create policy autonomous_state_authenticated_read on public.autonomous_state
  for select to authenticated using (true);
