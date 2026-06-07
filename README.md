# Nimbus Chat

自托管的私人 AI 陪伴应用 —— 一个能记住你的事、写日记、控制智能家居（未来）的 Claude。（完全依托于串串老师的开源程序修改~感谢老师）

原README：项目简介 Nibble-Chat 是一个自托管的聊天小工具。前端部署在 GitHub Pages；数据存储与多端同步由用户自行创建的 Supabase 项目提供。本项目不提供中心化服务器，你的数据只在你自己的 Supabase 里。

详细教程请查看：https://pan.baidu.com/s/1xv6jAOLd2fLeOwE8pPdohw?pwd=vyfr 提取码：vyfr

本项目不提供公共后端。请先创建你自己的 Supabase 项目，并在应用内 Setup 页面填写 URL/anon key。

部署：**GitHub Pages**（PWA）+ **Android APK**（Capacitor 打包）
后端：你自己的 **Supabase** 项目（数据库 + 认证 + Edge Functions）
LLM：**OpenRouter** 主用 + **任意中转站** 备用，可全局切换

---

## 📚 专题文档

长篇内容都拆到 `docs/` 下，README 只留功能清单和使用说明：

- [**Prompt Caching 入门（给所有人）**](docs/guides/prompt-caching.md) — 不依赖本项目的通用教程，可直接分享：原理、挑中转、两要件、怎么验证、踩坑
- [**Prompt Caching 指南（实现 / 内部）**](docs/caching.md) — 缓存原理、各家中转对比、怎么配（金瓜瓜等）、怎么验证命中、块布局铁律、图片转文字、踩坑 FAQ
- [**改动记录 & Debug 日志**](docs/changelog.md) — 按日期的改动 + 踩过的坑和修法

---

## 功能清单

> 每个大功能只留一句话 + 链接，实现细节在 `docs/features/` 下，改哪个看哪个。

### 🔌 多 LLM 提供商
- **OpenRouter**（主），走 BYOK 或 OR 账户
- **任意 OpenAI 兼容中转站**（备用，从 base URL 自动派生显示名，例如 "treegpt" / "msuicode"）
- 设置页 → 模型库 第一行一键切换；可存多套中转「预设」一键切换
- 压缩 summarizer 可独立选 provider（聊天走中转，摘要走 OR 免费模型）

### 🧠 记忆系统 + 自动提取（Claude 的"灵魂"）
向量记忆（memories / diaries / 交接信 / timeline / 朋友圈）+ 结构化数据（经期 / 健康）一起喂给 Claude；每 12 轮自动提取待确认记忆，逐条确认/忽略。
→ 详见 [docs/features/memory.md](docs/features/memory.md)

### 🛠️ Claude 工具（共 12 个）
读取（搜记忆 / 交接信 / 网页）、写入（记忆 / 日记 / 交接信 / 时间轴 / 经期 / 健康）、计算调度（代码沙盒 / 主动消息 / 设备状态）。聊天里显示为可折叠工具卡片。
→ 详见 [docs/features/tools.md](docs/features/tools.md)

### 💰 成本优化
Anthropic prompt caching（三锚点断点 + `metadata.user_id` 粘性）、对话压缩、可选 summarizer 省 token。
→ 详见 [docs/caching.md](docs/caching.md)

### 🌤️ 天气接入
- 每天**第一条**用户消息自动附带当前天气（地理位置 + Open-Meteo API，无需 key）
- 通过 message.meta 持久化到该消息，请求构建时拼接，**保持 prompt cache 稳定**
- UI 不显示，只塞给 LLM

### 🔔 真·主动消息（APK 限定）
Claude 凭对话气氛自主判断，调 `schedule_proactive_message` 预约未来本地通知（transient 自动取消 / persist 不可取消两类）。
→ 详见 [docs/features/proactive.md](docs/features/proactive.md)

### 🫀 健康同步（Health Connect → health_data）
自动从手机健康数据拉今天的步数 / 睡眠 / 心率 / 静息心率 / 血氧，写进 `health_data` 给 Claude。仅 APK，走 `@capgo/capacitor-health`（read-only）。
→ 详见 [docs/features/health-sync.md](docs/features/health-sync.md)

### 🏠 主页 widget 系统
桌面式多页 widget 网格（打卡 / 健康 / 屏幕时间 / 经期 / 文本 / 图片 / app 入口），编辑模式「设置/预览」分离。
→ 详见 [docs/features/widgets.md](docs/features/widgets.md)

