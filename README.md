# Nimbus Chat

自托管的私人 AI 陪伴应用 —— 一个能记住你的事、写日记、控制智能家居（未来）的 Claude。（完全依托于串串老师的开源程序修改~感谢老师）

原README：项目简介 Nibble-Chat 是一个自托管的聊天小工具。前端部署在 GitHub Pages；数据存储与多端同步由用户自行创建的 Supabase 项目提供。本项目不提供中心化服务器，你的数据只在你自己的 Supabase 里。

详细教程请查看：https://pan.baidu.com/s/1xv6jAOLd2fLeOwE8pPdohw?pwd=vyfr 提取码：vyfr

本项目不提供公共后端。请先创建你自己的 Supabase 项目，并在应用内 Setup 页面填写 URL/anon key。

部署：**GitHub Pages**（PWA）+ **Android APK**（Capacitor 打包）
后端：你自己的 **Supabase** 项目（数据库 + 认证 + Edge Functions）
LLM：**OpenRouter** 主用 + **任意中转站** 备用，可全局切换

---

## 功能清单

### 🔌 多 LLM 提供商
- **OpenRouter**（主），走 BYOK 或 OR 账户
- **任意 OpenAI 兼容中转站**（备用，从 base URL 自动派生显示名，例如 "msuicode" / "treegpt"）
- 设置页 → 模型库 第一行一键切换
- 压缩 summarizer 可独立选 provider（聊天走中转，摘要走 OR 免费模型）
- 代码：`src/storage/apiProvider.ts`、`src/api/openrouter.ts`

### 🧠 记忆系统（Claude 的"灵魂"）
4 张专用表 + 朋友圈作为长期记忆：
- `memories` — 偏好/习惯/关系细节，向量检索
- `diaries` — 日记，向量检索
- `handoff_letters` — 交接信（上一个窗口的 Claude 写给下一个窗口）
- `timeline` — 重大里程碑事件
- `user_posts` / `user_replies` — 朋友圈帖子和回复也进入语义搜索

附带结构化数据自动一起返回：
- `period_tracking` — 经期记录（最近 10 条）
- `health_data` — 健康指标（最近 7 天）

实现：Supabase Edge Function `search_memory` 嵌入查询（BGE-M3 via SiliconFlow）→ `search_memories` RPC 跨表 UNION 向量搜 → 加上结构化数据一起返回。
代码：`supabase/functions/search_memory/`、DB function `search_memories(query_embedding, ...)`

### 🛠️ Claude 工具（共 9 个）

**读取（Claude 主动调）**：
- `search_memory` — 跨表语义搜索 + 结构化数据
- `web_search` — 网页搜索（Tavily API via `supabase/functions/web_search/`）

**写入（用户明确要求时调）**：
- `add_memory` — 写一条结构化记忆
- `write_diary` — 替你写日记
- `write_handoff_letter` — 写交接信
- `add_timeline_event` — 加重要事件到时间轴
- `log_period` — 记录经期数据
- `log_health` — 记录睡眠/步数/心率/状态

**计算（未来用）**：
- `run_code` — 通过用户配置的代码沙盒（Mac mini / VPS）跑 Python/JS
- 协议契约：`POST {endpoint}/run` + `X-Sandbox-Token` header，详见 设置 → 代码沙盒

工具定义和分发逻辑：`src/App.tsx` 头部的 `TOOL_*` 常量 + `sendMessage` 内的工具循环

### 💰 成本优化
- **Anthropic Prompt Caching**：1 小时 TTL（写贵 2x，读 0.1x），Claude on OR 自动启用
- **Keepalive ping**：cache 快到期前发 `max_tokens:0` 的空 ping 续命，省下重新计算费用
- 只在活跃时间（7:00-23:00）发，凌晨不烧钱
- **对话压缩**：历史超阈值时自动用 summarizer 模型摘要，节省 token
- 设置可单独选 summarizer 的 provider 和 model（推荐 OR 的免费 Llama）
- 实现：`src/App.tsx` 中 `scheduleKeepalive`、`src/storage/conversationCompression.ts`

