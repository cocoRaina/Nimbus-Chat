# 记忆系统 + 自动记忆提取（Claude 的"灵魂"）

## 记忆系统

4 张专用表 + 朋友圈作为长期记忆：
- `memories` — 偏好/习惯/关系细节，向量检索
- `diaries` — 日记，向量检索
- `handoff_letters` — 交接信（上一个窗口的 Claude 写给下一个窗口）
- `timeline` — 重大里程碑事件
- `user_posts` / `user_replies` — 朋友圈帖子和回复也进入语义搜索

附带结构化数据自动一起返回：
- `period_tracking` — 经期记录（最近 10 条）
- `health_data` — 健康指标（步数 / 睡眠小时 / 平均心率 / 静息心率 / 血氧均值，按日期 upsert，最近 7 天给 Claude）

实现：Supabase Edge Function `search_memory` 嵌入查询（BGE-M3 via SiliconFlow）→ `search_memories` RPC 跨表 UNION 向量搜（支持 `filter_table` 参数限定来源）→ 加上结构化数据一起返回。

## 自动记忆提取（参考 Hamster-Nest）

从聊天对话中自动提取长期记忆，无需手动录入。

**自动提取**（轮次触发，参考串串老师 Hamster-Nest 实现）：
- 每 **12 轮用户发言**自动触发一次（按对话分开计数）
- **10 分钟冷却**，不会频繁触发
- 待确认记忆 **≥ 50 条**时暂停，等用户处理后恢复
- 取当前对话最近 **24 条消息**送给 LLM 分析

**手动提取**（记忆库 → 立即提取）：
- 优先用当前打开的对话消息
- 没打开过聊天页时，fallback 从 DB 拉最近 24 条（串串老师没有此 fallback）

**确认流程**：
```
提取 → memory_entries 表（status=pending）
     → 记忆库「待确认」黄色卡片
     → 逐条「确认」/ 「忽略」/ 「全部确认」
     → 确认后写入 memories 表（category=自动提取）→ 生成 embedding → AI 可检索
     → 「忽略」直接 DELETE FROM memory_entries（硬删除,无回收站）
       —— 自动提取的候选可能含敏感细节,「忽略」语义就是"我不要"
       —— 早期版本是软删除(is_deleted=true),会积累大量不可见行
       —— 注:DELETE 需要 memory_entries 上有 DELETE 的 RLS 策略,否则忽略静默失败
```

**设置**（设置页 → ✨ 自动记忆提取）：
- 总开关（默认开启）
- 提取提供商（OR / 中转站，可以和聊天分开走 —— 比如聊天走中转，提取走 OR）
- 提取模型（从已启用模型中选，推荐便宜的小模型如 Haiku）

**来源标记**：
- 记忆/时间轴列表项右侧显示 ✨ 标记区分自动提取 vs 手动录入
- 来源筛选 chips：全部 / 手动 / ✨自动