### 💬 聊天界面交互（LINE 风格）
气泡分组、一条=一气泡（`[NEXT]`）、工具卡片、长按菜单（自动翻转）、语音输入、离线条、震动、正在输入指示。
→ 详见 [docs/features/chat-ui.md](docs/features/chat-ui.md)

---

## ⚙️ 设置页面详解

设置页面（`/settings`）有 10 个可折叠区域，所有设置实时保存到 Supabase `user_settings` 表或本地 localStorage。

### 🔑 OpenRouter API Key
| 字段 | 说明 |
|------|------|
| API Key | 密码输入框，`sk-or-v1-...` 格式。仅存本地 localStorage，不上传 |

### 🪞 中转站 API Key
| 字段 | 说明 |
|------|------|
| Base URL | 中转站地址，如 `https://api.treegpt.cc`。从 hostname 自动派生显示名 |
| API Key | 中转站密钥。仅存本地 |

### 🧪 代码沙盒
| 字段 | 说明 |
|------|------|
| Sandbox endpoint | 你的 Mac mini / VPS 地址。`POST {endpoint}/run` 跑代码 |
| Sandbox token | 可选，走 `X-Sandbox-Token` header 鉴权 |

展开查看 API 契约：请求/响应格式、支持的语言、超时规则。

### ⚙️ 模型库
| 字段 | 说明 |
|------|------|
| API Provider 切换 | OpenRouter ↔ 中转站，一键全局切换。两边都走 Anthropic 原生 `/v1/messages` 协议（OR 通过 `Anthropic Skin`、中转通过 `anthropic.ts` 适配器），prompt cache 都有,工具迭代命中率中转 ~100% / OR ~16%（BP1 兜底） |
| OR API 格式 | OpenAI 兼容 / Anthropic 兼容。Claude 模型默认走 Anthropic（享受原生 cache_control + 思考链）,显式切到 OpenAI 兼容会尊重(用于 debug) |
| 默认模型 | 从已启用模型里选，新会话自动用这个 |
| 模型目录搜索 | 搜索 OR 模型目录，启用/停用模型 |
| 每个模型 | 可单独停用（会弹确认） |

默认启用：`openrouter/auto`

### 🎛️ 生成参数
| 字段 | 默认值 | 范围 |
|------|--------|------|
| 温度 | 0.7 | 0 - 2 |
| Top P | 0.9 | 0 - 1 |
| 最大 tokens | 1024 | 32 - 4000 |

### 🔮 思考链
| 字段 | 默认 | 说明 |
|------|------|------|
| 日常聊天思考链 | ✅ 开 | 控制是否请求 reasoning/thinking chain |
| 高触发 Thinking | ❌ 关 | 仅 GPT-5.1/5.2 生效，更积极触发思考（更慢更耗费） |

### 🧩 上下文压缩
| 字段 | 默认 | 说明 |
|------|------|------|
| 压缩开关 | ✅ 开 | 总开关 |
| 触发比例 | 0.65 | 历史 token 占上下文窗口比例超过此值时触发压缩。**模型支持工具时上限自动收紧到 0.35**（=Claude 7万 token），因为带 tool block 的请求 Anthropic 缓存不命中，提前压缩才能避免 ~$1.18/次工具迭代的全价重读 |
| 保留最近消息数 | 20 | 压缩时保留最近 N 条不动，只摘要更早的 |
| Summarizer Provider | OpenRouter | 可以让摘要走 OR（便宜模型），聊天走中转 |
| Summarizer Model | `deepseek/deepseek-chat-v3.1` | DeepSeek 中文摘要稳定 + OR 上自带 prompt cache 后比 GPT-4o-mini 更便宜。也可从已启用模型里选 |

### 📝 系统提示词
大文本框，填写全局 system prompt。空 = 用模型默认行为。

### 🍪 我的主页提示词
控制"我的主页"（朋友圈）发帖时的 AI 行为叠加层。

### 📓 TA 的主页提示词
两个文本框：
- **发帖风格**：控制 Claude 发帖的文风与内容
- **回复风格**：控制 Claude 回复的语气与长度

---

## 📱 页面一览

