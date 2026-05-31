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
- **任意 OpenAI 兼容中转站**（备用，从 base URL 自动派生显示名，例如 "treegpt" / "msuicode"）
- 设置页 → 模型库 第一行一键切换
- 压缩 summarizer 可独立选 provider（聊天走中转，摘要走 OR 免费模型）

### 🧠 记忆系统（Claude 的"灵魂"）
4 张专用表 + 朋友圈作为长期记忆：
- `memories` — 偏好/习惯/关系细节，向量检索
- `diaries` — 日记，向量检索
- `handoff_letters` — 交接信（上一个窗口的 Claude 写给下一个窗口）
- `timeline` — 重大里程碑事件
- `user_posts` / `user_replies` — 朋友圈帖子和回复也进入语义搜索

附带结构化数据自动一起返回：
- `period_tracking` — 经期记录（最近 10 条）
- `health_data` — 健康指标（步数 / 睡眠小时 / 平均心率 / 静息心率 / 血氧均值，按日期 upsert，最近 7 天给 Claude）

实现：Supabase Edge Function `search_memory` 嵌入查询（BGE-M3 via SiliconFlow）→ `search_memories` RPC 跨表 UNION 向量搜（支持 `filter_table` 参数限定来源）→ 加上结构化数据一起返回。

### ✨ 自动记忆提取（参考 Hamster-Nest）
从聊天对话中自动提取长期记忆，无需手动录入。

**自动提取**（轮次触发，参考串串老师 Hamster-Nest 实现）：
- 每 **12 轮用户发言**自动触发一次（按对话分开计数）
- **10 分钟冷却**，不会频繁触发
- 待确认记忆 **≥ 50 条**时暂停，等用户处理后恢复
- 取当前对话最近 **24 条消息**送给 LLM 分析

**手动提取**（记忆库 → 立即提取）：
- 优先用当前打开的对话消息
- 没打开过聊天页时，fallback 从 DB 拉最近 24 条（串串老师没有此 fallback）

**确认流程**：
```
提取 → memory_entries 表（status=pending）
     → 记忆库「待确认」黄色卡片
     → 逐条「确认」/ 「忽略」/ 「全部确认」
     → 确认后写入 memories 表（category=自动提取）→ 生成 embedding → AI 可检索
```

**设置**（设置页 → ✨ 自动记忆提取）：
- 总开关（默认开启）
- 提取提供商（OR / 中转站，可以和聊天分开走 —— 比如聊天走中转，提取走 OR）
- 提取模型（从已启用模型中选，推荐便宜的小模型如 Haiku）

**来源标记**：
- 记忆/时间轴列表项右侧显示 ✨ 标记区分自动提取 vs 手动录入
- 来源筛选 chips：全部 / 手动 / ✨自动

### 🛠️ Claude 工具（共 11 个）

**读取（Claude 主动调）**：
| 工具 | 说明 |
|------|------|
| `search_memory` | 跨 6 张表向量语义搜索。可选 `table` 参数限定只搜某个来源（memory/diary/letter/timeline/snack_post/snack_reply） |
| `search_handoff` | 专门搜交接信（长文在混合搜索里容易被挤出去） |
| `web_search` | 网页搜索（Tavily API），用于时效性/事实性问题 |

**写入（用户明确要求时调）**：
| 工具 | 说明 |
|------|------|
| `add_memory` | 写一条结构化记忆（偏好/习惯/关系细节） |
| `write_diary` | 替你写日记（date + title + mood + content） |
| `write_handoff_letter` | 写交接信给下一个窗口 |
| `add_timeline_event` | 加重大事件到时间轴（importance 1-5） |
| `log_period` | 记录经期数据 |
| `log_health` | 记录睡眠/步数/心率/状态，按日期 upsert |

**计算 + 调度**：
| 工具 | 说明 |
|------|------|
| `run_code` | 通过用户配的代码沙盒跑 Python/JS（需配 endpoint） |
| `schedule_proactive_message` | 预设一条未来主动消息（1-1440 分钟 / 最长 24h；带可选 `persist` 区分"普通 ping"和"叫起床这种不可取消提醒"）。仅 APK，web 不可用 |

