-- 沈暮的「心情」：自主唤醒时它自己写的一句话，跟活动摘要 last_note 分开。
-- 首页「沈暮心情」卡读 mood；mood_at 记录写于何时。
alter table public.autonomous_state
  add column if not exists mood text,
  add column if not exists mood_at timestamptz;
