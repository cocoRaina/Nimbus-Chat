# Anthropic Prompt Cache 保活：从踩坑到最终方案

> 适用场景：自托管 AI 应用，使用 Anthropic Claude（或兼容中转），prompt 含大量固定内容（system prompt + 历史记忆），走原生 `/v1/messages` 接口。

## 背景：prompt cache 有多值钱

Anthropic 的 prompt caching 可以把重复的输入 token 费用降到 **0.1×**（读缓存价格），对于 system prompt 几万 token 的应用非常显著。一次 66K token 的冷写约 $0.37（人民币 ¥1.32），而命中缓存只需 ¥0.07——相差 **19 倍**。

问题在于：**缓存 TTL 只有 1 小时**（付费启用 extended 后，最长也是 1h）。用户稍微停一会儿，缓存就死了，下次聊天又是一次冷写。

---

## 方案一：客户端 Timer（不够）

最简单的做法：用 JavaScript 的 `setInterval` 每 55 分钟发一条 ping，续命缓存。

**问题**：手机 App 一旦被系统杀后台，timer 就死了。用户锁屏、切 App、手机省电策略……这些情况下客户端完全不可靠。

---

## 方案二：服务端 pg_cron（核心思路）

用 Supabase 的 `pg_cron` 插件，每 5 分钟触发一个 Edge Function，由服务端来发 ping。

基本流程：
1. 用户每次成功聊天，将当次请求体（含 system prompt、历史消息、路由信息）存进数据库的 `cache_keepalive_state` 表
2. cron 每 5 分钟扫表，对"最近有活动"的用户发一条 ping 到中转/Anthropic
3. ping 读到缓存 → ¥0.07 热读；死了就重建

这样无论 App 在不在后台，服务端都稳定续命。

---

## 踩坑一：ping 刷的是另一份缓存！（最严重的 bug）

早期的 ping 实现是：拿存好的请求体，删掉 `thinking` 字段，`max_tokens` 改成 1，`stream: false` 发出去。

现象：ping 显示"缓存命中 65909 tokens"，看起来正常。但用户的真实聊天**还是每次冷写**。

**根因**：Anthropic 把 `thinking` 字段（含 `budget_tokens` 的值）作为缓存键的一部分。

- 带 `thinking: {type: 'enabled', budget_tokens: 2000}` 的请求 → 缓存在条目 A（65931 tokens）
- 删掉 `thinking` 的请求 → 缓存在条目 B（65909 tokens）

**两条缓存链完全独立，互不相通。** ping 一直在续自己那份私有副本，真实聊天的缓存从没被续过。

更坑的是早期日志显示"读了 65909"——那其实是一条 ping 读了前一条 ping 留下的缓存，是**假命中**（false positive）。

**修法**：ping 必须原样保留 `thinking` 字段，连 `budget_tokens` 的值都不能改（1024 和 2000 也是两条不同的链）。

```typescript
// ❌ 错误：删掉 thinking
delete pingBody.thinking
pingBody.max_tokens = 1

// ✅ 正确：保留 thinking，max_tokens 设成 budget+1
// extended thinking 要求 max_tokens > budget_tokens
// budget 是上限不是目标，模型实际只吐 ~20 个 token
const thinking = pingBody.thinking as { budget_tokens?: number } | undefined
if (thinking && typeof thinking.budget_tokens === 'number') {
  pingBody.max_tokens = thinking.budget_tokens + 1
} else if (!thinking) {
  pingBody.max_tokens = 1
}
```

补充验证：`stream` 字段**不影响**缓存键（非流式 ping 能读流式聊天写下的缓存）。可以放心用 `stream: false` 省去 SSE 解析。

---

## 踩坑二：冷却判断只看 last_ping_at，不够准

冷却逻辑最初是：

```typescript
if (last_ping_at && new Date(last_ping_at) > cooldownCutoff) {
  skip  // 50min 内 ping 过了，跳过
}
```

**问题**：缓存被"碰"不只有 ping 一种方式，用户的真实聊天同样让缓存热起来。如果用户正在猛聊，每 50min 还是会打一发冗余的 ping（聊天本身已经保温了）。另外，早晨第一条聊天后 `last_ping_at` 是 null，下一个 5min cron 就会立刻打一发（缓存刚被聊天热上，这发纯属浪费）。

**修法**：冷却应基于"最后一次碰缓存"，即 `max(last_ping_at, last_chat_at)`：

```typescript
const lastPingMs = last_ping_at ? new Date(last_ping_at).getTime() : 0
const lastTouchMs = Math.max(lastPingMs, new Date(last_chat_at).getTime())
if (lastTouchMs > cooldownCutoff) {
  skip  // 最近 50min 内聊天或 ping 过了，缓存还热着
}
```

