# 真·主动消息（APK 限定）

Claude 有一个工具 `schedule_proactive_message`，可以在聊天中**自主判断**是否要预设一条未来的主动消息。

## 工作方式

1. 聊天过程中，Claude 根据对话气氛判断用户是否要离开
2. 如果判断合适，Claude 主动调用 `schedule_proactive_message(text, delay_minutes, persist?)` 工具
3. 工具处理器调度一条**本地通知** + 写入 `proactive_queue` 表（FCM 备用，默认不会真发出去）
4. delay_minutes 由 Claude 自己决定（1-1440 分钟，最长 24 小时，覆盖到次日叫起床场景），根据场景灵活选择
5. 你点通知打开 app → 自动把预设的话作为正式 assistant 消息写进 DB
6. 你在通知触发前回 app 发了新消息 → 旧 transient 通知取消 + 旧 pending 清空 + 旧 queue 行删除
7. **Claude 在这条新回复时会收到一段系统提示**："你之前预约的『XX』（原定 HH:MM）已被自动取消，自行判断要不要重新预约"。它可能再次调用工具续一条新的，也可能判断对话已经转向而不续

## Transient vs Persist 两类通知

- **Transient（默认）**：「如果你不回来我才需要找你」型。你一发新消息就被自动取消。Notification ID = 1001，storage = `nimbus_pending_proactive_v1`
- **Persist（`persist: true`）**：用户明确预约的不可取消提醒（叫起床、定时喝水、明天某时待办）。即使你回来聊天也保留，到点必响。Notification ID = 1002，storage = `nimbus_persist_proactive_v1`
- Claude 只在你**明确说**"提醒我/叫醒我/到点告诉我"时才设 `persist: true`，不会主动加

## Claude 不会每轮都调

工具描述里约束了：
- 用户要去做事/休息/离开、需要次日提醒/起床 → 适合调用
- 深度情绪交流当下 → 不调用
- 用户说"别打扰" → 不调用
- （以前有 23:00-07:00 quiet hours，已取消 — 让 Claude 凭对话上下文判断更自然，也方便它当起床闹钟）

## FCM 服务端推送（默认完全关闭）

- 代码保留：`proactive_queue` 表 + `send_proactive_push` Edge Function 仍在仓库里
- pg_cron 任务 `send-proactive-pushes`（id=1）已 `active=false`，不再每分钟空跑
- 启用方法：
  1. 取消 `src/main.tsx` 中 PushNotifications 注册的注释
  2. 添加 `GOOGLE_SERVICES_JSON` GitHub Secret
  3. `SELECT cron.alter_job(1, active := true);` 重启 cron
