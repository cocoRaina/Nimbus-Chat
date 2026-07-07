# 文档地图

> Nimbus 的文档都在这。新窗口先读根目录 [CLAUDE.md](../CLAUDE.md) 速览，再按需进下面的专题。

## 通用 / 跨功能

| 文档 | 内容 |
|---|---|
| [caching.md](caching.md) | **Prompt Caching 指南(内部)**：原理、各家中转对比、怎么配、验证命中、块布局铁律、图片转文字、FAQ、附 Nimbus 成本优化实现 |
| [anthropic-api-notes.md](anthropic-api-notes.md) | **Anthropic API 踩坑笔记**：extended thinking + tool use 的 thinking block 回传、signature_delta 流事件、cache key 包含 thinking 参数、max_tokens 要求、历次冷写修复记录——**遇到 Anthropic 诡异行为先查这里** |
| [guides/prompt-caching.md](guides/prompt-caching.md) | **Prompt Caching 教程(对外·可分享)**：不依赖本项目的通用版。入门(前缀匹配/`cache_control`+`user_id`/原生协议/选中转/验证/保活) + 进阶坑(工具调用、思考链是缓存键、ping 同形、图片转文字、服务端保活)。给别人参考缓存怎么做时发这篇，别给后端凭证 |
| [guides/relay-check-and-token-audit.md](guides/relay-check-and-token-audit.md) | **中转体检 + Token 对账(对外·可分享)**：上半人话版(中转怎么骗/该查什么/何时换站)，下半给 AI 看的可执行探针食谱(真缓存测试、模型核验、响应头指纹、身份注入、usage 字段词典、对账)。脱开本项目、任何中转通用。镜像留档，正本发 ai-guides |
| [changelog.md](changelog.md) | 按日期的改动记录 + Debug 日志(踩过的坑 + 修法) |

## 按功能（`docs/features/`）

| 功能 | 文档 |
|---|---|
| 记忆系统 + 自动提取 | [features/memory.md](features/memory.md) |
| 渠道体检 + Token 对账（防中转骗）| [features/diagnostics.md](features/diagnostics.md) |
| Claude 工具（12 个） | [features/tools.md](features/tools.md) |
| 情绪系统（贪嗔痴念） | [features/mood-system.md](features/mood-system.md) |
| 真·主动消息 | 见 [features/tools.md](features/tools.md) 的 `schedule_proactive_message`（没有单独的 proactive.md） |
| 健康同步（Health Connect） | [features/health-sync.md](features/health-sync.md) |
| 屏幕使用时间（UsageStats） | [features/screen-time.md](features/screen-time.md) |
| 主页 widget 系统 | [features/widgets.md](features/widgets.md) |
| 聊天界面交互 | [features/chat-ui.md](features/chat-ui.md) |
| 语音消息（TTS·MiniMax） | [features/voice-tts.md](features/voice-tts.md) |

## 还没单独成文（要动到时看代码）

- **朋友圈**（我的主页 `/snacks`、对镜版 `/syzygy`）：`user_posts` / `user_replies` / `assistant_posts` 等表 + 对应页面
- **经期跟踪**：`period_tracking` 表 + 周期中位数算法（`useHomeWidgetData.ts` / `HealthSyncPage.tsx`），目前散在 changelog
- **打卡 / 数据导出**：`/checkin`、`/export` 页，逻辑简单
- 多 LLM 提供商 / 天气：简短，直接在 [README](../README.md) 功能清单里