效果：活跃会话中 ping 自动让路，只在真正的 ≥50min 空档时补位。保温强度不变（50min < 60min TTL），但省掉了所有冗余 ping。

---

## 踩坑三：活跃窗口设太大，早晨 8 点冷写

设了一个"X 小时内有聊天的用户才 ping"的活跃窗口。当窗口设成 24h，早晨 8 点的 cron 看到"昨晚 10 点聊过，还在 24h 窗口里"，于是发了一条 ping。

但缓存在昨晚 11 点就死了，这条 ping → **冷写 ¥1.32**，发生在用户还没醒的时候。

**分析**：安静时段（凌晨 0 点到早 8 点，8 小时）比缓存 TTL（1 小时）长很多，缓存在凌晨 1 点就死了。8 点第一个 cron 打过去永远是冷写，白花钱。

**修法**：加 today-gate——只 ping 今天清醒时段（08:00 后）有过真实聊天的用户。昨晚的聊天不算。

```typescript
// 北京 08:00 = UTC 00:00，所以"今天清醒起点"就是今天的 UTC 午夜
const todayWakingStartMs = new Date(nowBeijing).setUTCHours(0, 0, 0, 0)
const activeSince = new Date(
  Math.max(Date.now() - ACTIVE_WINDOW_MS, todayWakingStartMs),
).toISOString()
// 只查 last_chat_at >= activeSince 的行
```

配合 `ACTIVE_WINDOW_MS = 16h`（08:00 + 16h = 00:00，正好覆盖整个清醒时段）：

- 早晨第一条消息发出 → 开始 ping，全天续到午夜
- 中途聊天 → last_chat_at 更新 → 窗口自动顺延
- 午夜安静时段截断 → 缓存在凌晨 1 点死
- 第二天 8 点：昨晚的 last_chat_at 不满足 today-gate → **不发冷写 ping**，等用户发第一条消息

---

## 安静时段的额外价值

安静时段（00:00–08:00）除了技术上避免投机冷写，还有一个副作用：**深夜聊天没有缓存保温，每条都是冷写，¥1.32 一发，自带「摩擦」劝退熬夜**。

---

## 最终设计一览

```
每天的缓存成本流：

08:00 用户第一条消息
  ↓ 缓存已过期（夜里死的）→ 冷写 ¥1.32（不可避免）
  ↓ last_chat_at 更新 → cron 开始 ping

  ~50min 空档 → ping ¥0.07（热读）
  用户又聊几句 → last_chat_at 更新 → 冷却重置，聊天期间 ping 让路
  ~50min 空档 → ping ¥0.07
  ...一直到午夜

00:00 安静时段，停止 ping
  缓存在 ~01:00 死掉
  → 第二天重复

每天固定成本：¥1.32（早晨冷写）+ gap 数 × ¥0.07（热读 ping）
重度用户每天约 ¥2–3，比不保活（每个 >1h 间隔都冷写）省约一半
```

### 关键参数

| 参数 | 值 | 原因 |
|------|-----|------|
| cron 频率 | 每 5min | 够密，调度漂移最多延 5min |
| PING_COOLDOWN_MS | 50min | 留 10min 缓冲，确保在 60min TTL 前打到 |
| ACTIVE_WINDOW_MS | 16h | 覆盖整个清醒时段（08:00–24:00） |
| 安静时段 | 00:00–08:00 北京 | 防投机冷写 + 防熬夜 |
| 冷却基准 | max(last_ping_at, last_chat_at) | 聊天期间 ping 自动让路 |

### ping 请求体要点

- `stream: false`（cache-key 无关，省 SSE 解析）
- 保留 `thinking`（含 `budget_tokens` 原值，值不同 = 不同缓存链）
- `max_tokens = budget_tokens + 1`（extended thinking 的约束；budget 是上限，实际只吐 ~20 token）
- 保留 `tools`、`system`、`messages`、`metadata.user_id`、`model`（都是缓存前缀键的一部分）
- 删掉 `tool_choice`、`usage` 等 OpenAI 兼容字段（Anthropic 原生接口不认）

---

## 效果验证方式

打开中转的 console，看 ping 那条的 `缓存读` 字段：
- `缓存读 65931`（和你真实聊天一样的数字）→ ✅ 命中同一条缓存链
- `缓存写 65909`（不同数字，且是"写"）→ ❌ 打到了不同的缓存链，检查 thinking 字段

---

*本文基于 2026-06 在金瓜瓜中转（Anthropic 兼容格式）上的实测，关键结论已通过受控 A/B 实验验证。*
