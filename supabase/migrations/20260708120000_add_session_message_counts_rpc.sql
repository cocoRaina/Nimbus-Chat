-- 抽屉会话列表的「N 条消息」之前只数内存里已加载的消息（fetchRemoteMessages
-- 的最近 300 条窗口），归档老会话不在窗口内就显示 0 条（吓人，误以为丢数据）。
-- 这个 RPC 直接在云端按 session 聚合真实条数，避免把全部消息拉到前端。
-- security invoker + auth.uid() 过滤，尊重单租户 RLS。
create or replace function public.session_message_counts()
returns table(session_id uuid, count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select session_id, count(*)
  from public.messages
  where user_id = auth.uid()
  group by session_id
$$;

grant execute on function public.session_message_counts() to authenticated;
revoke execute on function public.session_message_counts() from anon;