每次工具调用会被记录在消息的 `meta.tool_calls` 里，聊天界面显示为**可折叠的工具卡片**（类似 claude.ai）：图标 + 工具名 + 参数预览 + 耗时，点击展开看完整参数和返回结果。

### 💰 成本优化
- **Anthropic Prompt Caching**：1 小时 TTL（写贵 2x，读 0.1x），Claude on OR 自动启用
- **Keepalive ping**：cache 快到期前发 `max_tokens:0` 的空 ping 续命（8:00-23:00 活跃时段）
- **对话压缩**：历史超阈值时自动用 summarizer 模型摘要，节省 token
- 设置可单独选 summarizer 的 provider 和 model（推荐 OR 的免费模型）

### 🌤️ 天气接入
- 每天**第一条**用户消息自动附带当前天气（地理位置 + Open-Meteo API，无需 key）
- 通过 message.meta 持久化到该消息，请求构建时拼接，**保持 prompt cache 稳定**
- UI 不显示，只塞给 LLM

### 🔔 真·主动消息（APK 限定）
Claude 有一个工具 `schedule_proactive_message`，可以在聊天中**自主判断**是否要预设一条未来的主动消息。

**工作方式**：
1. 聊天过程中，Claude 根据对话气氛判断用户是否要离开
2. 如果判断合适，Claude 主动调用 `schedule_proactive_message(text, delay_minutes, persist?)` 工具
3. 工具处理器调度一条**本地通知** + 写入 `proactive_queue` 表（FCM 备用，默认不会真发出去）
4. delay_minutes 由 Claude 自己决定（1-1440 分钟，最长 24 小时，覆盖到次日叫起床场景），根据场景灵活选择
5. 你点通知打开 app → 自动把预设的话作为正式 assistant 消息写进 DB
6. 你在通知触发前回 app 发了新消息 → 旧 transient 通知取消 + 旧 pending 清空 + 旧 queue 行删除
7. **Claude 在这条新回复时会收到一段系统提示**："你之前预约的『XX』（原定 HH:MM）已被自动取消，自行判断要不要重新预约"。它可能再次调用工具续一条新的，也可能判断对话已经转向而不续

**Transient vs Persist 两类通知**：
- **Transient（默认）**：「如果你不回来我才需要找你」型。你一发新消息就被自动取消。Notification ID = 1001，storage = `nimbus_pending_proactive_v1`
- **Persist（`persist: true`）**：用户明确预约的不可取消提醒（叫起床、定时喝水、明天某时待办）。即使你回来聊天也保留，到点必响。Notification ID = 1002，storage = `nimbus_persist_proactive_v1`
- Claude 只在你**明确说**"提醒我/叫醒我/到点告诉我"时才设 `persist: true`，不会主动加

**Claude 不会每轮都调** — 工具描述里约束了：
- 用户要去做事/休息/离开、需要次日提醒/起床 → 适合调用
- 深度情绪交流当下 → 不调用
- 用户说"别打扰" → 不调用
- （以前有 23:00-07:00 quiet hours，已取消 — 让 Claude 凭对话上下文判断更自然，也方便它当起床闹钟）

**FCM 服务端推送**（默认完全关闭）：
- 代码保留：`proactive_queue` 表 + `send_proactive_push` Edge Function 仍在仓库里
- pg_cron 任务 `send-proactive-pushes`（id=1）已 `active=false`，不再每分钟空跑
- 启用方法：
  1. 取消 `src/main.tsx` 中 PushNotifications 注册的注释
  2. 添加 `GOOGLE_SERVICES_JSON` GitHub Secret
  3. `SELECT cron.alter_job(1, active := true);` 重启 cron

### 🫀 健康同步（Health Connect → health_data）
让 Claude 知道你今天走了多少步、睡了多久、心率多少 —— 不靠手动告诉它，自动从手机健康数据里拉。

