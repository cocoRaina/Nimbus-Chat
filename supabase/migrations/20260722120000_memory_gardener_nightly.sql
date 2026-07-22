-- 🌿 记忆园丁（2026-07-22）：每晚 05:10 北京时间自动打理记忆库，
-- 回应「记忆库岂不是越来越长」——自动转正只管进，这里管出。三件事：
--   1) 转正滞留 pending（weekly_consolidate 的蒸馏产出等）：>24h 未处理的
--      待确认条目自动落地；修订类 UPDATE 原记忆（embedding 置空重嵌）。
--   2) 合并重复：embedding 余弦相似度 ≥0.93 的未锁定对，保留 access_count
--      高者（平局取新），另一条进 memories_archive（可恢复）。每晚 ≤10 对。
--   3) 休眠归档：只动自动提取（source='auto'）、未锁定、120 天没被检索
--      命中（access_count≤1）的旧条目。手动添加的记忆永不自动碰。每晚 ≤10。
-- 安全阀：locked 永不动（archive_memory 自带拒绝）；全部进 archive 可恢复；
-- 每晚限额防一夜大屠杀。运行记录进 memory_gardener_log，Diagnostics 可查。

create table if not exists public.memory_gardener_log (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  promoted int not null default 0,
  merged int not null default 0,
  dormant_archived int not null default 0
);
alter table public.memory_gardener_log enable row level security;
drop policy if exists "memory_gardener_log_all" on public.memory_gardener_log;
create policy "memory_gardener_log_all" on public.memory_gardener_log
  for all using (true) with check (true);

create or replace function public.memory_gardener()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  r record;
  p record;
  keeper_id bigint;
  loser_id bigint;
  n_promoted int := 0;
  n_merged int := 0;
  n_dormant int := 0;
begin
  -- 1) 转正滞留 pending（memory-extract 已即时转正，这里兜 weekly_consolidate
  --    的蒸馏产出和历史残留）。
  for r in
    select id, content, revises_memory_id
    from memory_entries
    where status = 'pending' and is_deleted = false
      and created_at < now() - interval '24 hours'
  loop
    if r.revises_memory_id is not null then
      update memories
        set content = r.content, embedding = null, updated_at = now()
        where id = r.revises_memory_id and locked = false;
      if not found then
        insert into memories (content, category, tags, source)
        values (r.content, '自动提取', array['auto'], 'auto');
      end if;
    else
      insert into memories (content, category, tags, source)
      values (r.content, '自动提取', array['auto'], 'auto');
    end if;
    update memory_entries set status = 'confirmed', updated_at = now() where id = r.id;
    n_promoted := n_promoted + 1;
  end loop;

  -- 2) 合并重复：余弦距离 ≤0.07（相似度 ≥0.93 的稳妥带），保留被检索命中
  --    更多的那条。loser 可能已被前一对归档——archive_memory 返回 false 就跳过。
  for p in
    select a.id as id_a, b.id as id_b,
           coalesce(a.access_count, 0) as ac_a, coalesce(b.access_count, 0) as ac_b,
           a.created_at as ca, b.created_at as cb
    from memories a
    join memories b on a.id < b.id
    where a.embedding is not null and b.embedding is not null
      and a.locked = false and b.locked = false
      and (a.embedding <=> b.embedding) <= 0.07
    limit 10
  loop
    if p.ac_a > p.ac_b or (p.ac_a = p.ac_b and p.ca >= p.cb) then
      keeper_id := p.id_a; loser_id := p.id_b;
    else
      keeper_id := p.id_b; loser_id := p.id_a;
    end if;
    if archive_memory(loser_id) then
      n_merged := n_merged + 1;
    end if;
  end loop;

  -- 3) 休眠归档：只动自动提取的、四个月没动静的。
  for r in
    select id from memories
    where locked = false and source = 'auto'
      and created_at < now() - interval '120 days'
      and coalesce(last_accessed_at, created_at) < now() - interval '120 days'
      and coalesce(access_count, 0) <= 1
    limit 10
  loop
    if archive_memory(r.id) then
      n_dormant := n_dormant + 1;
    end if;
  end loop;

  if n_promoted + n_merged + n_dormant > 0 then
    insert into memory_gardener_log (promoted, merged, dormant_archived)
    values (n_promoted, n_merged, n_dormant);
  end if;
end;
$$;

-- 每晚 21:10 UTC = 北京 05:10（睡眠巩固是周一 05:00，错开十分钟）。
do $$
begin
  if exists (select 1 from cron.job where jobname = 'memory-gardener-nightly') then
    perform cron.unschedule('memory-gardener-nightly');
  end if;
  perform cron.schedule('memory-gardener-nightly', '10 21 * * *', 'select public.memory_gardener()');
end;
$$;
