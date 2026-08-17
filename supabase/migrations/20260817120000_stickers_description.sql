-- 表情包视觉描述：让小机导入时自己看图，除了起名字还写一句「图里画了啥」。
-- search_stickers 连描述一起搜 + 返回给模型，它就既按名字、也按画面内容挑表情，
-- 不再只靠名字瞎猜。旧表情 description 为空不影响（搜索仍按 name 命中）。
alter table public.stickers
  add column if not exists description text;
