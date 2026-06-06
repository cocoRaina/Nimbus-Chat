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
     → 「忽略」直接 DELETE FROM memory_entries（硬删除,无回收站）
       —— 自动提取的候选可能含敏感细节,「忽略」语义就是"我不要"
       —— 早期版本是软删除(is_deleted=true),会积累大量不可见行
```

**设置**（设置页 → ✨ 自动记忆提取）：
- 总开关（默认开启）
- 提取提供商（OR / 中转站，可以和聊天分开走 —— 比如聊天走中转，提取走 OR）
- 提取模型（从已启用模型中选，推荐便宜的小模型如 Haiku）

**来源标记**：
- 记忆/时间轴列表项右侧显示 ✨ 标记区分自动提取 vs 手动录入
- 来源筛选 chips：全部 / 手动 / ✨自动

### 🛠️ Claude 工具（共 12 个）

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
| `get_device_state` | 查手机电量 / 是否充电 / 今日总屏幕时长 / Top 5 app 时长。`@capacitor/device` + 自定义 UsageStats plugin。APK 限定；屏幕时间需用户在系统设置开「使用情况访问权限」 |

每次工具调用会被记录在消息的 `meta.tool_calls` 里，聊天界面显示为**可折叠的工具卡片**（类似 claude.ai）：图标 + 工具名 + 参数预览 + 耗时，点击展开看完整参数和返回结果。

### 💰 成本优化
- **Anthropic Prompt Caching**:1 小时 TTL(写贵 2x,读 0.1x)。**OR 启用显式断点缓存(BP1+BP4+HEAD 三锚点)**，中转站关闭显式标记(中转 relay 的 keepalive ping 无法匹配聊天请求的缓存 key → ping 会写无用缓存白白浪费钱，且中转自身有服务端自动缓存)。Claude on OR 自动路由到 OR 原生 `/api/v1/messages` 端点(OR 的 `/chat/completions` 翻译层会丢 `cache_control` marker,踩过 0% 命中工具迭代的坑后切的)
- **Cache marker 策略**(三个 breakpoint,Anthropic 上限 4 个):
  - **BP1**:打在系统提示词的 text block 上 —— 几乎永不变的基础上下文,任何上层 miss 都能 walk-up 到这里兜底
  - **BP4**:倒数第二条 user message —— 上一轮的 HEAD,新一轮请求过来 walk-up 命中
  - **HEAD**:最新一条 user message —— 写入新缓存
  - **工具迭代特例**:请求里最后一条 user message 之后有 `tool_use`/`tool_result` 时,**只标 BP1,不标 HEAD/BP4**(避免写入 ~77k token 的新缓存 —— Anthropic 后端在带 tool block 的请求里 walk-up 不稳定,写了也没人读,2x 写入价等于纯烧钱)
- **`metadata.user_id` 后端粘性**:`anthropic.ts` 把用户 ID 塞到 Anthropic 原生 `metadata.user_id`,Anthropic 用它做后端节点路由 —— 同用户的请求落到同一节点,缓存读写在同一处
- **聊天接力刷新**:命中 cache 自动续 TTL 不要钱(Anthropic 官方:"refreshed at no additional cost")。只要 1h 内继续聊,缓存一直热着。这是主要的省钱机制
- **`tool_choice` 翻译完整**:`anthropic.ts` 把 OpenAI 的 `tool_choice: 'none'/'auto'/'any'/'required'/{type:'function',function:{name}}` 统一翻成 Anthropic 的 `{type:...}` 形式。**之前没翻译这字段**,导致 MAX_TOOL_ITERATIONS 的收尾调用为了阻止模型继续调工具只能 `delete body.tools`,而 `tools` 是 cache key 的一部分,每次工具循环爆顶都触发 ~50k 全量冷写 ($0.15)。修完之后:保留 tools 用 tool_choice='none' 阻止调用,cache 完整命中
- **Keepalive ping(已停)**:历史上做过三层(客户端 timer + 进页面 pre-warm + 服务端 pg_cron 每 5min),目的是覆盖 >1h 长 gap 后的早晨第一条冷写。**但中转 relay 中间层会把 `stream:true` 和 `stream:false` 当成不同请求路由(推测)**,服务端 cron 的非流 ping 在 Anthropic 那边永远找不到聊天写下的缓存分片,每次冷写 ~50k 反而**净浪费 ~$5/天**。Anthropic 官方文档没说 stream 字段进 cache key,但 relay 黑盒拗不过。Code 留着但 `pg_cron` job 已 `cron.alter_job(active:=false)` 关掉。要重启:`cron.alter_job(JOB_ID, active:=true)`。日均代价:1-3 次自然冷写 = $0.20-0.50,比 ping 便宜
- **对话压缩**:历史超阈值时自动用 summarizer 模型摘要,节省 token。**工具迭代特例**:模型支持工具时阈值自动收紧到 35%(=Claude 上下文 7万 token,默认 65%=13万),因为 Anthropic 服务端在带 tool block 的请求里 walk-up 不命中,~62k 历史每次以 \$15/M 重读 → 提前压缩成 ~20k 上下文,工具迭代成本从 ~\$1.18 降到 ~\$0.06(降 95%)
- 默认 summarizer = **DeepSeek-V3.1**(`deepseek/deepseek-chat-v3.1`),比 GPT-4o-mini 中文摘要质量更稳,OR 自带 prompt cache 后实际成本更低。设置可单独选 summarizer 的 provider 和 model

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
自动从手机健康数据拉今天的步数 / 睡眠 / 心率 / 静息心率 / 血氧，写进 `health_data` 给 Claude。仅 APK，走 `@capgo/capacitor-health`（read-only）。
→ 实现细节（数据链路、聚合 API、限速退避、权限）见 [docs/features/health-sync.md](docs/features/health-sync.md)

### 🏠 主页 widget 系统

桌面式排布，**无底部 dock**，所有 app 入口都是 widget grid 里的图标。

**结构**：
- 顶部时钟 + 日期 + 编辑按钮
- 中部 widget 区：**横向多页**（scroll-snap，左右滑翻页 + 圆点指示器），每页 4 列网格
- Page 0 默认：打卡卡片（2x1）+ 9 个 app shortcut 图标（聊天 / 打卡 / mimi / Claude / 记忆库 / 健康 / 用量 / 设置 / 导出）
- Page 1+：用户自定义内容

**widget 类型**：
| type | 尺寸 | 说明 |
|---|---|---|
| `checkin`（核心，page 0 顶部）| 1x1 / 2x1 | 累计陪伴天数 + 一周圈圈 + 一键打卡 |
| `app_shortcut` | 1x1 | dock 风格的 app 入口（圆角白底 + emoji + label）|
| `health_panel` | 1x1 / 2x1 | 今日步数 / 睡眠 / 心率 / 血氧；点击跳 `/health-sync` |
| `screen_time` | 1x1 / 2x1 | 今日总屏幕时间 + Top 3 app；点击跳 `/health-sync` |
| `period` | 1x1 / 2x1 | 当前周期天数 + 阶段 + 下次预计；点击跳 `/health-sync` |
| `text` | 1x1 / 2x1 | 纯文本备忘 |
| `image` | 1x1 / 2x1 | 本地图片（IndexedDB 存储）|
| `spacer` | 1x1 / 2x1 | 占位 |

数据流：内容 widget 通过 `src/hooks/useHomeWidgetData.ts` 一次性拉今天的 health_data 行 + period_tracking 最新行 + 当日 UsageStats，多 widget 共用一份数据。

**编辑模式**（长按任意 widget 或点「编辑」按钮）：
- 头部胶囊 toggle `设置 / 预览`（抄小红书系桌面布局编辑器，干净分离两种状态）
- **设置 tab**：只显示编辑面板
  - `组件` 面板：进度条 + `+ 文本 / + 图片 / + 占位 / 显示空位` + `+ 应用 / 组件` 下拉 picker
  - `编辑图标` 面板：下拉选 app + 文本框输 emoji + 恢复默认
  - `当前组件` 列表：当前页所有 widget 列成一行行，每行 label + 尺寸下拉 + × 删除（app_shortcut 不显示尺寸）— 没有了 widget 网格之后用这个面板顶替原本的 inline 控件
- **预览 tab**：只显示 widget 网格（干净，没有 ✕/尺寸 浮层），看起来就跟真的桌面一样
- 页码圆点旁有「＋ 加新页」/「× 删除当前页」按钮（page 0 受保护不能删）
- 自动保存到 localStorage（`nibble_ui_prefs_v1`）

**存储 schema**（`HomeSettingsState`）：
- `iconOrder: string[]` — 保留用于 emoji 编辑器下拉
- `pages: { widgetOrder, widgets }[]` — 多页 widget 布局
- `appIconConfigs: Record<id, { type: 'emoji'; emoji }>` — 用户自定义 emoji
- `togetherSince` / `checkinSize` / 等其他偏好

旧数据自动迁移：早期版本的 `widgetOrder/widgets` 顶层字段 → `pages[0]`；早期 dock-only 布局 → 自动把 9 个 app 注入 page 0 作为 shortcut（顺序按 ALL_APP_IDS）。

### 💬 聊天界面交互(LINE 风格)
- **Header**:左 `←` 返回首页、Claude 的圆头像(同步 `/syzygy` 朋友圈头像)、可改名称(默认"哥哥",✏️ 修改名称写到 localStorage `nimbus_assistant_name`,主动消息通知 title 也跟着用新名字);右 `⚙️` + `≡`(会话抽屉)
- **`⚙️` 齿轮菜单**:🧠 思考链开关 / 🤖 **模型选择**(per-session override,选默认值=清除 override) / 📦 手动压缩对话 / ✏️ 修改名称。模型选择从输入栏挪到这里,输入栏更清爽
- **正在输入指示器**:流式期间在 header 名称下方副标题显示「正在输入…」+ 三跳动点,不再在消息流尾巴留空气泡
- **输入栏**:单行 `[+] [🎤] [输入框 pill] [➤ 发送 / ■ 停止]`,底部是白色 footer 面板。`+` 点开浮出小菜单 `📷 拍照 / 🖼 从相册`(分别走 `<input capture="environment">` 直接相机和 `<input multiple>` 相册),`🎤` 调系统 SpeechRecognizer 录音转文字(zh-CN,partialResults 实时塞 textarea)。流式时变红停止
- **📡 离线条**:`@capacitor/network` 监听网络,断网时在输入栏上方显示黄色「📡 已离线」横条(发送照常排队,网络恢复自动重试)
- **📳 震动反馈**:`@capacitor/haptics` 在长按菜单弹出 / 发送按钮 / 麦克风停止 时触发轻震,体感反馈用
- **气泡分组**:同人 1 分钟内连发紧贴(3px),换人或间隔大拉开(12px)
- **居中时间分隔**:间隔 >5 分钟才显示
- **一条消息 = 一个气泡**:用 `[NEXT]` 显式拆成短句串
- **懒加载**:进入只渲染最近 30 条,"加载更早" 按钮分页
- **工具调用卡片**:每条助手消息上方显示本轮调了哪些工具,可折叠查看详情
- **入场动画**:新消息从下方滑入 + 淡入(0.25s)
- **长按菜单**:复制 / 引用 / 分享(`@capacitor/share` 调系统分享面板) / 重新生成 / 编辑 / 删除。菜单**自动翻转**:如果气泡靠近屏幕底部、菜单展开会被输入框压住,`useLayoutEffect` 量完菜单高度后改成出现在气泡**上方**;水平方向也会贴边裁剪。触摸屏下气泡 `user-select: none` + `-webkit-touch-callout: none`,长按不会触发系统蓝色选字(桌面鼠标仍可选,用 `@media (hover:none) and (pointer:coarse)` 隔离)

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