**数据链路（华为示例）**：
```
华为手环 → 华为运动健康 → Health Sync（第三方桥接）→ Health Connect → Nimbus
```
Health Connect 是 Android 14+ 系统级（13- 需装 Google 的 Health Connect app）。任何能写入 Health Connect 的数据源（小米运动 / 苹果以外的可穿戴 / Samsung 健康）都行，华为通过 Health Sync 走这条桥。

**前端用 `@capgo/capacitor-health` v8 plugin**（仅 APK），声明的权限：steps / sleep / heartRate / restingHeartRate / distance / totalCalories / oxygenSaturation，全部 read-only，不会写回。

**同步规则**（`src/storage/healthSync.ts`）：
- 拉最近 3 天的样本（覆盖跨夜 / 同步延迟）
- 按本地日期聚合：
  - 步数 = 累加 (按 startDate)
  - 睡眠 = 累加段时长 → 小时 (按 endDate, 跳过 awake/inBed)
  - 心率 = 算术均值
  - 静息心率 = 当天最后一条
  - 血氧 = 算术均值，自动归一化（0.95 / 95 都视作 95%）
- 跳过空数据天 —— 避免覆盖之前已写入的值
- 单 type 失败不影响其他 type
- upsert 到 `health_data` 表，`ON CONFLICT (date)`

**触发**：
- App.tsx 在 user mount + 每次进前台时调 `maybeAutoSyncHealth()`
- 内部 30 分钟节流，所以频繁切前后台不会拉爆
- 健康同步页有「立即同步」按钮强制 bypass 节流
- 没办法自动触发 Health Sync 本身（它是独立 app），用户每天得手动开一下 Health Sync

**健康同步页（`/health-sync`）**：
- 顶卡：「立即同步」+ 上次同步时间 + 本次写入结果
- 中卡：「今天」预览（步数 / 睡眠 / 心率 / 静息 / 血氧）
- 折叠「🔧 诊断工具」：可用性检查、单独请求授权、按 type 读样本 + 列原始数据，用来调权限问题

**Android Manifest 权限**：`READ_STEPS / READ_SLEEP / READ_HEART_RATE / READ_RESTING_HEART_RATE / READ_DISTANCE / READ_TOTAL_CALORIES_BURNED / READ_OXYGEN_SATURATION`，加 `<queries>` 块让 Health Connect 能 deep-link 我们的隐私政策。

**minSdkVersion 26 (Android 8.0)**：Health Connect plugin 依赖 `androidx.health.connect:connect-client` 强制要求。

