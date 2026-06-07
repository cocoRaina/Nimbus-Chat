# 文档地图

> Nimbus 的文档都在这。新窗口先读根目录 [CLAUDE.md](../CLAUDE.md) 速览，再按需进下面的专题。

## 通用 / 跨功能

| 文档 | 内容 |
|---|---|
| [caching.md](caching.md) | **Prompt Caching 指南(内部)**：原理、各家中转对比、怎么配、验证命中、块布局铁律、图片转文字、FAQ、附 Nimbus 成本优化实现 |
| [guides/prompt-caching.md](guides/prompt-caching.md) | **Prompt Caching 入门(对外)**：不依赖本项目的通用教程，可直接分享 |
| [changelog.md](changelog.md) | 按日期的改动记录 + Debug 日志(踩过的坑 + 修法) |

## 按功能（`docs/features/`）

| 功能 | 文档 |
|---|---|
| 记忆系统 + 自动提取 | [features/memory.md](features/memory.md) |
| Claude 工具（12 个） | [features/tools.md](features/tools.md) |
| 真·主动消息 | [features/proactive.md](features/proactive.md) |
| 健康同步（Health Connect） | [features/health-sync.md](features/health-sync.md) |
| 屏幕使用时间（UsageStats） | [features/screen-time.md](features/screen-time.md) |
| 主页 widget 系统 | [features/widgets.md](features/widgets.md) |
| 聊天界面交互 | [features/chat-ui.md](features/chat-ui.md) |

## 还没单独成文（要动到时看代码）

- **朋友圈**（我的主页 `/snacks`、对镜版 `/syzygy`）：`user_posts` / `user_replies` / `assistant_posts` 等表 + 对应页面
- **经期跟踪**：`period_tracking` 表 + 周期中位数算法（`useHomeWidgetData.ts` / `HealthSyncPage.tsx`），目前散在 changelog
- **打卡 / 数据导出**：`/checkin`、`/export` 页，逻辑简单
- 多 LLM 提供商 / 天气：简短，直接在 [README](../README.md) 功能清单里
