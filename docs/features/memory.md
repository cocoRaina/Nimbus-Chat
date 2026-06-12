# 记忆系统 + 自动记忆提取（Claude 的"灵魂"）

## 记忆系统（长期记忆的几张表）

- `memories` — 偏好/习惯/关系细节，向量检索
- `diaries` — 日记，向量检索
- `handoff_letters` — 交接信（上一个窗口的 Claude 写给下一个窗口）
- `timeline` — 重大里程碑事件
- `user_posts` / `user_replies` — 朋友圈帖子和回复也进入语义搜索

附带结构化数据自动一起返回：
- `period_tracking` — 经期记录（最近 10 条）
- `health_data` — 健康指标（步数 / 睡眠 / 心率 / 静息心率 / 血氧，按日期 upsert，最近 7 天给 Claude）

**检索实现**：Edge Function `search_memory` 嵌入查询（BGE-M3 via SiliconFlow）→ `search_memories_hybrid` RPC 跨表 UNION，**向量召回 + 关键词（ILIKE）召回，RRF 融合**，再叠一个**时间近度小加分**（半衰期 30 天、权重 0.006：相关度相近时近的靠前，但不盖过明显更相关的旧项）→ 加结构化数据一起返回。`search_handoff` 单独搜交接信（长文在混合搜里容易被挤掉）。

## 核心记忆生命周期：锁定 → 常驻 → 自管理 → 归档

记忆库会越攒越杂（旧的 / 导入的 / 没用的），所以**不是全部喂给 AI**，而是分层：

- **🔒 锁定 = 常驻注入**：在记忆库给一条记忆加锁，它就被拼进 system prompt 的**缓存前缀**（`buildMemorySystemSection`，按 id 排序保证逐字节稳定 → 进 Anthropic 缓存；只在锁/解锁/改时下一条冷写一次）。**只有锁定的常驻**，AI 每次都"知道"；未锁定的不注入，留作可搜索归档。
- **Claude 自管理**：两个工具让 AI 按需整理（见 [tools.md](tools.md)）——`manage_memory`（lock / unlock / update 合并 / archive）+ `list_memories`（只读通览）。
- **软删除可找回**：archive 不真删，把记忆原子地移进 `memories_archive` 表（AI 不读/不搜/不注入）。锁定的记忆**不会被归档**。用户可在 Supabase 后台看/恢复：RPC `archive_memory(id)` / `restore_memory(archive_id)`。

## 自动记忆提取（参考 Hamster-Nest）

从聊天对话中自动提取长期记忆，无需手动录入。

**自动提取**（轮次触发）：
- 每 **12 轮用户发言**触发一次（按对话分开计数）+ **10 分钟冷却**
- 待确认记忆 **≥ 50 条**时暂停，等用户处理后恢复
- 取当前对话最近 **24 条消息**送给 LLM 分析

**手动提取**（记忆库 → 立即提取）：优先当前对话消息；没打开聊天页时 fallback 从 DB 拉最近 24 条。

**确认流程**：
```
提取 → memory_entries（status=pending）→ 记忆库「待确认」黄卡
     → 逐条 确认 / 忽略 / 全部确认
     → 确认 → 写入 memories（category=自动提取）→ 生成 embedding → 可检索
     → 忽略 → 直接 DELETE memory_entries（硬删，无回收站；候选可能含敏感细节，"忽略"=我不要）
```
> 注：忽略的 DELETE 需要 `memory_entries` 上有 DELETE 的 RLS 策略，否则静默失败（踩过）。

**设置**（设置页 → ✨ 自动记忆提取）：总开关 / 提取提供商（可和聊天分开走）/ 提取模型（推荐便宜小模型）。

**来源标记**：记忆列表右侧 ✨ 区分自动 vs 手动；来源筛选 chips：全部 / 手动 / ✨自动。锁定的记忆显示 🔒。