### 🌤️ 天气接入
- 每天**第一条**用户消息自动附带当前天气（地理位置 + Open-Meteo API，无需 key）
- 通过 message.meta 持久化到该消息，请求构建时拼接，**保持 prompt cache 稳定**
- UI 不显示，只塞给 LLM
- 代码：`src/storage/weather.ts`

### 🔔 真·主动消息（APK 限定）
你每发一条消息：
1. 后台用**当前激活的模型**预生成"假设 1h 后你没回我会说啥"
2. 把生成的真实文字作为 60 分钟后的**本地通知**调度
3. 你点通知打开 app → 自动把这句话作为 Claude 的实际回复展示在聊天里
4. 你 1h 内回 app / 发新消息 → 通知撤销 + 丢弃预生成（避免人工痕迹）
5. 凌晨 0-7 点跳过整套（不发通知、不烧 API）

代码：
- 调度：`src/storage/proactiveNotification.ts`
- 预生成：`src/App.tsx` 中 sendMessage 结束 hook
- 注入回复：visibilitychange 监听 + `insertPendingProactiveRef`

### ✏️ 用户消息编辑
- 长按 ••• → 编辑
- 提交后**替换那条消息 + 删除之后所有 AI 回复 + 重新生成**
- 代码：`src/App.tsx` 中 `editUserMessage`、`src/pages/ChatPage.tsx` 中 `handleEdit`

### 🔄 重新生成 / 引用 / 复制
都在每条消息的 ••• 三点菜单里。代码：`src/pages/ChatPage.tsx`

### 📊 用量统计
- 按 provider 分面板（OR / 中转站）
- 按会话排行（哪段聊天烧 token 最多）
- 显示缓存命中率
- 故意**不显示估算花费**——价格交给提供商网站
- 代码：`src/pages/UsagePage.tsx`、`src/storage/usageStats.ts`

### 🖼️ 图片上传
- 客户端压缩（1568px，0.85 JPEG）
- 存 Supabase Storage `chat-images` bucket
- OpenRouter 多模态消息格式：`{type: 'image_url', image_url: {url}}`
- 代码：`src/storage/imageUpload.ts`

### 🩹 各种 polish
- 后台返回后 stuck stream 自动恢复（基于 `lastChunkAtRef` 8 秒判定）
- 性能：MarkdownRenderer 和 ReasoningPanel 用 React.memo
- 路由按需加载（除 ChatPage / AuthPage 外都 `lazy()`），主 bundle 750→639 KB
- 时间戳从 system prompt 挪到每条 user message（用 message.createdAt 保证不变）——避免破坏 prompt cache

---

## 架构图

```
                     用户的浏览器 / APK
                       │   │   │   │
            ┌──────────┘   │   │   └─────────────┐
            ▼              ▼   ▼                  ▼
       Supabase         OR / Kiro / 中转       Mac mini (未来)
   (数据库 + 认证          (LLM 推理)         (sandbox + 智能家居)
    + Edge Functions)
            │
            ├─→ tables: messages, sessions, memories, diaries,
            │           handoff_letters, timeline, user_posts,
            │           user_replies, period_tracking, health_data,
            │           usage_logs, compression_cache
            │
            └─→ functions: search_memory, web_search, log_health,
                           auto_embed
```

GitHub Pages **只在用户首次访问**时分发静态资源给浏览器。运行时 GitHub 不参与。

---

## Supabase 项目要求

启用扩展：
- `vector` (pgvector) — 向量搜索
- `pg_net` — DB trigger 调 Edge Function（auto embedding）

关键表（在 dashboard 自建或通过 migration 创建）：
- 见 `supabase/migrations/` 历史 + Supabase Studio 表结构

Edge Functions（已部署）：
- `search_memory` — 语义查询
- `web_search` — Tavily 代理
- `log_health` — Health Connect 数据接入（外部 token 鉴权）
- `auto_embed` — 自动向量化（DB trigger 触发）

