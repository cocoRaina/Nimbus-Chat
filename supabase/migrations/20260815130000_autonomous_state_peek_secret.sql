-- 后台轮询(background-runner)用的查询密钥：后台任务没登录态，用它调 proactive_peek
-- 自校验。App 生成并写入这一列（autonomous_state 单行 id=1）。
alter table public.autonomous_state add column if not exists peek_secret text;
