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
- `web_search` — 网页搜索（Tavily API via `supabase/functions/web_search/`，函数体内有显式 `getUser()` JWT 校验做 defense-in-depth）

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
- 客户端先校验 endpoint 协议必须是 `http(s)://`，防止手抖配错 URL

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
1. 后台用**当前激活的模型**，带上**包括 Claude 最新回复在内的完整上下文**，让 Claude 自己决定"多久后找你 + 说什么"
2. Claude 返回 JSON `{"delay_minutes": 25, "text": "..."}`，延迟范围 15 分钟 ~ 8 小时
3. 按 Claude 选的时间调度一条**本地通知**（走 Android NotificationChannel `proactive`）
4. 你点通知打开 app → 自动把 Claude 预生成的那句话作为正式 assistant 消息写进 DB
5. 你在通知到之前回 app → pending 保留、通知继续等（不再像以前一样提前清掉）
6. 发新消息 → 旧通知取消 + 旧 pending 清空 + 生成新的
7. 凌晨 0 点 ~ 7 点不做 pre-gen、不发通知（不烧 API、不吵人）
8. 如果 Claude 选的延迟会落在 0 点之后 → 不调度

如果模型返回的不是合法 JSON → 退回到 60 分钟固定延迟 + 整段响应当文本

代码：
- 调度 + 通道：`src/storage/proactiveNotification.ts`（`shouldScheduleProactive(delayMs?)` / `scheduleProactiveNotification(text, delayMs?)`）
- 通道创建：`src/main.tsx`（`LocalNotifications.createChannel({ id: 'proactive' })`）
- 预生成：`src/App.tsx` 中 sendMessage 结束 hook，prompt 要求返回 `{delay_minutes, text}` JSON
- 注入回复：visibilitychange 监听 + `insertPendingProactiveRef`

### ✏️ 用户消息编辑
- 长按消息 → 编辑
- 提交后**替换那条消息 + 删除之后所有 AI 回复 + 重新生成**
- 代码：`src/App.tsx` 中 `editUserMessage`、`src/pages/ChatPage.tsx` 中 `handleEdit`

### 🔄 重新生成 / 引用 / 复制
长按消息呼出操作菜单（复制 / 引用 / 重新生成 / 编辑 / 删除）。代码：`src/pages/ChatPage.tsx`

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
- 性能：MarkdownRenderer / ReasoningPanel / **MessageRow** 都用 React.memo，几百条消息打字也不卡
- 路由按需加载（除 ChatPage / AuthPage 外都 `lazy()`），主 bundle 750→639 KB
- 时间戳从 system prompt 挪到每条 user message（用 message.createdAt 保证不变）——避免破坏 prompt cache
- HomePage 的 1Hz 时钟 tick 在 `document.hidden` 时停,锁屏/切到后台不再每秒唤醒整棵树

### 💬 聊天界面交互
- **气泡分组**:同人 1 分钟内连发的消息紧贴（3px gap），换人或间隔大就拉开（12px）
- **居中时间分隔**:第一条消息或前后间隔 >5 分钟才显示一行"14:23 / 昨天 21:30 / 5月20日 14:23"
- **一条消息 = 一个气泡**:Claude 回复默认整段一个气泡。需要"短句串"效果在回复里用 `[NEXT]` 显式拆（系统 prompt 没默认加这个指令，要的话自己写）
- **懒加载**:进入聊天只渲染最近 30 条，顶部出"加载更早（剩余 N 条）"按钮，点一下再加载 30 条；切 session 重置
- **header 副标题**:显示当前模型名（替代"单聊"），一眼能看到聊天在用哪个模型
- **聊天操作菜单**:本对话设置(思考链 toggle + 📦 手动压缩对话) + 导航到其他页
- **手动压缩对话**:不用等阈值，强制摘要一次，写入 `compression_cache`，下次发送自动用紧凑上下文（≥8 条消息才有意义）
- 长按消息 / 右键消息出操作菜单（复制/引用/重新生成/编辑/删除）
- 代码：`src/pages/ChatPage.tsx`（MessageRow / TimeSeparator / formatSeparatorTime）

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
            ├─→ tables: messages, sessions, checkins, user_settings,
            │           compression_cache, user_posts, user_replies,
            │           assistant_posts, assistant_replies, memories,
            │           diaries, handoff_letters, timeline,
            │           period_tracking, health_data, essays, usage_logs
            │
            ├─→ edge functions: openrouter-chat, openrouter-models,
            │                   memory-extract, web_search
            │
            └─→ DB functions: search_memories (RPC, 跨表向量搜),
                              auto_embed_* (INSERT trigger),
                              soft_delete_user_post / restore_user_post