需要的 Secrets：
- `TAVILY_API_KEY` — Tavily 搜索 API key
- `HEALTH_INGEST_TOKEN` — 外部 POST /log_health 的鉴权 token
- `SILICONFLOW_API_KEY` —（已硬编码在 Edge Functions 里）向量化 API

---

## 部署

### Web (GitHub Pages)
- push 到 main → GitHub Actions 自动 build + deploy
- 用 `BUILD_TARGET=pages` 让 vite base 设为 `/Nimbus-Chat/`
- workflow：`.github/workflows/deploy-pages.yml`
- Secrets 需要：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`

### Android APK (Capacitor)
- push 到 main 触发 build；产物在 Actions Run → Artifacts → `nimbus-chat-apk`
- workflow：`.github/workflows/build-apk.yml`
- 调试版（debug APK），未签名，sideload 安装
- 资产生成：`npx capacitor-assets generate --android`（基于 `assets/icon.png`）

### Service Worker
- 仅在 PWA 模式注册（`Capacitor.getPlatform() === 'web'`）
- APK 内不注册（资源已打包，不需要 SW 缓存）
- 版本：`public/sw.js` 顶部的 `SW_VERSION` —— 重大变更时手动 bump 强制失效

---

## 文件指南

```
src/
├── App.tsx                    # 主路由 + sendMessage + 工具循环（2000+ 行）
├── api/
│   └── openrouter.ts          # 通用 LLM provider fetcher（OR/中转）
├── components/
│   ├── MarkdownRenderer.tsx   # React.memo 包装的 markdown
│   ├── ReasoningPanel.tsx     # 思考链可折叠面板
│   └── ConfirmDialog.tsx
├── pages/
│   ├── ChatPage.tsx           # 主聊天界面 + 长按菜单
│   ├── SettingsPage.tsx       # 全部配置
│   ├── MemoryVaultPage.tsx    # 4 张记忆表的 CRUD UI
│   ├── UsagePage.tsx          # 按 provider + 按会话用量
│   ├── SnackPage.tsx          # 朋友圈
│   ├── MyHomePage.tsx         # 我的主页（mimi）
│   ├── AssistantHomePage.tsx  # Claude 主页
│   ├── HomePage.tsx           # 首页 dashboard
│   ├── UsagePage.tsx
│   ├── ExportPage.tsx         # 导出对话
│   └── CheckinPage.tsx
├── storage/
│   ├── apiProvider.ts         # OR / 中转切换 + base URL 派生名
│   ├── openrouterKey.ts       # OR API key
│   ├── usageStats.ts          # usage_logs 读写
│   ├── userSettings.ts        # 用户设置（DB 表 + 部分 localStorage）
│   ├── conversationCompression.ts  # 摘要 + cache
│   ├── weather.ts             # Open-Meteo 拉天气 + 缓存
│   ├── proactiveNotification.ts  # 本地通知调度
│   ├── sandbox.ts             # 未来 Mac mini sandbox 调用
│   └── imageUpload.ts         # 图片压缩 + Supabase Storage 上传
└── supabase/
    └── client.ts              # supabase 单例 + 本地配置覆盖
```

---

## 已知限制 / 未做

- **后台 keepalive**：app 关闭后 timer 不跑，下次开 app 第一条可能要付 cache 重写费（~$0.10）
- **iOS PWA**：状态栏处理 / 长按某些场景未测试（用户在华为安卓上）
- **Mac mini 集成**：契约就绪但服务端未实现，等用户买了 Mac mini 自己写
- **Google Fit API**：已弃用（2025-2026 关停），不要再接
- **Health Connect 自动同步**：需要 MacroDroid / Tasker 等工具配置 5 分钟，未来配

---

## 历史 / 想做但暂缓

- 语音输入（Web Speech API） — 半小时即可
- 语音输出（TTS） — 半小时
- 暗黑模式 — 中等工作量
- 端到端加密的消息存储 — 技术上行但"忘密码=数据全没"太重
- Anthropic Code Execution 工具 — 要 BYOK 直连，目前走 OR 不支持
- 服务端 cron 主动消息推送 — 当前是 PWA 本地通知，没有真 server-side push