### 💬 聊天界面交互
- **气泡分组**：同人 1 分钟内连发紧贴（3px），换人或间隔大拉开（12px）
- **居中时间分隔**：间隔 >5 分钟才显示
- **一条消息 = 一个气泡**：用 `[NEXT]` 显式拆成短句串
- **懒加载**：进入只渲染最近 30 条，"加载更早" 按钮分页
- **header**：固定标题"哥哥" + 副标题显示当前模型名
- **聊天操作菜单**：思考链 toggle + 手动压缩对话 + 导航
- **工具调用卡片**：每条助手消息上方显示本轮调了哪些工具，可折叠查看详情
- **打字指示器**：Claude 思考时三个跳动的点（第一个 token 到达前）
- **入场动画**：新消息从下方滑入 + 淡入（0.25s）
- **自动标题**：第一轮对话后自动生成 4-8 字中文标题
- **长按菜单**：复制 / 引用 / 重新生成 / 编辑 / 删除

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
| API Provider 切换 | OpenRouter ↔ 中转站，一键全局切换。OR 下 Claude 有 prompt cache 90% 省，中转无 cache |
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
| 触发比例 | 0.65 | 历史 token 占上下文窗口比例超过此值时触发压缩 |
| 保留最近消息数 | 20 | 压缩时保留最近 N 条不动，只摘要更早的 |
| Summarizer Provider | OpenRouter | 可以让摘要走 OR（便宜模型），聊天走中转 |
| Summarizer Model | 自动 | 默认 `openai/gpt-4o-mini`，也可从已启用模型里选 |

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
| 首页 Dashboard | `/` | 时钟 + 在一起天数 + 当日打卡卡片（一周圈圈 + 一键打卡按钮）+ 可自定义小组件 + 9 个 app 图标入口 |
| 聊天 | `/chat/:id` | 主聊天界面，工具循环 + 流式 + 懒加载 |
| 设置 | `/settings` | 10 个折叠区（详见上方） |
| 记忆库 | `/memory-vault` | 4 个 tab：记忆 / 日记 / 交接信 / 时间轴，CRUD + 搜索 + 来源筛选 + 自动提取 + 待确认流程 |
| 我的主页 | `/snacks` | 朋友圈帖子 + AI 回复 + 软删除回收站 |
| TA 的主页 | `/syzygy` | Claude 的朋友圈（对镜版） |
| 用量统计 | `/usage` | 按 provider / 按会话排行 + 缓存命中率 |
| 健康同步 | `/health-sync` | Health Connect → `health_data`，自动同步 + 手动触发 + 诊断工具（APK 限定） |
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
            │           proactive_queue, fcm_tokens
            │
            ├─→ edge functions: openrouter-chat, openrouter-models,
            │                   memory-extract, web_search,
            │                   send_proactive_push (pg_cron 触发)
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
| 权限 | 用途 |
|------|------|
| `INTERNET` | API 调用 |
| `ACCESS_FINE/COARSE_LOCATION` | 天气定位 |
| `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` | 精确定时通知 |
| `RECEIVE_BOOT_COMPLETED` | 重启后恢复已调度通知 |
| `WAKE_LOCK` | 通知唤醒屏幕 |
| `POST_NOTIFICATIONS` | Android 13+ 通知权限 |

---

## 文件指南

```
src/
├── App.tsx                    # 主路由 + sendMessage + 11 个工具循环（~2800 行）
├── api/
│   └── openrouter.ts          # 通用 LLM provider fetcher（OR/中转）
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
│   ├── HomePage.tsx           # 首页 dashboard + 小组件
│   ├── HomeLayoutSettingsPage.tsx
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
│   ├── weather.ts             # Open-Meteo 天气 + 1h 缓存
│   ├── proactiveNotification.ts  # 本地通知调度 + cancel/re-arm
│   ├── supabaseSync.ts        # 远程 CRUD（sessions/messages/checkins/overrides）
│   ├── supabaseConfig.ts      # 本地 Supabase URL/key 配置
│   ├── sandbox.ts             # 代码沙盒（带 https/http 协议校验）
│   ├── statusBar.ts           # Android StatusBar 跟随页面 bg
│   ├── homeLayout.ts          # 首页布局（IndexedDB 存大数据）
│   ├── openrouterPricing.ts   # 模型定价（24h 缓存）
│   └── imageUpload.ts         # 图片压缩 + Supabase Storage 上传
└── supabase/
    └── client.ts              # supabase 单例 + 本地配置覆盖
```

---

## 已知限制 / 未做

- **后台 keepalive**：app 关闭后 timer 不跑，下次开 app 第一条可能要付 cache 重写费
- **单租户 RLS**：工具表用开放策略，只适合一个账号用
- **iOS**：通知/状态栏/硬件返回 都是 Android-only 守卫
- **FCM**：代码保留但默认关闭（华为 GMS 不稳定）
- **`window.confirm/prompt/alert`**：部分页面还在用原生 dialog，待统一为 `ConfirmDialog`

## 历史 / 想做但暂缓

- 语音输入（Web Speech API）
- 语音输出（TTS）
- 暗黑模式 — 试过，每个页面的硬编码颜色太多，做一半撤了
- 端到端加密的消息存储
- Anthropic Code Execution 工具（要 BYOK 直连）
