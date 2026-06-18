# Nimbus Chat

自托管的私人 AI 陪伴 App —— 一个能记住你、写日记、主动给你发消息的 Claude。

基于 [Nibble-Chat](https://github.com/chuan-101/Nibble-Chat)（感谢串串老师 🙏）二次开发。**数据完全存在你自己的 Supabase 里，本项目不提供任何公共后端。**

- 前端：React + Vite → **GitHub Pages PWA** + **Android APK**（Capacitor）
- 后端：你自己的 **Supabase**（数据库 + Auth + Edge Functions）
- LLM：**OpenRouter** 主 + **任意中转站** 备，设置页一键切换

> 📦 安装教程（含 Supabase 配置）：[百度网盘](https://pan.baidu.com/s/1xv6jAOLd2fLeOwE8pPdohw?pwd=vyfr) 提取码：`vyfr`

---

## 📚 专题文档

长篇内容都拆到 `docs/` 下，README 只留功能清单和使用说明：

- [**Prompt Caching 入门（给所有人）**](docs/guides/prompt-caching.md) — 不依赖本项目的通用教程，可直接分享：原理、挑中转、两要件、怎么验证、踩坑
- [**Prompt Caching 指南（实现 / 内部）**](docs/caching.md) — 缓存原理、各家中转对比、怎么配（金瓜瓜等）、怎么验证命中、块布局铁律、图片转文字、踩坑 FAQ
- [**AI 长期记忆系统入门（给所有人）**](docs/guides/memory-system.md) — 通用教程，可直接分享：为什么 Claude 失忆、常驻注入 vs 按需搜索、向量检索、RRF 混合检索、记忆生命周期、去重、访问追踪、AI 自管理、最小实现代码
- [**记忆系统（实现 / 内部）**](docs/features/memory.md) — 各表结构、混合检索实现、核心记忆生命周期、自动提取确认流程、去重逻辑、访问追踪、每日状态注入
- [**改动记录 & Debug 日志**](docs/changelog.md) — 按日期的改动 + 踩过的坑和修法

---

## 🚀 快速开始

### 1. 创建 Supabase 项目

[supabase.com](https://supabase.com) 新建项目 → SQL Editor 执行 `supabase/init.sql` → 启用扩展：`vector`、`pg_trgm`、`pg_net`、`pg_cron`。

### 2. 部署 Web 版

Fork 本仓库 → Settings → Secrets →Actions 添加：

- `VITE_SUPABASE_URL` — Supabase 项目 URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anon key
- `SUPABASE_ACCESS_TOKEN` — 部署 Edge Functions 用
- `SUPABASE_PROJECT_REF` — Supabase 项目 ref

push main → Actions 自动部署 Pages + Edge Functions。

### 3. 部署 APK（可选）

额外添加 Android signing secrets（见下方部署节）→ push `v*` tag → Actions → Artifacts 下载 APK。

---

## 💻 本地开发

**前提**：Node 20（Pages）/ Node 22（APK），JDK 21 + Android SDK API 36（APK）

```bash
npm ci
cp .env.example .env   # 填入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev            # Vite dev server
```

APK 本地构建：

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

- `VITE_SUPABASE_URL`（构建时）— Supabase 项目 URL
- `VITE_SUPABASE_ANON_KEY`（构建时）— Supabase anon key
- `BUILD_TARGET=pages`（构建时）— 设定 Vite base 为 `/Nimbus-Chat/`
- `SILICONFLOW_API_KEY`（Edge Function）— 记忆搜索 embedding
- `TAVILY_API_KEY`（Edge Function）— 联网搜索

---

## 功能清单

> 每个大功能只留一句话 + 链接，实现细节在 `docs/features/` 下，改哪个看哪个。

### 🔌 多 LLM 提供商
- **OpenRouter**（主），走 BYOK 或 OR 账户
- **任意 OpenAI 兼容中转站**（备用，从 base URL 自动派生显示名，例如 "treegpt" / "msuicode"）
- 设置页 → 模型库 第一行一键切换；可存多套中转「预设」一键切换
- 压缩 summarizer 可独立选 provider（聊天走中转，摘要走 OR 免费模型）

### 🧠 记忆系统 + 自动提取（Claude 的"灵魂"）
向量记忆（memories / diaries / 交接信 / timeline / 朋友圈）+ 结构化数据（经期 / 健康）；每 12 轮自动提取待确认记忆。核心记忆可 🔒 **锁定→自动注入缓存前缀**（AI 常驻已知，未锁定的留作可搜索归档）；Claude 能**自管理**（`manage_memory` 锁定/解锁/合并/归档 + `list_memories` 通览 + `garden_memories` 扫描近重复对 + `check_memory_health` 查休眠记忆）；**软删除**进归档表可在后台找回（`archive_memory` / `restore_memory`，归档时保留 embedding）。记忆库 UI 支持**内联编辑**（原地展开输入框）、分页（每页 20 条）、锁定 token 预算提示。

**访问追踪**：每次 `search_memory` 命中的 memory 条目会 fire-and-forget 更新 `access_count` + `last_accessed_at`；自动提取时发现重复同样强化原条目（而非新建副本）。`check_memory_health` 工具可扫描长期未被召回的休眠记忆，让 Claude 决定归档还是保留。
→ 详见 [docs/features/memory.md](docs/features/memory.md)

### 🛠️ Claude 工具（共 20 个）
读取（搜记忆 / 交接信 / 网页 / 通览记忆 list_memories / **get_health_status** 随时查健康+经期）、写入（记忆 / 日记 / 交接信 / 时间轴 / 经期 / 健康）、记忆管理（manage_memory：锁定/解锁/修正/归档 + garden_memories：向量扫描近重复对 + check_memory_health：休眠记忆健康检查）、计算调度（代码沙盒 / 主动消息 / 设备状态）、**音乐媒体**（play_music 网易云搜歌放歌 / control_media 暂停换歌 / get_now_playing 读当前在放什么，APK 限定）。聊天里显示为可折叠工具卡片。
→ 详见 [docs/features/tools.md](docs/features/tools.md)

### 💰 成本优化
Anthropic prompt caching（三锚点断点 + `metadata.user_id` 粘性）、对话压缩、可选 summarizer 省 token。工具迭代全链路缓存命中：所有迭代统一开 thinking + 跨迭代原样回传 thinking block（content + signature），避免工具调用触发冷写（¥1.5 → ¥0.01）。
→ 详见 [docs/caching.md](docs/caching.md)

### 🌤️ 天气 + 每日状态注入
每天**第一条**用户消息自动附带三类环境信息，通过 `message.meta` 持久化（历史消息保留快照，**不影响 prompt cache 稳定性**，UI 不显示，只塞给 LLM）：
- **天气**：地理位置 + Open-Meteo API（无需 key）
- **健康快照**：查 `health_data`（昨晚睡眠 + 深/浅/REM 分段 / 步数）+ `period_tracking`（经期状态），格式如 `昨晚睡了 5.5h（深睡 1.2h／REM 1.0h／浅睡 3.3h），步数 2341；经期进行中`
- **设备状态**（APK）：当前电量 + 充电状态，格式如 `🔋32% 充电中`

Claude 看到这些后能自然地关心"昨晚睡得不太好，今天感觉怎么样"，无需调用任何工具。

### 🔔 真·主动消息（APK 限定）
Claude 凭对话气氛自主判断，调 `schedule_proactive_message` 预约未来主动消息（transient 自动取消 / persist 不可取消两类）。本地通知弹横幅 + 服务端 `proactive_dispatch` cron 到点写库兜底（app 关着也照发），消息时间戳用计划时间。
→ 详见 [docs/features/proactive.md](docs/features/proactive.md)

### 🎵 网易云放歌 + 媒体控制（APK 限定）
Claude 能给你**放指定的歌**：`play_music` 走 `netease_search` Edge Function 服务端搜网易云（绕 WebView CORS），用 `orpheus://song/{id}/?autoplay=1` deep link 直接拉起网易云并自动播放首条结果；`control_media` 控制当前播放（暂停/继续/上一首/下一首，任意 App 都生效）；`get_now_playing` 读**现在在放什么歌**（歌名/歌手/专辑/进度）。后两个在开了**通知使用权**时走 `MediaSessionManager`/`MediaController` 精准控制 + 读元数据；`control_media` 没权限时降级广播媒体键仍可用。需手机已装并登录网易云。
→ 详见 [docs/features/tools.md](docs/features/tools.md)

### 🫀 健康同步（Health Connect → health_data）
自动从手机健康数据拉近三天的步数 / 睡眠（含深/浅/REM 分段）/ 心率 / 静息心率 / 血氧，写进 `health_data` 给 Claude。仅 APK，走 `@capgo/capacitor-health`（read-only）。睡眠分段来自每个 session 的 `stages[]` 数组，而非父 session 的 `sleepState`。
→ 详见 [docs/features/health-sync.md](docs/features/health-sync.md)

### 🏠 主页 widget 系统（App 内）
App **内部**首页的桌面式多页 widget 网格（打卡 / 健康 / 屏幕时间 / 经期 / 文本 / 图片 / app 入口），编辑模式「设置/预览」分离。
→ 详见 [docs/features/widgets.md](docs/features/widgets.md)

### 📱 桌面小组件 + Clawd 螃蟹桌宠（Android 主屏，APK 限定）
真正放手机桌面上的 AppWidget（不开 App 也能看）：经期卡、emoji 桌宠、以及主打的 **2×1~4×2 组合卡**（左 日期+经期，右**会动的 Clawd 螃蟹**：按相位/时段切 6 种状态动画，戳一下随机播 24 个动画之一，点左侧开 App）。实现走 RemoteViews + `ViewFlipper` 帧循环（无需 GIF 解码）；螃蟹帧抽自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank)（MIT，署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)），放独立资源目录 `res-crab/`。

### 💬 聊天界面交互（LINE 风格）
气泡分组、一条=一气泡（`[NEXT]`）、长按菜单（自动翻转）、复制（原生剪贴板）、离线条、震动、正在输入指示。**思考链 + 工具卡片按真实顺序交错显示**（思考→工具→思考→回复，像 claude.ai）。
→ 详见 [docs/features/chat-ui.md](docs/features/chat-ui.md)

### 🔊 语音消息（TTS · MiniMax）
AI 用 `[voice]…[/voice]` 包起来的内容渲染成微信式语音条（点播才合成 MiniMax TTS、可转文字、未配置时降级为文字）。
→ 详见 [docs/features/voice-tts.md](docs/features/voice-tts.md)

### 🧷 表情包 + 连发
- **连发**：像 IM 一样一口气发好几条（文字、表情包都行），停顿 2.5 秒没新动作后 AI 才一次性把这一批一起回（`queueUserMessage` debounce）。**正在输入框打字也算"动作"**，会把定时器推后，所以打下一条时 AI 不会抢答。
- **表情包**：你和 AI 共用一套贴纸，用 `[sticker:名字]` 引用。输入栏 🧷 按钮打开 **LINE 风格表情面板**（4 列网格、可滚动）导入/发送/删除；AI 也会按注入的贴纸列表自己发。详见 [docs/features/chat-ui.md](docs/features/chat-ui.md)
- **附件面板（微信风格）**：输入栏 `+` 打开底部面板，📷 拍照（APK 走 `@capacitor/camera` 原生相机）/ 🖼 从相册。

---

## ⚙️ 设置页面详解

设置页面（`/settings`）有 10 个可折叠区域，所有设置实时保存到 Supabase `user_settings` 表或本地 localStorage。

### 🔑 OpenRouter API Key
- **API Key** — 密码输入框，`sk-or-v1-...` 格式。仅存本地 localStorage，不上传

### 🪞 中转站 API Key
- **Base URL** — 中转站地址，如 `https://api.treegpt.cc`。从 hostname 自动派生显示名
- **API Key** — 中转站密钥。仅存本地

### 🧪 代码沙盒
- **Sandbox endpoint** — 你的 Mac mini / VPS 地址。`POST {endpoint}/run` 跑代码
- **Sandbox token** — 可选，走 `X-Sandbox-Token` header 鉴权

### ⚙️ 模型库
- **API Provider 切换** — OpenRouter ↔ 中转站，一键全局切换。两边都走 Anthropic 原生 `/v1/messages` 协议，prompt cache 都有。工具迭代轮次也命中历史缓存（标 BP1 + 最后一条 user + 全迭代统一 thinking + 跨迭代回传 thinking block content & signature，2026-06 修正，详见 [caching.md](docs/caching.md)）
- **OR API 格式** — OpenAI 兼容 / Anthropic 兼容。Claude 模型默认走 Anthropic（享受原生 cache_control + 思考链）
- **默认模型** — 从已启用模型里选，新会话自动用这个
- **模型目录搜索** — 搜索 OR 模型目录，启用/停用模型

默认启用：`openrouter/auto`

### 🎛️ 生成参数
- **温度** — 默认 0.7，范围 0 - 2
- **Top P** — 默认 0.9，范围 0 - 1
- **最大 tokens** — 默认 1024，范围 32 - 4000

### 🔮 思考链
- **日常聊天思考链**（默认 ✅ 开）— 控制是否请求 reasoning/thinking chain
- **高触发 Thinking**（默认 ❌ 关）— 仅 GPT-5.1/5.2 生效，更积极触发思考（更慢更耗费）

### 🧩 上下文压缩
- **压缩开关**（默认 ✅ 开）— 总开关
- **触发比例**（默认 0.65）— 历史 token 占上下文窗口比例超过此值时触发。**模型支持工具时上限自动收紧到 0.35**（缩小绝对体量；其原"工具迭代全价重读"的理由在 2026-06 缓存修正后已部分失效，阈值可后续放宽，见 [caching.md](docs/caching.md)）
- **保留最近消息数**（默认 20）— 压缩时保留最近 N 条不动，只摘要更早的
- **Summarizer Provider**（默认 OpenRouter）— 可以让摘要走 OR（便宜模型），聊天走中转
- **Summarizer Model**（默认 `deepseek/deepseek-chat-v3.1`）— DeepSeek 中文摘要稳定，OR 上自带 prompt cache

### 📝 系统提示词
大文本框，填写全局 system prompt。空 = 用模型默认行为。

### 🍪 我的主页提示词
控制"我的主页"（朋友圈）发帖时的 AI 行为叠加层。

### 📓 TA 的主页提示词
- **发帖风格**：控制 Claude 发帖的文风与内容
- **回复风格**：控制 Claude 回复的语气与长度

---

## 📱 页面一览

- **首页 Dashboard** `/` — 顶部小日期 + 打卡卡片 + 横向多页 widget 网格（3 列图标，scroll-snap + 圆点指示器）；长按/编辑进编辑模式 → 加组件 / 拖动 / 增删页 / 上传主页背景图（存 IndexedDB，铺满全页、无边框）
- **聊天** `/chat/:id` — LINE 风格主聊天界面，工具循环 + 流式 + 懒加载
- **设置** `/settings` — 10 个折叠区（详见上方）
- **记忆库** `/memory-vault` — 4 个 tab 各自独立搜索 + 分页（20 条/页）+ 内联编辑；记忆 tab 有来源筛选 / 🔒 锁定 / token 预算提示；时间轴有重要程度筛选 + 关键词搜索
- **我的主页** `/snacks` — 朋友圈帖子 + AI 回复 + 软删除回收站
- **TA 的主页** `/syzygy` — Claude 的朋友圈（对镜版）。头像在聊天 header 同步显示
- **用量统计** `/usage` — 按 provider / 按会话排行 + 缓存命中率
- **健康同步** `/health-sync` — Health Connect → `health_data`（同步状态卡 + 今日体征 grid）、屏幕时间、经期跟踪。APK 限定
- **每日打卡** `/checkin` — 连续打卡 streak + 月历
- **数据导出** `/export` — Markdown/JSON/TXT 格式导出聊天 + 记忆 + 打卡
- **首页布局** `/home-layout` — 编辑首页小组件排列
- **登录** `/auth` — 邮箱 OTP 登录（Supabase Auth）

---

## 架构图

<details><summary>展开架构图（宽 ASCII，手机端默认折叠）</summary>

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
            │           memories_archive, memory_entries, memory_extract_log,
            │           diaries, handoff_letters, timeline,
            │           period_tracking, health_data, essays, usage_logs,
            │           cache_keepalive_state, proactive_queue
            │
            ├─→ edge functions: openrouter-chat, openrouter-models,
            │                   memory-extract, web_search, search_memory,
            │                   search_handoff, tts, netease_search,
            │                   auto_embed (INSERT trigger embedding + 批量 embedding),
            │                   cache_keepalive (缓存保活 ping, pg_cron */5, 安静时段 00-08 北京),
            │                   proactive_dispatch (主动消息兜底派发, pg_cron */5)
            │
            └─→ DB functions: search_memories_hybrid (RPC, 向量+关键词 RRF+近度),
                              find_similar_memory_pairs (RPC, 近重复对扫描, garden_memories 用),
                              bump_memory_access (RPC, 批量更新 access_count + last_accessed_at),
                              get_stale_memories (RPC, 查休眠记忆, check_memory_health 用),
                              archive_memory / restore_memory (记忆软删除, 保留 embedding),
                              auto_embed_* (INSERT trigger, REVOKE'd),
                              soft_delete_user_post / restore_user_post
```

</details>

---

## Supabase 项目要求

启用扩展：
- `vector` (pgvector) — 向量搜索（含 HNSW 索引）
- `pg_trgm` — 三元组 GIN 索引，加速 ILIKE 关键词搜索
- `pg_net` — DB trigger 调 Edge Function（auto embedding）
- `pg_cron` — 定时任务扩展（活跃 job：`cache_keepalive` 缓存保活 + `proactive_dispatch` 主动消息派发，均 */5；FCM 推送已移除）

关键表 schema：
- 全量 schema 在 `supabase/init.sql`（已和线上对齐）
- 增量改动在 `supabase/migrations/*.sql`
- 记忆/工具相关表（memories、memories_archive、diaries、handoff_letters、timeline、朋友圈…）+ `compression_cache` 是**单租户开放 RLS**（`USING (true) WITH CHECK (true)`，by design 因为本项目一个账号自己用）

Edge Functions（已部署，除 cache_keepalive 外均有 `getUser()` JWT 校验）:
- `openrouter-chat` — 聊天主入口 + compression cache
- `openrouter-models` — 拉取模型目录
- `memory-extract` — 从对话提候选记忆（自定义中转站需自带 key，env key 只发默认 OpenRouter base）
- `web_search` — Tavily 代理
- `search_memory` — 记忆混合检索：SiliconFlow embedding + `search_memories_hybrid` RPC（向量 + 关键词 RRF 融合），附带最近经期/健康数据
- `search_handoff` — 交接信向量检索：SiliconFlow embedding + `search_letters` RPC
- `tts` — MiniMax T2A 代理（key 由客户端自带，绕 WebView CORS + 解码 hex 音频）
- `netease_search` — 网易云搜歌代理（`play_music` 工具用）：服务端带浏览器头打 `music.163.com/api/search/get`，返回 `{id,name,artist,duration_seconds}`，绕 WebView CORS
- `auto_embed` — INSERT trigger embedding + 批量 embedding（`records[]` 模式）
- `cache_keepalive` — 缓存保活 ping（pg_cron 每 5min 触发，内部 50min 冷却 → 实际约每小时打一次，~¥0.07 热读；「今日门槛」确保只有当天 08:00 后的真实聊天才激活 ping，不会拿昨晚记录在早上冷写；全天 ping 到午夜，中途聊天自动后延；00:00–08:00 北京安静时段不 ping。ping 必须原样带 `thinking`/`budget_tokens` 才命中聊天缓存血脉，见 [caching.md §9](docs/caching.md)）
- `proactive_dispatch` — 主动消息服务端兜底派发（pg_cron 每 5min）：扫 `proactive_queue` 到点未发的行，原子抢占后写进 `messages`，同步更新 `cache_keepalive_state.body`（追加这条消息，不动 `last_chat_at`），app 关着也照写，见 [docs/features/proactive.md](docs/features/proactive.md)

> 旧 FCM 推送（`send_proactive_push` 函数 + `fcm_tokens` 表）已移除——主动消息走本地通知（`@capacitor/local-notifications`）+ 服务端 `proactive_dispatch` 写库兜底。

DB 函数:
- `search_memories_hybrid(query_embedding, query_keywords, filter_table?, ...)` — 跨表混合检索（向量召回 + 关键词 ILIKE 召回，RRF 融合 + 时间近度小加权）
- `find_similar_memory_pairs(similarity_threshold, max_pairs)` — 扫描近重复记忆对（cosine 相似度），`garden_memories` 工具调用，AI 主动整理用
- `bump_memory_access(ids bigint[])` — 批量递增 `access_count` + 更新 `last_accessed_at`；由 `search_memory`（每次命中）和 `memory-extract`（去重发现重复时）fire-and-forget 调用
- `get_stale_memories(days_inactive, min_days_old, max_count)` — 查询长期未被召回的未锁定记忆，`check_memory_health` 工具调用，AI 判断是否归档
- `archive_memory(id)` / `restore_memory(archive_id)` — 记忆软删除：原子地在 `memories` ⇄ `memories_archive` 间移动（锁定的不归档，归档时保留 embedding）
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

### Android 权限
**minSdkVersion 26**（Android 8.0）— 由 Health Connect plugin 决定。

- `INTERNET` — API 调用
- `ACCESS_FINE/COARSE_LOCATION` — 天气定位
- `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` — 精确定时通知
- `RECEIVE_BOOT_COMPLETED` — 重启后恢复已调度通知
- `WAKE_LOCK` — 通知唤醒屏幕
- `POST_NOTIFICATIONS` — Android 13+ 通知权限
- `CAMERA` + `uses-feature camera(required=false)` — 输入栏 📷 拍照按钮；`required=false` 让无相机的平板也能装
- `VIBRATE` — `@capacitor/haptics` 震动反馈
- `health.READ_STEPS / READ_SLEEP / READ_HEART_RATE / READ_RESTING_HEART_RATE / READ_DISTANCE / READ_TOTAL_CALORIES_BURNED / READ_OXYGEN_SATURATION` — Health Connect 读取（用户在 Health Connect app 中授权后才生效）
- `PACKAGE_USAGE_STATS` — 屏幕使用时间。**特殊 AppOp** — 用户必须在系统设置手动开启
- `QUERY_ALL_PACKAGES` — 让屏幕时间 plugin 拿到其他 app 的显示名（微信 / B站 等）
- **通知使用权**（`BIND_NOTIFICATION_LISTENER_SERVICE`，声明在 `NowPlayingListener` service 上）— `get_now_playing` 读当前播放 + `control_media` 精准控制要用。**特殊权限** — 用户须在「设置 → 通知使用权」手动给 Nimbus 打勾（和屏幕时间同套路，不读任何通知内容）

### Capacitor plugins
- `@capacitor/app`, `@capacitor/device`, `@capacitor/status-bar`, `@capacitor/splash-screen` — 基础生命周期 / 设备信息 / 状态栏 / 启动屏
- `@capacitor/geolocation` — 天气定位
- `@capacitor/local-notifications` — 主动消息（本地通知）
- `@capgo/capacitor-health` — Health Connect 读取
- `@capacitor/haptics` — 震动反馈
- `@capacitor/share` — 长按菜单 → 分享
- `@capacitor/network` — 离线条状态监听
- `@capacitor/camera` — 附件面板 📷 拍照 / 🖼 相册
- **自定义 `MediaControl` plugin** — `play_music` 发 `ACTION_VIEW` Intent 拉起网易云 deep link；`control_media` / `get_now_playing` 走媒体会话（有通知使用权时 `MediaController` 精准控制 + 读元数据，无权限时降级 `AudioManager.dispatchMediaKeyEvent`）。配套空壳 `NotificationListenerService`（`NowPlayingListener`）做通知使用权开关

---

## 文件指南

<details><summary>展开文件树（宽 ASCII + 长注释，手机端默认折叠）</summary>

```
src/
├── App.tsx                    # 主路由 + sendMessage + 20 个工具循环 + 锁定记忆注入 + 每日健康快照注入
├── tools/
│   └── definitions.ts         # 所有 TOOL_* schema 定义（拆出来减肥 App.tsx）
├── plugins/
│   └── MediaControlPlugin.ts  # 自定义 MediaControl 原生插件 TS 桥（control_media 发媒体键）
├── hooks/
│   └── useHomeWidgetData.ts   # 共享 hook：拉今日 health_data / period / 屏幕时间
├── api/
│   ├── openrouter.ts          # 通用 LLM provider fetcher（OR/中转）
│   └── anthropic.ts           # /v1/messages 适配器：OpenAI ⇄ Anthropic 双向（流式 + 非流式 + usage + 图片 base64 + tool_use_id 校验）
├── components/
│   ├── MarkdownRenderer.tsx   # React.memo markdown（content equality）
│   ├── ReasoningPanel.tsx     # 思考链折叠面板（memo）
│   ├── ToolCallCard.tsx       # 工具调用可折叠卡片（图标+名称+参数预览+耗时）
│   ├── VoiceBubble.tsx        # 微信式语音条（点播才合成 MiniMax TTS，object URL 缓存防重复计费）
│   ├── SessionsDrawer.tsx     # 左侧会话抽屉
│   ├── ConfirmDialog.tsx      # 通用确认弹框（支持 children，条件渲染取消按钮）
│   └── LocalAvatar.tsx        # 头像上传（MyHomePage / AssistantHomePage 用）
├── pages/
│   ├── ChatPage.tsx           # 聊天：MessageRow memo + 时间分隔 + 懒加载 + 工具卡片
│   ├── SettingsPage.tsx       # 10 个折叠区（API/模型/参数/思考链/压缩/提示词...）
│   ├── MemoryVaultPage.tsx    # 记忆库 4 tab CRUD（内联编辑 + 分页）
│   ├── UsagePage.tsx          # 用量统计
│   ├── MyHomePage.tsx         # 我的主页（朋友圈）
│   ├── AssistantHomePage.tsx  # TA 的主页（对镜版）
│   ├── HomePage.tsx           # 首页 dashboard：多页 widget grid（无 dock）+ 编辑模式
│   ├── HomeLayoutSettingsPage.tsx  # /home-layout 深度编辑
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
│   ├── proactiveNotification.ts  # 本地通知调度 + cancel/re-arm（title 走 assistantPersona）；PendingProactive 带 queueId 对接服务端 proactive_dispatch 兜底
│   ├── assistantPersona.ts    # 助手显示名（默认"哥哥"，可在聊天 ⚙️ 菜单改）
│   ├── supabaseSync.ts        # 远程 CRUD（sessions/messages/checkins/overrides）
│   ├── supabaseConfig.ts      # 本地 Supabase URL/key 配置
│   ├── sandbox.ts             # 代码沙盒（带 https/http 协议校验）
│   ├── statusBar.ts           # Android StatusBar 跟随页面 bg
│   ├── homeLayout.ts          # 首页布局（pages[] + 迁移逻辑 + IndexedDB 图片）
│   ├── openrouterPricing.ts   # 模型定价（24h 缓存）
│   ├── stickers.ts            # 表情包：共享贴纸集（[sticker:名字]，名称用反引号包裹防注入）
│   ├── ttsConfig.ts           # MiniMax TTS 配置（key 仅存 localStorage）
│   ├── imageCaptions.ts       # 图片→文字描述缓存（历史图片转述省 token，保 prompt cache 稳定）
│   ├── imageUpload.ts         # 图片压缩 + Supabase Storage 上传
│   └── periodWidget.ts        # 把经期数据推给原生桌面小组件（PeriodWidget plugin 桥）
└── supabase/
    └── client.ts              # supabase 单例 + 本地配置覆盖

android/app/src/main/java/com/cocoraina/nimbuschat/
├── MainActivity.java          # Capacitor BridgeActivity + 注册自定义 plugin
├── UsageStatsPlugin.java      # 自定义 plugin：UsageStatsManager 读今日 app 使用时长
├── ShareReceiverPlugin.java   # 接收系统分享的文本（队列存储，防连续分享覆盖）
├── PeriodWidgetPlugin.java    # 把经期数据写进 SharedPreferences + 刷新桌面小组件
├── PeriodCalc.java            # 共享：从 prefs 读经期数据、按 UTC 纯日期算相位/天数
├── PeriodWidgetProvider.java  # 桌面小组件：经期卡（AppWidgetProvider）
├── PetWidgetProvider.java     # 桌面小组件：emoji 桌宠
├── ComboWidgetProvider.java   # 桌面小组件：2×1 组合卡（日期+经期+Clawd 螃蟹，apply→commit 消除并发窗口）
├── MediaControlPlugin.java    # 自定义 plugin：play_music deep link + control_media/get_now_playing（MediaSession 精准控制 + 读当前歌，降级媒体键）
└── NowPlayingListener.java    # 空壳 NotificationListenerService：只做通知使用权开关，开了 getActiveSessions() 才返回别家媒体会话

android/app/src/main/res-crab/drawable-nodpi/   # Clawd 螃蟹精灵帧（24 动画×40 帧，独立资源目录，见 build.gradle sourceSets）
```

</details>

---

## 已知限制 / 未做

- **白天只有早晨第一条冷写** — 安静时段（00:00–08:00 北京）不 ping，缓存夜里过期；早上第一条消息冷写一次（~¥1.5），之后 ping 全天跟随、中途聊天自动后延，直到午夜。每天固定成本：¥1.32 冷写 + ~¥1.3 全天热读 ping ≈ ¥2.6，无午后额外冷写。安静时段除了省钱还顺带**防熬夜**：深夜聊天没缓存保温、每条都冷写更贵，等于给夜聊加了点「摩擦」劝退。见 [caching.md §9](docs/caching.md)
- **单租户 RLS** — 工具表用开放策略，只适合一个账号自用
- **iOS** — 通知 / 状态栏 / 硬件返回键都有 Android-only 守卫，未测试 iOS
- **原生 dialog** — 绝大部分已用 `ConfirmDialog` 替换；偶有遗漏页面仍用 `window.confirm`

## 历史 / 想做但暂缓

- 🎤 内置语音输入 — 已移除：`@capacitor-community/speech-recognition` 在 Android 11+ 因缺 `RecognitionService` `<queries>` 声明静默失效，与输入法自带语音重复，改用输入法（依赖和 `RECORD_AUDIO` 权限已清理）
- 暗黑模式 — 试过，各页面硬编码颜色太分散，做一半撤了
- 端到端加密消息存储
- Anthropic Code Execution 工具（需要 BYOK 直连）
