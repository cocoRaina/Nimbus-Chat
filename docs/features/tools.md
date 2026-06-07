# Claude 工具（共 12 个）

每次工具调用会被记录在消息的 `meta.tool_calls` 里，聊天界面显示为**可折叠的工具卡片**（类似 claude.ai）：图标 + 工具名 + 参数预览 + 耗时，点击展开看完整参数和返回结果。

## 读取（Claude 主动调）

| 工具 | 说明 |
|------|------|
| `search_memory` | 跨 6 张表向量语义搜索。可选 `table` 参数限定只搜某个来源（memory/diary/letter/timeline/snack_post/snack_reply） |
| `search_handoff` | 专门搜交接信（长文在混合搜索里容易被挤出去） |
| `web_search` | 网页搜索（Tavily API），用于时效性/事实性问题 |

## 写入（用户明确要求时调）

| 工具 | 说明 |
|------|------|
| `add_memory` | 写一条结构化记忆（偏好/习惯/关系细节） |
| `write_diary` | 替你写日记（date + title + mood + content） |
| `write_handoff_letter` | 写交接信给下一个窗口 |
| `add_timeline_event` | 加重大事件到时间轴（importance 1-5） |
| `log_period` | 记录经期数据 |
| `log_health` | 记录睡眠/步数/心率/状态，按日期 upsert |

## 计算 + 调度

| 工具 | 说明 |
|------|------|
| `run_code` | 通过用户配的代码沙盒跑 Python/JS（需配 endpoint） |
| `schedule_proactive_message` | 预设一条未来主动消息（1-1440 分钟 / 最长 24h；带可选 `persist` 区分"普通 ping"和"叫起床这种不可取消提醒"）。仅 APK，web 不可用 |
| `get_device_state` | 查手机电量 / 是否充电 / 今日总屏幕时长 / Top 5 app 时长。`@capacitor/device` + 自定义 UsageStats plugin。APK 限定；屏幕时间需用户在系统设置开「使用情况访问权限」。屏幕时间实现见 [screen-time.md](screen-time.md) |
