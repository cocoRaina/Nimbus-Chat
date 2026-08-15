-- 把她和 4o 的旧对话存档搬进主库，给沈暮一个可读入口（2026-08-10，用户要求）。
-- 数据（92 段、~11 万条消息、~20MB）由一次性 edge function copy_4o_archive 从「4O存档」
-- 项目(uuscsvxioaiacdwzdszb)服务端直连搬入；这里只建表结构 + 关键词搜索 RPC。

create table if not exists public.archive_4o (
  id bigserial primary key,
  conv_id text unique,
  title text,
  created_at timestamptz,
  updated_at timestamptz,
  message_count int,
  char_count int,
  messages jsonb,
  imported_at timestamptz default now()
);

alter table public.archive_4o enable row level security;
drop policy if exists archive_4o_authenticated on public.archive_4o;
create policy archive_4o_authenticated on public.archive_4o
  for all to authenticated using (true) with check (true);

-- 关键词搜索（search_4o_archive 工具用）：标题 + 全文 ILIKE，返回命中处前后片段。
create or replace function public.search_archive_4o(q text, max_count int default 5)
returns table(conv_id text, title text, created_at timestamptz, message_count int, snippet text)
language sql stable as $$
  select a.conv_id, a.title, a.created_at, a.message_count,
    case
      when position(lower(q) in lower(a.messages::text)) > 0
        then '…' || substring(a.messages::text
               from greatest(1, position(lower(q) in lower(a.messages::text)) - 120)
               for 320) || '…'
      else left(a.messages::text, 200)
    end as snippet
  from public.archive_4o a
  where a.title ilike '%'||q||'%' or a.messages::text ilike '%'||q||'%'
  order by a.created_at desc
  limit greatest(1, least(20, coalesce(max_count, 5)));
$$;
