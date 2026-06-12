# Nimbus Chat


自托管私人 AI 陪伴应用 —— Claude 驱动的聊天助手，带记忆系统、健康同步、桌面小组件。

基于 [Nibble-Chat](https://github.com/chuan-101/Nibble-Chat) 修改。

**部署方式**：GitHub Pages（PWA）+ Android APK（Capacitor）
**后端**：用户自己的 Supabase 项目（数据库 + 认证 + Edge Functions）
**LLM**：OpenRouter（主）+ 任意 OpenAI 兼容中转站（备用）

---

## 快速开始

### 1. 创建 Supabase 项目

在 [supabase.com](https://supabase.com) 创建项目 → SQL Editor 执行 supabase/init.sql → 启用扩展 vector、pg_trgm、pg_net、pg_cron。

### 2. 部署 Web 版

Fork 本仓库 → Settings → Secrets → Actions 添加：

| Secret | 说明 |
|--------|------|
| VITE_SUPABASE_URL | Supabase 项目 URL |
| VITE_SUPABASE_ANON_KEY | Supabase anon key |
| SUPABASE_ACCESS_TOKEN | Supabase access token（部署 Edge Functions） |
| SUPABASE_PROJECT_REF | Supabase 项目 ref |

push main → Actions 自动部署 Pages + Edge Functions。

### 3. 部署 APK（可选）

额外添加 Android signing secrets → push v* tag 触发构建 → Actions → Artifacts 下载 APK。

---

## 本地开发

前提：Node 22（APK）/ Node 20（Pages），JDK 21（APK），Android SDK API 36（APK）

npm ci
cp .env.example .env  # 编辑填入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev           # Vite dev server

APK 本地构建：

npm run build
npx cap sync android
cd android && ./gradlew assembleDebug

### 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| VITE_SUPABASE_URL | 构建时 | Supabase 项目 URL |
| VITE_SUPABASE_ANON_KEY | 构建时 | Supabase anon key |
| BUILD_TARGET=pages | 构建时 | 设定 Vite base 为 /Nimbus-Chat/ |
| VITE_NO_FX=1 | 运行时 | 禁用动画（低配设备） |
| SILICONFLOW_API_KEY | Edge Function | 记忆搜索 embedding |
| TAVILY_API_KEY | Edge Function | 联网搜索 |
---

## 功能

### 聊天
- LINE 风格气泡、[NEXT] 分割多条、[sticker:名字] 表情包、[voice]…[/voice] 语音消息（MiniMax TTS）
- 流式响应、懒加载历史、离线条、震动、正在输入指示
- 连发模式：2.5 秒停顿窗口，打字会推迟 AI 回复

### LLM 后端
- OpenRouter（主）或任意 OpenAI 兼容中转站（备用，base URL 自动派生显示名）
- 压缩 summarizer 可独立选 provider
- 多套中转预设一键切换，每个模型可单独停用

### 记忆系统
- 向量记忆 + 日记 + 交接信 + 时间轴 + 朋友圈
- 每 12 轮自动提取候选记忆
- 核心记忆可锁定 → 自动注入 prompt cache 前缀
- Claude 自管理（锁定/解锁/合并/归档）+ 近重复扫描（garden_memories）
- 软删除进归档表，保留 embedding

### Claude 工具（15 个）
读取（搜记忆/交接信/网页）、写入（记忆/日记/时间轴/经期/健康）、管理（锁定/归档/合并/花园整理）、计算调度（代码沙盒/主动消息/设备状态）

### 成本优化
Anthropic prompt caching（三锚点 + metadata.user_id）、对话压缩（DeepSeek V3.1 做摘要）、缓存命中率监控

### 天气
每天第一条消息自动附带当前天气（Open-Meteo API，无需 key），通过 message.meta 持久化保持 cache 稳定

### 主动消息（APK 限定）
Claude 自主判断调 schedule_proactive_message 预约本地通知（transient/persist 两类）

### 健康同步（APK 限定）
Health Connect → health_data：步数/睡眠/心率/血氧，自动按天聚合 upsert

### 主页 Widget 系统
App 内首页：多页 widget 网格（打卡/健康/屏幕时间/经期/文本/图片/app 入口），编辑模式设置/预览分离

### 桌面小组件（APK 限定）
经期卡 + emoji 桌宠 + 2x1~4x2 组合卡（日期+经期+Clawd 动画螃蟹：6 种状态x24 动画），RemoteViews + ViewFlipper

### 页面路由
| 路由 | 页面 |
|------|------|
| / | 首页 Dashboard |
| /chat/:id | 聊天 |
| /settings | 设置（10 个折叠区） |
| /memory-vault | 记忆库（记忆/日记/交接信/时间轴） |
| /snacks | 我的主页（朋友圈） |
| /syzygy | TA 的主页 |
| /usage | 用量统计 |
| /health-sync | 健康同步 + 屏幕时间 + 经期 |
| /checkin | 每日打卡 |
| /export | 数据导出 |
| /home-layout | 首页布局编辑 |
| /auth | 邮箱 OTP 登录 |
---

## 架构

浏览器 / APK
  ├─→ Supabase（数据库 + 认证 + Edge Functions）
  ├─→ OpenRouter / 中转站（LLM）
  └─→ 代码沙盒（Mac mini / VPS）

Supabase 表：messages, sessions, checkins, user_settings, compression_cache,
  user_posts, user_replies, assistant_posts, assistant_replies,
  memories, memories_archive, memory_entries, memory_extract_log,
  diaries, handoff_letters, timeline, period_tracking, health_data,
  essays, usage_logs

Edge Functions（均有 JWT 校验）：
  openrouter-chat — 聊天入口 + compression cache
  openrouter-models — 模型目录
  memory-extract — 提取候选记忆
  web_search — Tavily 代理
  search_memory — 记忆混合检索（向量+关键词 RRF）
  search_handoff — 交接信检索
  tts — MiniMax TTS 代理
  auto_embed — INSERT trigger embedding（REVOKEd anon）
  cache_keepalive — 中转保活 ping（已停用）

DB 函数：search_memories_hybrid（RRF+时间近度）、find_similar_memory_pairs（近重复扫描）、archive_memory/restore_memory（软删除）

---

## 部署

### Web（GitHub Pages）
push main → Actions 自动 build+deploy。需 Secrets：VITE_SUPABASE_URL、VITE_SUPABASE_ANON_KEY。BUILD_TARGET=pages 设 Vite base。

### Edge Functions
push main 且 supabase/functions/** 有改动 → 自动部署。需 Secrets：SUPABASE_ACCESS_TOKEN、SUPABASE_PROJECT_REF。

### Android APK（Capacitor）
push main 或 v* tag → 签名 release APK。覆盖安装数据不丢。CI 验证 keystore 完整性。产物在 Actions→Artifacts→nimbus-chat-apk。
需 Secrets：ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD / ANDROID_KEY_ALIAS。

### Android 权限
INTERNET、定位（天气）、精确定时闹钟、RECEIVE_BOOT_COMPLETED、WAKE_LOCK、POST_NOTIFICATIONS（13+）、CAMERA（拍照→ACTION_IMAGE_CAPTURE）、VIBRATE、health.READ_*（7项）、PACKAGE_USAGE_STATS（需手动授权）、QUERY_ALL_PACKAGES（显示app名）。minSdkVersion 26（Android 8.0）。

### Capacitor 插件
app, device, status-bar, splash-screen, geolocation, local-notifications, haptics, share, network, @capgo/capacitor-health。

---

## 文件指南

src/
├── App.tsx                    # 主路由 + sendMessage + 15 工具循环 + 锁定记忆注入
├── tools/definitions.ts       # 所有 TOOL_* schema
├── hooks/useHomeWidgetData.ts # 共享 hook：今日 health_data / period / 屏幕时间
├── api/
│   ├── openrouter.ts          # 通用 LLM fetcher（OR/中转）
│   └── anthropic.ts           # OpenAI-Anthropic 双向适配器
├── components/
│   ├── MarkdownRenderer.tsx   # React.memo markdown
│   ├── ReasoningPanel.tsx     # 思考链折叠面板
│   ├── ToolCallCard.tsx       # 工具调用可折叠卡片
│   ├── VoiceBubble.tsx        # 微信式语音条
│   ├── SessionsDrawer.tsx     # 会话抽屉
│   ├── ConfirmDialog.tsx      # 通用确认弹框（支持 children）
│   └── LocalAvatar.tsx        # 头像上传
├── pages/
│   ├── ChatPage.tsx           # 聊天主界面
│   ├── SettingsPage.tsx       # 设置（10 折叠区）
│   ├── MemoryVaultPage.tsx    # 记忆库 CRUD（记忆/日记/交接信/时间轴）
│   ├── UsagePage.tsx          # 用量统计
│   ├── MyHomePage.tsx         # 我的主页（朋友圈）
│   ├── AssistantHomePage.tsx  # TA 的主页
│   ├── HomePage.tsx           # 首页 widget 网格
│   ├── HomeLayoutSettingsPage.tsx  # 首页布局编辑
│   ├── HealthSyncPage.tsx     # 健康综合页
│   ├── ExportPage.tsx         # 数据导出
│   ├── CheckinPage.tsx        # 每日打卡
│   ├── AuthPage.tsx           # 邮箱 OTP 登录
│   └── SupabaseSetupPage.tsx  # Supabase 配置
├── storage/
│   ├── apiProvider.ts         # OR/中转切换
│   ├── chatStorage.ts         # 本地会话快照
│   ├── userSettings.ts        # 设置（Supabase + localStorage）
│   ├── conversationCompression.ts  # 摘要 + cache
│   ├── healthSync.ts          # Health Connect 拉取 + 聚合
│   ├── weather.ts             # Open-Meteo 天气 + 1h 缓存
│   ├── proactiveNotification.ts  # 本地通知调度
│   ├── supabaseSync.ts        # 远程 CRUD
│   ├── stickers.ts            # 表情包（共享贴纸集）
│   ├── homeLayout.ts          # 首页布局（迁移逻辑）
│   ├── usageStatsNative.ts    # 屏幕时间 plugin bridge
│   ├── deviceState.ts         # 电量/充电/屏幕时间
│   ├── assistantPersona.ts    # 助手显示名
│   ├── sandbox.ts             # 代码沙盒
│   ├── statusBar.ts           # Android StatusBar 跟随页面
│   ├── imageCaptions.ts       # 图片→文字描述缓存
│   ├── imageUpload.ts         # 图片压缩 + Supabase Storage
│   ├── periodWidget.ts        # 经期数据 → 桌面小组件
│   └── ttsConfig.ts           # MiniMax TTS 配置
└── supabase/client.ts         # Supabase 单例

android/.../nimbuschat/
├── MainActivity.java          # BridgeActivity + 注册 plugin
├── UsageStatsPlugin.java      # 屏幕使用时间 plugin
├── ShareReceiverPlugin.java   # 系统分享接收（队列）
├── PeriodWidgetPlugin.java    # 经期数据 → 桌面小组件
├── PeriodCalc.java            # 经期计算（UTC 纯日期）
├── PeriodWidgetProvider.java  # 经期卡 AppWidget
├── PetWidgetProvider.java     # emoji 桌宠 AppWidget
└── ComboWidgetProvider.java   # 2x1 组合卡 + Clawd 螃蟹动画

---

## 已知限制
- 单租户 RLS：工具表用开放策略，只适合一个账号
- 中转保活 ping 已停：每日约 0.20-0.50 自然冷写
- iOS 不支持：通知/状态栏/硬件返回均为 Android-only

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [改动记录](docs/changelog.md) | 按日期的改动+踩坑修法 |
| [Prompt Caching](docs/caching.md) | 缓存原理、各家中转对比 |
| [记忆系统](docs/features/memory.md) | 记忆架构、自动提取 |
| [工具系统](docs/features/tools.md) | 15 个工具 schema |
| [聊天 UI](docs/features/chat-ui.md) | 气泡、连发、表情包 |
| [语音 TTS](docs/features/voice-tts.md) | MiniMax 集成 |
| [主动消息](docs/features/proactive.md) | 本地通知调度 |
| [健康同步](docs/features/health-sync.md) | Health Connect 集成 |
| [Widget 系统](docs/features/widgets.md) | 首页+桌面小组件 |
| [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md) | 第三方资源署名 |

---

## Supabase 要求
启用扩展：vector（pgvector）、pg_trgm、pg_net、pg_cron。
全量 schema：supabase/init.sql。增量改动：supabase/migrations/*.sql。
Edge Functions 除 cache_keepalive 外均运行中。