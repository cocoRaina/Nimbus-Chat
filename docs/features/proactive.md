# 真·主动消息（APK 限定）

Claude 有一个工具 `schedule_proactive_message`，可以在聊天中**自主判断**是否要预设一条未来的主动消息。

## 工作方式

1. 聊天过程中，Claude 根据对话气氛判断用户是否要离开
2. 如果判断合适，Claude 主动调用 `schedule_proactive_message(text, delay_minutes, persist?)` 工具
3. 工具处理器做三件事：① 调度一条**本地通知**（到点弹横幅）② 写入 `proactive_queue` 表（服务端兜底派发）③ 存一份本地 `PendingProactive`（含 `queueId`）
4. delay_minutes 由 Claude 自己决定（1-1440 分钟，最长 24 小时，覆盖到次日叫起床场景），根据场景灵活选择
5. 到点时，消息**一定会作为正式 assistant 消息写进 `messages` 表**——不再依赖你点不点通知

## 双路派发：客户端 + 服务端（防丢防重）

消息到点后由两条路径竞争派发，谁先抢到谁写：

- **客户端路径**：你回到 app（前台事件）时，若发现 pending 已到点，调 `insertPendingProactiveRef` 写入。
- **服务端路径**：`proactive_dispatch` Edge Function 由 pg_cron **每 5 分钟**跑一次，扫 `fire_at <= now() AND sent = false` 的行，写进 `messages`。**即使你一直没开 app，到点也会写入**——这是和旧版的关键区别。

两条路靠 `UPDATE proactive_queue SET sent=true WHERE id=? AND sent=false` 原子抢占：谁的 UPDATE 命中谁负责写消息，另一边查到 `sent=true`（或 `claimed=null`）就跳过，**保证同一条只写一次**。

### 时间戳用计划时间，不是打开时间

写入的 `client_created_at` 用 `entry.fireAt`（AI 预定的发送时刻），不是你打开 app 的时刻。所以消息气泡显示的时间是「它本该发出的时间」，时间线不会错乱。

### 前台自动刷新

回到 app 时除了检查本地 pending，还会调 `fetchSessionRecentMessages` 拉当前会话最近 20 条，把**服务端在你离线期间写入的**主动消息立刻合并显示出来（按 id 去重，不会重复）。

## 你在通知触发前发了新消息

- 旧 transient 通知取消 + 本地 pending 清空 + **服务端 queue 里 `persist=false` 的未发送行删除**（persist 行保留，见下）
- **Claude 在这条新回复时会收到一段系统提示**："你之前预约的『XX』（原定 HH:MM）已被自动取消，自行判断要不要重新预约"。它可能再次调用工具续一条新的，也可能判断对话已经转向而不续
- 极端 race：你发消息的瞬间 cron 刚好在跑（5 分钟一次，窗口极窄）——概率可忽略

## Transient vs Persist 两类

- **Transient（默认）**：「如果你不回来我才需要找你」型。你一发新消息就被自动取消（本地 + 服务端 queue 行都删）。Notification ID = 1001，storage = `nimbus_pending_proactive_v1`
- **Persist（`persist: true`）**：用户明确预约的不可取消提醒（叫起床、定时喝水、明天某时待办）。即使你回来聊天也保留——本地 storage 和服务端 queue 行**都不删**，到点必响必写。Notification ID = 1002，storage = `nimbus_persist_proactive_v1`
- Claude 只在你**明确说**"提醒我/叫醒我/到点告诉我"时才设 `persist: true`，不会主动加

## Claude 不会每轮都调

工具描述里约束了：
- 用户要去做事/休息/离开、需要次日提醒/起床 → 适合调用
- 深度情绪交流当下 → 不调用
- 用户说"别打扰" → 不调用
- （以前有 23:00-07:00 quiet hours，已取消 — 让 Claude 凭对话上下文判断更自然，也方便它当起床闹钟）

## 数据库 & 服务端

- **表 `proactive_queue`**：`id / user_id / session_id / text / fire_at / persist / sent / created_at`，RLS 单用户（`auth.uid() = user_id`），部分索引 `(fire_at) WHERE sent=false` 给 cron 快查。迁移见 `supabase/migrations/20260614120000_create_proactive_queue.sql`
- **Edge Function `proactive_dispatch`**：用 service role 绕 RLS，原子抢占 + 写 `messages` + touch `sessions.updated_at`。`supabase/functions/proactive_dispatch/index.ts`
- **pg_cron `proactive-dispatch`**：`*/5 * * * *`，anon key 过网关。迁移见 `20260614130000_schedule_proactive_dispatch_cron.sql`。暂停：`SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='proactive-dispatch'), active := false);`

> 注：更早的 FCM 推送方案（`send_proactive_push` 函数 + 旧版 `proactive_queue`）已**彻底移除**。现在的 `proactive_queue` 是新建的，用途是服务端**本地消息派发**（写进 DB），不是远程推送。
