# 记忆系统 + 自动记忆提取（Claude 的"灵魂"）

## 分层地图（先看这个，每层各司其职、不重叠）

| 层 | 存什么 | 怎么进入对话 | 冗余防护 |
|---|---|---|---|
| **短期** | 当前对话 | 最近消息原文 + 超量后 LLM 分层压缩摘要 | — |
| **常驻** | 🔒 锁定记忆（核心事实） | 拼进 system prompt 缓存前缀，每轮都在 | 检索层排除它（见下） |
| **被动召回** | 未锁定记忆/日记/交接信/时间轴/朋友圈 | 每轮自动召回 top 3 → `[相关记忆]` 行 | `exclude_locked` + `lean` + 会话级去重 |
| **主动深挖** | 同上全量 | AI 调 `search_memory`（带过滤器，含锁定） | 工具描述提醒"先看 [相关记忆]" |
| **逐字原文** | `messages` 表聊天原件 | AI 调 `search_chat_history`（关键词） | 排除最近 10 分钟（已在上下文里） |
| **会话摘要** | `session_digests`（每日每会话 2-4 句） | 混合检索第 7 源 `session_digest`，召回/搜索都命中 | 每会话每天唯一行，今天的不生成 |
| **身体状态** | health_data / period_tracking | 每条消息 `[TA 今日状态]`（30min 缓存） | 自动召回 `lean` 不再重复带 |
| **入库** | 提取管线 → pending → 确认 | 每 12 轮自动提取 + 手动 | 0.85 Jaccard 跨表去重 |
| **保洁** | access_count / garden / 归档 | AI 调管理工具 | — |

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

**每次搜索命中的 `memories` 条目会 fire-and-forget 更新 `access_count + last_accessed_at`**（`bump_memory_access` RPC），用于衰减追踪。

## 每轮自动召回（2026-07-02 起）

发送每条用户消息前，前端自动拿这条消息去打同一条 `search_memory` 混合检索管线，取 top 3 未注入过的命中，拼成一行 `[相关记忆] …` 进用户消息前缀（`src/storage/memoryRecall.ts`）。要点：

- **不碰 system prompt 缓存前缀**——走消息前缀（和天气/心情旁白同款），结果冻结进 `meta.memoryRecall`，重放逐字节稳定
- **会话级去重**：同一条记忆本次 App 会话只注入一次（`injectedKeys` Set），不重复烧 token
- **静默降级**：3.5s 超时 / 报错 / 消息太短（<6 字）→ 直接不注入，绝不挡发消息
- **`exclude_locked: true`**：锁定记忆已常驻 system prompt，召回时 RPC 直接排除（迁移 `20260702120000`），不白占 3 个名额
- **`lean: true`**：Edge Function 跳过 period/health 附带查询（健康数据已每条消息注入，召回路径再带纯属浪费）
- 每轮成本：一次 BGE-M3 embedding（SiliconFlow）+ 一次 RPC；注入 ≤3 条、每条截 80 字
- 锁定记忆照旧常驻 system prompt；`search_memory` 工具照旧保留（AI 要深挖时自己调）

## 会话摘要层（2026-07-02 起）

「那天我们聊了什么」这个层次以前是空的（原文太碎、提取记忆太干）。现在：

- **`session_digests` 表**：每会话每天一行（UNIQUE 约束），content 为 2-4 句第三人称摘要 + BGE-M3 embedding
- **生成**：Edge Function `session_digest`，cron 每天北京时间 04:30 跑。扫最近 3 天（今天除外），每个「当日消息 ≥ 6 条且没有摘要行」的会话：当天对话（每条截 200 字、总长超 1 万字取头 7000 + 尾 3000）→ SiliconFlow `Qwen/Qwen2.5-14B-Instruct` 写摘要（7B 实测掉字，弃用）→ 嵌入 → 入库。摘要或嵌入失败整行不写，下次 cron 重试
- **回填**：手动 POST `{"days": N}`（1-30）可补历史
- **检索**：混合检索 RPC 第 7 个源 `session_digest`（类别显示「对话摘要」，时间用 digest_date 参与时间近度加分）；`search_memory` 的 `table` 参数可传 `session_digest` 限定只搜摘要

## 每条消息的健康注入（原"每日状态"）

`[TA 今日状态]` 从"每天第一条"改为**每条用户消息都带**：30 分钟 TTL 模块缓存（`healthSnapCache`），过期才真正打 Supabase + 触发 Health Connect 同步；**库里没数据时明确注入「暂无数据」**而不是静默消失。`fetchHealthSnapshot` 会跳过当天的空壳行、用最新有数据的一行（旧日期标注 `（YYYY-MM-DD 记录）`）。

## 核心记忆生命周期：锁定 → 常驻 → 自管理 → 归档

记忆库会越攒越杂（旧的 / 导入的 / 没用的），所以**不是全部喂给 AI**，而是分层：

- **🔒 锁定 = 常驻注入**：在记忆库给一条记忆加锁，它就被拼进 system prompt 的**缓存前缀**（`buildMemorySystemSection`，按 id 排序保证逐字节稳定 → 进 Anthropic 缓存；只在锁/解锁/改时下一条冷写一次）。**只有锁定的常驻**，AI 每次都"知道"；未锁定的不注入，留作可搜索归档。
- **Claude 自管理**：四个工具让 AI 按需整理（见 [tools.md](tools.md)）——`manage_memory`（lock / unlock / update / archive）+ `list_memories`（只读通览）+ `garden_memories`（扫近重复对）+ `check_memory_health`（查休眠记忆）。
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

## 去重：提取时跨两张表检查

`memory-extract` 在插入前会同时比对：
1. `memory_entries`（pending/confirmed 流水线）— 防止自动提取重复进队列
2. `memories` 表（已确认的手动/自动记忆）— 防止"手动加过的"被重复提取

相似度阈值 **0.85 Jaccard**（CJK 用 2-char bigram，Latin 用词级 token）：
- 与 `memory_entries` 重复 → 直接跳过
- 与 `memories` 重复 → **强化原条目**（fire-and-forget `bump_memory_access`），不新建副本

## 访问追踪 + 记忆健康

`memories` 表有 `access_count`（历史被搜索到的次数）和 `last_accessed_at`（上次搜索命中时间戳）：

- **每次 `search_memory` 命中** → fire-and-forget `bump_memory_access(ids)`
- **提取发现重复** → 也触发 `bump_memory_access`（强化而非新建）
- **`check_memory_health` 工具** → 调用 `get_stale_memories(days_inactive, min_days_old, max_count)` RPC，返回长期未被召回的未锁定记忆。Claude 据此决定归档（过时）或保留（仍有效）。锁定的记忆永远不出现在休眠列表里。

## 每日状态注入

每天第一条消息，在用户消息内容前自动注入一行 `[TA 今日状态]`，包含：
- 最近一次 `health_data`（昨晚睡眠 / 步数，APK 先 force 同步 Health Connect 再读）
- `period_tracking` 最新一条（进行中或上次结束日期）
- 当前电量 + 充电状态（APK only，`🔋32% 充电中`）

Claude 看到后可自然关心"昨晚睡得不太好"等，无需主动调工具。数据为空时不注入，不影响对话。亦可随时调 `get_health_status` 工具获取最新数据。