```

GitHub Pages **只在用户首次访问**时分发静态资源给浏览器。运行时 GitHub 不参与。

---

## Supabase 项目要求

启用扩展：
- `vector` (pgvector) — 向量搜索
- `pg_net` — DB trigger 调 Edge Function（auto embedding）

关键表 schema：
- 全量 schema 在 `supabase/init.sql`（已和线上对齐）
- 增量改动在 `supabase/migrations/*.sql`
- 6 张工具表（`memories` / `diaries` / `handoff_letters` / `timeline` / `period_tracking` / `health_data`）+ `compression_cache` 是**单租户开放 RLS**（`USING (true) WITH CHECK (true)`,只有 `authenticated` 角色，by design 因为本项目就是一个账号自己用）。要做多租户得给这些表加 `user_id` 列并改 policy 成 `user_id = auth.uid()`

Edge Functions（已部署，源码在 `supabase/functions/`）:
- `openrouter-chat` — 聊天主入口，处理 compression cache + RP module + 多 provider 路由
- `openrouter-models` — 拉取 OR 模型目录
- `memory-extract` — 后台从对话里提候选记忆（pending 状态等用户确认）
- `web_search` — Tavily 代理，函数体内显式 `getUser()` JWT 校验

DB 函数（不是 edge function）:
- `search_memories(query_embedding, ...)` — 跨表向量 UNION 搜
- `auto_embed_memory / auto_embed_diary / ...` — INSERT trigger 自动生成向量（已 `REVOKE EXECUTE FROM public, anon, authenticated`，防止陌生人当 RPC 直接调来烧 embedding 配额）
- `soft_delete_user_post / restore_user_post / soft_delete_user_reply` — 软删除朋友圈 RPC

需要的 Secrets（Supabase Dashboard → Edge Functions Secrets）:
- `TAVILY_API_KEY` — Tavily 搜索 API key
- `SILICONFLOW_API_KEY` — 向量化 API（被 search_memory edge function 用）
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — Supabase 默认注入

---

## 部署

### Web (GitHub Pages)
- push 到 main → GitHub Actions 自动 build + deploy
- 用 `BUILD_TARGET=pages` 让 vite base 设为 `/Nimbus-Chat/`
- workflow：`.github/workflows/deploy-pages.yml`
- Secrets 需要：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`

### Android APK (Capacitor)
- push 到 main 或打 `v*` tag 触发 build；产物在 Actions Run → Artifacts → `nimbus-chat-apk`
- workflow：`.github/workflows/build-apk.yml`
- **签名 release APK**(走稳定 keystore 从 GitHub Secrets 解出来)，覆盖安装会被识别为升级，**数据不丢、不要求重新登录**
- 资产生成：`npx capacitor-assets generate --android`（基于 `assets/icon.png`）

所需 GitHub Secrets:
- `ANDROID_KEYSTORE_BASE64` — keystore 的 base64
- `ANDROID_KEYSTORE_PASSWORD` — store 密码(**必须 ASCII**,Java PKCS12 PBE 拒收非 ASCII)
- `ANDROID_KEY_PASSWORD` — key 密码(同上)
- `ANDROID_KEY_ALIAS` — 别名(默认 `nimbus`)

CI 在跑 gradle 之前会:
1. 把 base64 解出来,验证 keystore 能 parse,alias 存在
2. 用 `keytool -certreq` 真的取一次私钥,验证 key password 对得上
3. 两个密码做纯 ASCII 预检,非 ASCII 字符立刻拒绝(否则会在 2 分钟后的 gradle 签名步骤才报错)

### Service Worker
- 仅在 PWA 模式注册（`Capacitor.getPlatform() === 'web'`）
- APK 内不注册（资源已打包，不需要 SW 缓存）
- 版本：`public/sw.js` 顶部的 `SW_VERSION` —— 重大变更时手动 bump 强制失效

---

## 文件指南

```
src/
├── App.tsx                    # 主路由 + sendMessage + 工具循环（~2700 行）
├── api/
│   └── openrouter.ts          # 通用 LLM provider fetcher（OR/中转）
├── components/
│   ├── MarkdownRenderer.tsx   # React.memo 包装的 markdown（content equality）
│   ├── ReasoningPanel.tsx     # 思考链可折叠面板（memo）
│   ├── SessionsDrawer.tsx     # 左侧会话抽屉
│   ├── ConfirmDialog.tsx
│   └── LocalAvatar.tsx        # 头像上传组件（用于 MyHomePage / AssistantHomePage）
├── pages/
│   ├── ChatPage.tsx           # 主聊天界面 + MessageRow memo + 时间分隔 + 懒加载
│   ├── SettingsPage.tsx       # 全部配置
│   ├── MemoryVaultPage.tsx    # 4 张记忆表的 CRUD UI
│   ├── UsagePage.tsx          # 按 provider + 按会话用量
│   ├── MyHomePage.tsx         # 我的主页（朋友圈帖子 + AI 回复）
│   ├── AssistantHomePage.tsx  # Claude 主页（同上对镜版）
│   ├── HomePage.tsx           # 首页 dashboard + 小组件
│   ├── HomeLayoutSettingsPage.tsx # 首页布局编辑
│   ├── ExportPage.tsx         # 导出对话
│   ├── CheckinPage.tsx        # 每日打卡
│   ├── AuthPage.tsx           # 邮箱 OTP 登录
│   └── SupabaseSetupPage.tsx  # 首次配置 Supabase URL/key
├── storage/
│   ├── apiProvider.ts         # OR / 中转切换 + base URL 派生名
│   ├── openrouterKey.ts       # OR API key
│   ├── usageStats.ts          # usage_logs 读写
│   ├── userSettings.ts        # 用户设置（DB 表 + 部分 localStorage）
│   ├── conversationCompression.ts  # 摘要 + cache（带 force flag 给手动按钮用）
│   ├── weather.ts             # Open-Meteo 拉天气 + 缓存
│   ├── proactiveNotification.ts  # 本地通知调度
│   ├── sandbox.ts             # 未来 Mac mini sandbox 调用（带 https/http 协议校验）
│   ├── statusBar.ts           # Android StatusBar 跟随当前页 bg
│   ├── homeLayout.ts          # 首页布局 + 小组件配置（IndexedDB 存大数据）
│   └── imageUpload.ts         # 图片压缩 + Supabase Storage 上传
└── supabase/
    └── client.ts              # supabase 单例 + 本地配置覆盖
```

---

## 已知限制 / 未做

- **后台 keepalive**：app 关闭后 timer 不跑，下次开 app 第一条可能要付 cache 重写费（~$0.10）
- **单租户 RLS**：6 张工具表 + `compression_cache` 用的是 `USING (true)` 开放策略，**只适合一个账号自己用**。要做多租户需要给这些表加 `user_id` 列并改 policy
- **iOS**：硬件返回 / 状态栏跟随 / 本地通知 都包在 `getPlatform() === 'android'` 守卫里，iOS 端这些功能不工作（用户只发 Android）
- **Mac mini 集成**：契约就绪但服务端未实现，等用户买了 Mac mini 自己写
- **Google Fit API**：已弃用（2025-2026 关停），不要再接
- **Health Connect 自动同步**：需要 MacroDroid / Tasker 等工具配置 5 分钟，未来配
- **`window.confirm/prompt/alert`**：MyHomePage / AssistantHomePage / MemoryVaultPage 还在用,Android WebView 弹原生 dialog 会带 origin URL,看起来不够干净。重构成共用 `ConfirmDialog` 是个待办

---

## 历史 / 想做但暂缓

- 语音输入（Web Speech API） — 半小时即可
- 语音输出（TTS） — 半小时
- 暗黑模式 — 中等工作量
- 端到端加密的消息存储 — 技术上行但"忘密码=数据全没"太重
- Anthropic Code Execution 工具 — 要 BYOK 直连，目前走 OR 不支持
- 服务端 cron 主动消息推送 — 当前是 PWA 本地通知，没有真 server-side push