| 页面 | 路由 | 说明 |
|------|------|------|
| 首页 Dashboard | `/` | 时钟 + 横向多页（scroll-snap 翻页 + 圆点指示器）+ 打卡卡片（一周圈圈 + 一键打卡）+ 健康/屏幕时间/经期内容 widget + 9 个 app shortcut 图标 + 文本/图片/占位 widget。**无底部 dock**，所有图标作为 widget 在 page 0；长按任意 widget 进编辑模式 → 加组件 / 拖动 / 改图标 emoji / 增删页 / 「预览」切换 |
| 聊天 | `/chat/:id` | LINE 风格主聊天界面，工具循环 + 流式 + 懒加载 |
| 设置 | `/settings` | 10 个折叠区（详见上方） |
| 记忆库 | `/memory-vault` | 4 个 tab：记忆 / 日记 / 交接信 / 时间轴，CRUD + 搜索 + 来源筛选 + 自动提取 + 待确认流程 |
| 我的主页 | `/snacks` | 朋友圈帖子 + AI 回复 + 软删除回收站 |
| TA 的主页 | `/syzygy` | Claude 的朋友圈（对镜版）。头像在聊天 header 同步显示 |
| 用量统计 | `/usage` | 按 provider / 按会话排行 + 缓存命中率 |
| 健康同步 | `/health-sync` | Health Connect → `health_data`（同步状态卡 + 今日体征 grid）、📱 屏幕时间 section（含权限引导按钮）、🌸 经期跟踪 section（自动算周期天数 / 阶段 / 下次预计）、🔧 诊断工具折叠。APK 限定 |
| 每日打卡 | `/checkin` | 连续打卡 streak + 月历 |
| 数据导出 | `/export` | Markdown/JSON/TXT 格式导出聊天 + 记忆 + 打卡 |
| 首页布局 | `/home-layout` | 编辑首页小组件排列 |
| 登录 | `/auth` | 邮箱 OTP 登录（Supabase Auth） |
| Supabase 配置 | 内部 | 首次填写 Supabase URL + anon key |

---

## 架构图

```
                     用户的浏览器 / APK
                       │   │   │   │
            ┌──────────┘   │   │   └─────────────┐
            ▼              ▼   ▼                  ▼
       Supabase         OR / 中转站           Mac mini (未来)
   (数据库 + 认证          (LLM 推理)         (sandbox + 智能家居)
    + Edge Functions)
            │
            ├─→ tables: messages, sessions, checkins, user_settings,
            │           compression_cache, user_posts, user_replies,
            │           assistant_posts, assistant_replies, memories,
            │           memory_entries, memory_extract_log,
            │           diaries, handoff_letters, timeline,
            │           period_tracking, health_data, essays, usage_logs,
            │           proactive_queue, fcm_tokens,
            │           cache_keepalive_state
            │
            ├─→ edge functions: openrouter-chat, openrouter-models,
            │                   memory-extract, web_search,
            │                   send_proactive_push (pg_cron 触发),
            │                   cache_keepalive (代码仍在,pg_cron job 已停)
            │
            └─→ DB functions: search_memories (RPC, filter_table 参数),
                              auto_embed_* (INSERT trigger, REVOKE'd),
                              soft_delete_user_post / restore_user_post
```

---

## Supabase 项目要求

启用扩展：
- `vector` (pgvector) — 向量搜索
- `pg_net` — DB trigger 调 Edge Function（auto embedding）
- `pg_cron` — 定时检查 proactive_queue 发 FCM 推送

关键表 schema：
- 全量 schema 在 `supabase/init.sql`（已和线上对齐）
- 增量改动在 `supabase/migrations/*.sql`
- 6 张工具表 + `compression_cache` 是**单租户开放 RLS**（`USING (true) WITH CHECK (true)`，by design 因为本项目一个账号自己用）

Edge Functions（已部署）:
- `openrouter-chat` — 聊天主入口 + compression cache
- `openrouter-models` — 拉取模型目录
- `memory-extract` — 从对话提候选记忆
- `web_search` — Tavily 代理（有 `getUser()` JWT 校验）
- `send_proactive_push` — FCM 推送发送器（pg_cron 触发，默认关闭）

DB 函数:
- `search_memories(query_embedding, filter_table?, ...)` — 跨表向量搜
- `auto_embed_*` — INSERT trigger 自动生成向量（已 `REVOKE` anon/authenticated 防滥用）

---

## 部署

