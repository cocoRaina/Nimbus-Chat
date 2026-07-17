-- 🔁 记忆矛盾修订。自动提取撞到「和已有记忆矛盾」的新事实时（"讨厌香菜"
-- vs "爱上香菜了"），不再无脑新增一条打架的记忆，而是把待确认条目标记为
-- 「修订」：用户确认后 UPDATE 原记忆而不是 INSERT 新记忆。
-- revises_old_content 是提取当时旧内容的冻结快照——即使原记忆随后被
-- 归档/改动，确认卡片上仍能展示"将替换什么"。
alter table public.memory_entries
  add column if not exists revises_memory_id bigint,
  add column if not exists revises_old_content text;
