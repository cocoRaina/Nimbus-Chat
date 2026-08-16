-- 自主唤醒：可配置「走哪个站」+「每天最多醒几次」。
--
-- 背景：autonomous_wake 是 cron 触发、没有客户端在场的后台函数，历来只能退回
-- 服务端唯一的 OPENROUTER_API_KEY 去打 OpenRouter——即便聊天早已走中转（treegpt）。
-- 中转的 base_url/key 只在客户端 localStorage，服务器看不到。现在把「走哪个站」做成
-- 状态字段，服务端按它选：'relay' 时用 Supabase 密钥 RELAY_BASE_URL / RELAY_API_KEY
-- 打中转的 OpenAI 兼容 /chat/completions，密钥缺失或调用失败则回退 OpenRouter。
--
-- max_wakes_per_day：把原来写死的 MAX_WAKES_PER_DAY=6 挪成可调字段，设置页能改。

alter table public.autonomous_state
  add column if not exists wake_provider text not null default 'openrouter',
  add column if not exists max_wakes_per_day integer not null default 6;

-- 只允许两个取值，防止设置页/SQL 写脏。
alter table public.autonomous_state
  drop constraint if exists autonomous_state_wake_provider_check;
alter table public.autonomous_state
  add constraint autonomous_state_wake_provider_check
  check (wake_provider in ('openrouter', 'relay'));

-- 合理区间：1~12 次/天（和函数里的兜底一致）。
alter table public.autonomous_state
  drop constraint if exists autonomous_state_max_wakes_check;
alter table public.autonomous_state
  add constraint autonomous_state_max_wakes_check
  check (max_wakes_per_day between 1 and 12);