### Web (GitHub Pages)
- push 到 main → GitHub Actions 自动 build + deploy
- `BUILD_TARGET=pages` 让 vite base 设为 `/Nimbus-Chat/`
- Secrets：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`

### Edge Functions（自动部署）
- push 到 main 且 `supabase/functions/**` 有改动 → GitHub Actions 自动部署
- Secrets：`SUPABASE_ACCESS_TOKEN`、`SUPABASE_PROJECT_REF`

### Android APK (Capacitor)
- push 到 main 或打 `v*` tag 触发 build
- **签名 release APK**（稳定 keystore），覆盖安装数据不丢
- CI 验证 keystore：ASCII 密码预检 + `keytool -certreq` 私钥校验
- 产物在 Actions → Artifacts → `nimbus-chat-apk`

所需 GitHub Secrets:
- `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD` / `ANDROID_KEY_ALIAS`
- `GOOGLE_SERVICES_JSON`（可选，FCM 用）

### Android 权限
**minSdkVersion 26**(Android 8.0)— 由 Health Connect plugin 决定。

| 权限 | 用途 |
|------|------|
| `INTERNET` | API 调用 |
| `ACCESS_FINE/COARSE_LOCATION` | 天气定位 |
| `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` | 精确定时通知 |
| `RECEIVE_BOOT_COMPLETED` | 重启后恢复已调度通知 |
| `WAKE_LOCK` | 通知唤醒屏幕 |
| `POST_NOTIFICATIONS` | Android 13+ 通知权限 |
| `CAMERA` + `uses-feature camera(required=false)` | 输入栏 📷 拍照按钮 → WebView `<input capture="environment">` 启动 `ACTION_IMAGE_CAPTURE`。**没这行 intent 会 silent fallback 到相册**;feature 标 `required=false` 让无相机的平板也能装 |
| `RECORD_AUDIO` + `uses-feature microphone(required=false)` | 输入栏 🎤 语音输入 → 原生 `SpeechRecognizer` 离线识别 zh-CN |
| `VIBRATE` | `@capacitor/haptics` 震动反馈(normal protection,自动给,但显式声明便于 Android 13+ 迁移到 `USE_VIBRATE_PERMISSION`) |
| `health.READ_STEPS / READ_SLEEP / READ_HEART_RATE / READ_RESTING_HEART_RATE / READ_DISTANCE / READ_TOTAL_CALORIES_BURNED / READ_OXYGEN_SATURATION` | Health Connect 读取(用户在 Health Connect app 中授权后才生效) |
| `PACKAGE_USAGE_STATS` | 屏幕使用时间。**特殊 AppOp** — 用户必须去系统设置 → 应用 → 使用情况访问 → Nimbus → 开启,app 内调 `requestPermission()` 只跳设置页 |
| `QUERY_ALL_PACKAGES` | 让屏幕时间 plugin 拿到其他 app 的「显示名」(微信 / B站 等),否则只显示 `com.tencent.mm` 这种包名 |

### Capacitor plugins
| 插件 | 用途 |
|---|---|
| `@capacitor/app`, `@capacitor/device`, `@capacitor/status-bar`, `@capacitor/splash-screen` | 基础生命周期 / 设备信息 / 状态栏 / 启动屏 |
| `@capacitor/geolocation` | 天气定位 |
| `@capacitor/local-notifications` + `@capacitor/push-notifications` | 主动消息 + FCM(默认关) |
| `@capgo/capacitor-health` | Health Connect 读取 |
| `@capacitor/haptics` | 震动反馈 |
| `@capacitor/share` | 长按菜单 → 分享 |
| `@capacitor/network` | 离线条状态监听 |
| `@capacitor-community/speech-recognition` | 🎤 语音输入,native SpeechRecognizer,离线免费 |

---

## 文件指南

```
src/
├── App.tsx                    # 主路由 + sendMessage + 12 个工具循环
├── tools/
│   └── definitions.ts         # 所有 TOOL_* schema 定义（拆出来减肥 App.tsx）
├── hooks/
│   └── useHomeWidgetData.ts   # 共享 hook：拉今日 health_data / period / 屏幕时间
├── api/
│   ├── openrouter.ts          # 通用 LLM provider fetcher（OR/中转）
│   └── anthropic.ts           # /v1/messages 适配器：OpenAI ⇄ Anthropic 双向（流式 + 非流式 + usage + 图片 base64 + tool_use_id 校验）
├── components/
│   ├── MarkdownRenderer.tsx   # React.memo markdown（content equality）
│   ├── ReasoningPanel.tsx     # 思考链折叠面板（memo）
│   ├── ToolCallCard.tsx       # 工具调用可折叠卡片（图标+名称+参数预览+耗时）
│   ├── SessionsDrawer.tsx     # 左侧会话抽屉
│   ├── ConfirmDialog.tsx
│   └── LocalAvatar.tsx        # 头像上传（MyHomePage / AssistantHomePage 用）
├── pages/
│   ├── ChatPage.tsx           # 聊天：MessageRow memo + 时间分隔 + 懒加载 + 工具卡片
│   ├── SettingsPage.tsx       # 10 个折叠区（API/模型/参数/思考链/压缩/提示词...）
│   ├── MemoryVaultPage.tsx    # 记忆库 4 tab CRUD
│   ├── UsagePage.tsx          # 用量统计
│   ├── MyHomePage.tsx         # 我的主页（朋友圈）
│   ├── AssistantHomePage.tsx  # TA 的主页（对镜版）
│   ├── HomePage.tsx           # 首页 dashboard：多页 widget grid（无 dock）+ 编辑模式
│   ├── HomeLayoutSettingsPage.tsx  # /home-layout 深度编辑（含外观调整 + dock emoji 编辑器）
│   ├── HealthSyncPage.tsx     # 健康综合页：同步 + 今日体征 + 屏幕时间 + 经期 + 诊断工具
│   ├── ExportPage.tsx         # 数据导出
│   ├── CheckinPage.tsx        # 每日打卡
│   ├── AuthPage.tsx           # 邮箱 OTP 登录
│   └── SupabaseSetupPage.tsx
├── storage/
│   ├── apiProvider.ts         # OR / 中转切换 + base URL 派生名
│   ├── openrouterKey.ts       # OR API key（localStorage）
│   ├── chatStorage.ts         # 本地会话/消息快照
│   ├── userSettings.ts        # 用户设置（Supabase + localStorage）
│   ├── conversationCompression.ts  # 摘要 + cache（force flag 给手动按钮）
│   ├── usageStats.ts          # usage_logs 读写
│   ├── usageStatsNative.ts    # 自定义 Capacitor plugin bridge（PACKAGE_USAGE_STATS 屏幕时间）
│   ├── deviceState.ts         # 电量 + 充电 + 屏幕时间汇总（get_device_state 工具用）
│   ├── healthSync.ts          # Health Connect 拉取 + 按天聚合 + upsert health_data；30min 节流
│   ├── weather.ts             # Open-Meteo 天气 + 1h 缓存
│   ├── proactiveNotification.ts  # 本地通知调度 + cancel/re-arm（title 走 assistantPersona）
│   ├── assistantPersona.ts    # 助手显示名（默认"哥哥"，可在聊天 ⚙️ 菜单改）
│   ├── supabaseSync.ts        # 远程 CRUD（sessions/messages/checkins/overrides）
│   ├── supabaseConfig.ts      # 本地 Supabase URL/key 配置
│   ├── sandbox.ts             # 代码沙盒（带 https/http 协议校验）
│   ├── statusBar.ts           # Android StatusBar 跟随页面 bg
│   ├── homeLayout.ts          # 首页布局（pages[] + 迁移逻辑 + IndexedDB 图片）
│   ├── openrouterPricing.ts   # 模型定价（24h 缓存）
│   └── imageUpload.ts         # 图片压缩 + Supabase Storage 上传
└── supabase/
    └── client.ts              # supabase 单例 + 本地配置覆盖

android/app/src/main/java/com/cocoraina/nimbuschat/
├── MainActivity.java          # Capacitor BridgeActivity + 注册 UsageStatsPlugin
└── UsageStatsPlugin.java      # 自定义 Capacitor plugin：UsageStatsManager 读今日 app 使用时长
```

---

## 已知限制 / 未做

- **中转保活 ping 不可靠**:cron job 已 `active:=false` 停掉(见成本优化节)。日均代价 $0.20-0.50 自然冷写
- **单租户 RLS**:工具表用开放策略,只适合一个账号用
- **iOS**:通知/状态栏/硬件返回 都是 Android-only 守卫
- **FCM**:代码保留但默认关闭(华为 GMS 不稳定)
- **`window.confirm/prompt/alert`**:部分页面还在用原生 dialog,待统一为 `ConfirmDialog`

## 历史 / 想做但暂缓

- 语音输出(TTS)
- 暗黑模式 — 试过,每个页面的硬编码颜色太多,做一半撤了
- 端到端加密的消息存储
- Anthropic Code Execution 工具(要 BYOK 直连)

