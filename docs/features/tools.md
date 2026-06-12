# Claude 工具（共 17 个）

每次工具调用记录在消息 `meta.tool_calls` 里，聊天界面显示为**可折叠的工具卡片**：图标 + 工具名 + 参数预览 + 耗时，点击展开看完整参数和返回。

## 读取（Claude 主动调）

| 工具 | 说明 |
|------|------|
| `search_memory` | 跨表向量 + 关键词混合检索（RRF + 时间近度）。可选 `table` 限定来源（memory/diary/letter/timeline/snack_post/snack_reply）。**锁定的核心记忆已常驻注入、不必搜**，本工具主要搜未锁定记忆 + 日记/交接信/时间轴/朋友圈。返回值附带 `period_data`（最近 10 条经期）和 `health_data`（最近 7 天健康） |
| `search_handoff` | 专门搜交接信（长文在混合搜里容易被挤掉） |
| `list_memories` | 只读通览记忆库（id / 分类 / 内容 / 是否锁定），整理记忆时用。分页 limit/offset，`only_unlocked` 只看未锁定的 |
| `web_search` | 网页搜索（Tavily），用于时效性/事实性问题 |
| `get_health_status` | 随时查最近 7 天健康数据（睡眠 / 步数 / 心率）+ 最近 3 条经期记录。不需要等用户提健康话题，对话开始 / 用户说累 / 聊到身体时主动调 |

## 写入（用户明确要求时调）

| 工具 | 说明 |
|------|------|
| `add_memory` | 写一条结构化记忆（偏好/习惯/关系细节） |
| `write_diary` | 替你写日记（date + title + mood + content） |
| `write_handoff_letter` | 写交接信给下一个窗口 |
| `add_timeline_event` | 加重大事件到时间轴（importance 1-5） |
| `log_period` | 记录经期数据 |
| `log_health` | 记录睡眠/步数/心率/状态，按日期 upsert。用户随口提到身体状态时就顺手记，不需要她说"帮我记" |

## 记忆管理（Claude 自己整理记忆库）

| 工具 | 说明 |
|------|------|
| `manage_memory` | 对某条记忆执行：`lock` 锁定（→ 常驻注入）/ `unlock` 解锁 / `update` 修正合并 / `archive` 软删除（移进 `memories_archive`，可后台找回；锁定的不归档） |
| `garden_memories` | 向量扫描记忆库，找出相似度高的近重复对（similarity 0-1）。用户批量确认记忆后、或库里可能积累了重复时主动调；结果 ≥0.95 直接 archive，0.85-0.95 合并后 archive |
| `check_memory_health` | 查休眠记忆：返回长期未被搜索到（默认 90 天）的未锁定记忆，附 `days_since_access` 和 `access_count`。Claude 据此判断过时的归档、仍有效的保留 |

## 计算 + 调度

| 工具 | 说明 |
|------|------|
| `run_code` | 通过用户配的代码沙盒跑 Python/JS（需配 endpoint） |
| `schedule_proactive_message` | 预设一条未来主动消息（1-1440 分钟 / 最长 24h；可选 `persist` 区分"普通 ping"和"叫起床这种不可取消提醒"）。仅 APK |
| `get_device_state` | 查手机电量 / 充电 / 今日总屏幕时长 / Top 5 app 时长。不需要等用户提手机，对话开始 / 聊了 30 分钟 / 出门前主动查。APK 限定；屏幕时间需在系统设置开「使用情况访问权限」 |
