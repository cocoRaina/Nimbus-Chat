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
让 Claude 知道你今天走了多少步、睡了多久、心率多少 —— 不靠手动告诉它，自动从手机健康数据里拉。

**数据链路（华为示例）**：
```
华为手环 → 华为运动健康 → Health Sync（第三方桥接）→ Health Connect → Nimbus
```
Health Connect 是 Android 14+ 系统级（13- 需装 Google 的 Health Connect app）。任何能写入 Health Connect 的数据源（小米运动 / 苹果以外的可穿戴 / Samsung 健康）都行，华为通过 Health Sync 走这条桥。

**前端用 `@capgo/capacitor-health` v8 plugin**（仅 APK），声明的权限：steps / sleep / heartRate / restingHeartRate / distance / totalCalories / oxygenSaturation，全部 read-only，不会写回。

**同步规则**（`src/storage/healthSync.ts`）：
- **步数走聚合 API**（`queryAggregated` sum + day bucket，锚定本地午夜）—— 日步数是「总和」,被 record limit 截断就会少算(均值类截断只是偏向近期、可接受,总和不行)。聚合一次返回每个日历日的精确总和,不分页翻几千条分钟级记录
- 其余 4 类走 `readSamples`,**每类 limit ≤ 500 = 恰好一页 = 一个请求**:睡眠 50 / 心率 500(36h)/ 静息心率 30 / 血氧 300
- **串行 + 每个请求间隔 300ms**(不是并行!)—— Health Connect 的周期性速率限制是 QPS 式的,同时炸出去一串请求是最差情况;5-6 个单页请求摊到 ~1.5s 就稳稳低于阈值。诊断工具单次单类型能读、同步炸,根因就是同步把 9 个请求(steps×3 页 + HR×3 页 + ...)挤在一起爆发
- 按本地日期聚合：
  - 步数 = 聚合 API 日总和
  - 睡眠 = 累加段时长 → 小时 (按 endDate, 跳过 awake/inBed)
  - 心率 = 算术均值 / max / min（取最新 500 条样本算，今天必覆盖）
  - 静息心率 = 当天最后一条
  - 血氧 = 算术均值，自动归一化（0.95 / 95 都视作 95%）
- 跳过空数据天 —— 避免覆盖之前已写入的值
- **payload 只塞非 null 字段**：Postgres `ON CONFLICT DO UPDATE` 只更新 payload 里出现的列;某次 Health Connect 只返回了步数没返回睡眠时,不会用 null 把之前已存的睡眠/心率覆盖掉
- 单类型失败不影响其他类型(各自 try/catch,**不再 break**,因为请求已拉开间隔、后面的类型大概率能成);遇到 Health Connect 限速（`rate limit`/`quota`/`throttle`/`429`）会写一个 **10 分钟限速退避**（`nimbus_health_rate_limit_until_v1`）—— 退避期内**连手动 force 同步都不发请求**(限速期发请求只会重置滑窗、让配额永远回不来)。成功同步后清除退避。部分成功 + 部分限速时仍然入库成功的那几类
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

---

## 🩹 Debug 日志（踩过的坑 + 修法）

> 用于以后再撞同样的 bug 时直接定位。每条都对应一个已合并 commit。

### Anthropic /v1/messages 400 全家桶

`src/api/anthropic.ts`。OpenRouter 和直连 relay（msuicode 等）都会把上游 Anthropic 400 包成 `{"error":{"type":"bad_response_status_code", ...}}`，看不到真正的错误体，必须按下面 checklist 一条条排：

| 症状 | 触发条件 | 修法 |
|---|---|---|
| 400 — `messages` 校验失败 | 历史里有 assistant 仅工具调用、无文字，恢复后 `content: ''` | `convertOpenAiRequestToAnthropic` 里空 assistant 直接 `continue` 跳过；空 user 用 `(empty)` 占位 |
| 400 — empty text block | 用户消息加 timestamp 前缀后 trim 完为空，或图片消息没附文字 | `flattenContent` 里 `text.trim().length === 0` 的块跳过 |
| 400 — 最后一条不能是 assistant | 历史尾巴恰好是 assistant 仅工具调用（被上一条规则丢掉后还露出来） | 转换完 `while messages[-1].role === 'assistant': pop` |
| 400 — `max_tokens` 小于 `budget_tokens` | 用户默认 `maxTokens = 1024`，effort=high 时 `budget_tokens = 8000` | thinking 开启时 `max_tokens = max(user, budget + 1024)` |
| 400 — temperature/top_p 与 thinking 不兼容 | thinking 要 `temperature === 1`、`top_p` 不传 | thinking 开启时 temperature / top_p 一律 drop |
| 400 — 模型不支持 thinking | Claude 3.5 / 3 收到 `thinking` 字段直接 400 | 用 `/claude-(opus-4\|sonnet-4\|haiku-4\|3-7\|3\.7)/i` 正则 gate |
| 400 — Opus 4.7/4.8 不收 `budget_tokens` / 采样参数 | Opus 4.7 起**移除**了手动 extended thinking（`thinking:{type:'enabled',budget_tokens}`)和 `temperature`/`top_p`/`top_k`,收到任一直接 400 | 解析 model 版本号(两种命名都认),≥4.7 走 adaptive thinking:`thinking:{type:'adaptive'}` + `output_config:{effort}`,并对这些模型一律 drop 采样参数(thinking 关也要 drop)。4.6 及更早保持 `budget_tokens` 老路 |
| 400 — `anthropic/` 前缀 model ID | 直连 relay（msuicode）不吃 OpenRouter 命名空间 | 转换时 `body.model.replace(/^anthropic\//, '')` |
| 400 — tool_result 没有 tool_use_id | 上游 delta 丢了 id 或 history 重建丢了链接 | tool role 转换时 `if (!msg.tool_call_id) continue` |
| 400 — tool_result 挂到 assistant 消息上 | 连续 tool role coalesce 时没看上一条 role | 只在 `last.role === 'user' && Array.isArray(last.content)` 时 push 进去 |
| Failed to fetch on OR /messages | Capacitor WebView CORS preflight 拒绝 Anthropic-only header(`anthropic-version`、`anthropic-dangerous-direct-browser-access`、`x-api-key`)| OR 走 `/messages` 时只发 `Authorization: Bearer` + `Content-Type`,其他 header 全 strip(直连 Anthropic + 中转才发完整套) |
| OR /messages 4xx model 不识别 | `anthropic.ts` 默认砍 `anthropic/` 前缀(直连 Anthropic 要求),但 OR 用这个前缀做上游路由 | `keepModelSlug` 选项控制:OR 调用时传 `true` 保留 slug,中转保持 `false` 砍掉 |
| 工具迭代 cached_tokens = 0(但 chat 2 还命中)| Anthropic 服务端在请求里有 `tool_use`/`tool_result` block 时,HEAD 和 BP4 cache 都 miss(只有 BP1 walk-up 还工作)。同时如果还留 HEAD marker,会写一份 ~77k token 的"没人读"的新缓存白烧 \$2 | 结构性检测:最后一条 user message 之后有 tool block 时,**只标 BP1**,不标 HEAD/BP4 |
| MAX_TOOL_ITERATIONS 收尾每次冷写 ~$0.15 | `App.tsx` 收尾(`tool_choice='none'` 那段)用 `delete body.tools` 阻止模型继续调工具,但 `tools` 是 Anthropic cache key 的一部分,删了之后整段前缀字节不匹配 → 全量冷写 ~50k。**根本原因**是 `convertOpenAiRequestToAnthropic` 没翻译 `tool_choice` 字段,silent 丢掉,删 tools 是当时唯一阻止调用的方式 | converter 加 `tool_choice` 翻译(`'none'/'auto'/'any'` → `{type:...}`,`'required'` → `{type:'any'}`,`{type:'function',function:{name}}` → `{type:'tool',name}`);收尾保留 `tools`,只用 `tool_choice:'none'` 阻止调用。cache 命中,收尾从 $0.15 降到 $0.015 |
| 中转保活 ping 永远冷写 ~$0.22 | `cache_keepalive` Edge Function 用 `stream:false` 发非流 ping,推测 relay 把 stream:true(聊天)和 stream:false(ping)路由到不同后端节点,Anthropic 那边落在不同缓存分片。Anthropic 官方文档说 stream 字段不进 cache key,但 relay 黑盒拗不过。验证字节稳定性(tools 顺序硬编码 / system 静态 / 时间戳每条消息固化 / 图像 base64 确定性)都 OK,根本不是字节问题 | 停掉 `pg_cron` job(`cron.alter_job(id, active:=false)`)。聊天本身的接力缓存(Anthropic 命中自动续 1h,免费)足够覆盖大部分场景;只接受 >1h gap 后的偶发冷写($0.20-0.50/天) |
| 长按菜单永远在气泡下方,屏幕底部时被输入框压住 | `startLongPress` / `handleContextMenuOpen` 写死 `top: rect.bottom + 4`,不看视窗剩余空间 | 加 `useLayoutEffect`:菜单 portal 渲染后量 `offsetHeight`,如果 `rect.bottom + menuH > viewportH - 8`,翻到 `rect.top - menuH - 4`;水平也夹一遍。layout effect 同步在 paint 前跑,无闪烁 |
| 长按气泡触发系统蓝色选字、和我们的菜单打架 | `.message .bubble` CSS `user-select: text` 让 Android WebView 长按时进文字选择模式 | 加 `@media (hover:none) and (pointer:coarse)` 隔离,触摸屏下 `user-select: none` + `-webkit-touch-callout: none`,桌面鼠标仍可选字。损失:触摸屏选不了部分文字,菜单里有"复制整条"兜底 |
| pg_cron 401 UNAUTHORIZED_NO_AUTH_HEADER | `current_setting('supabase.service_role_key')` 在 pg_cron session 里取不到值,Authorization header 变成 `Bearer ` (空)| cron command 里**直接内联 anon key**(anon key 本来就是公开的,前端 bundle 里也带,放 SQL 里没新增暴露) |
| cache_keepalive 把睡眠/心率写成 null 覆盖老数据 | upsert payload 不管 null 全字段塞,Supabase 翻成 `excluded.col = NULL`,Postgres `ON CONFLICT DO UPDATE` 把已有数据洗掉 | payload 只塞非 null 字段:`if (row.X != null) out.X = row.X` |
| Health Connect 大量 4xx Rate Limit | 5 类样本依次查,前面用完 5min 配额后剩下 4 类必失败 | catch 里检测 `/rate.?limit\|quota\|throttl\|too many\|429/i`,撞了就直接 `break` 整个 type loop |
| 限速后"今早还限速",一开 app 就失败 | `maybeAutoSyncHealth` 在 mount + 每次切前台触发,靠 `last_synced_at` 节流。失败时不写时间戳(为了能手动重试)反而让自动同步每次前台都重打,持续吃配额,滑窗永远回不来 → 死循环 | 限速时写 10min 退避戳(独立 key),退避期内 auto + force 一律不发请求;成功才清退避 + 写 `last_synced_at` |
| 同步明明限速了 UI 却显示"✅ 同步成功:0 天入库" | 函数末尾无条件 `summary.ok = true` + `writeLastSyncedAt`,limit-break 出来也算成功 | 末尾先判 `if (summary.skippedReason) { ok = false; return }`,不写时间戳、不清退避 |

### 健康同步相关

| 症状 | 触发条件 | 修法 |
|---|---|---|
| 诊断工具单类型能读、整体同步却一直限速(只有睡眠或步数能上) | 同步把 5 类一起读,且 steps/HR 的 `limit:1500` 触发 capgo 插件分页(pageSize 500 → 每类 3 个背靠背请求) → 合计 ~9 个请求挤在一两秒内爆发,撞 Health Connect **周期性(QPS式)速率限制**。诊断只点一个类型、无 limit→默认 100→单请求、手动点击间隔几秒,所以从不触发 | ① steps 改聚合 API(`queryAggregated` sum/day,精确日总和不分页);② 其余 4 类 limit≤500=单页单请求;③ **串行 + 每请求间隔 300ms**(替换掉一度尝试的 `Promise.allSettled` 并行 —— 并行炸串请求对 QPS 限制是最差解);④ 不再 break,各类型 try/catch 续跑 |
| 心率显示 `62-62（单次）`，实际有上百条样本 | `dedupeSamples` 只按 `platformId` 去重，Health Connect 心率系列里几百个样本共享 parent record 的 metadata.id | dedupe key 加上 `startDate + value`（`storage/healthSync.ts`）|
| 经期组件总是显示「经期中」 | `period_tracking` 排序只按 `start_date DESC`，相同日期排序不稳定，老 row 还在；且 `end_date is null` 时 phase 默认是「经期中」 | 排序加 `created_at DESC` tiebreaker；phase 改 7 天 fallback（`isInPeriod = end_date ? today <= end : daysSinceStart < 7`）|
| 屏幕时间显示 `com.tencent.mm` 而不是「微信」 | Android 11+ package visibility 限制，`PackageManager.getApplicationLabel` 拿不到他 app 信息 | `AndroidManifest.xml` 加 `QUERY_ALL_PACKAGES` + `tools:ignore` |
| 经期下次预计永远是 +28d，不会按自己实际周期调整 | `useHomeWidgetData.ts` + `HealthSyncPage.tsx` 都 hard-code `row.cycle_length ?? 28`，从来没读历史 | 抽 `computeMedianCycleFromHistory()`，拉最近 6 行 `period_tracking`，算相邻 start_date 间隔的中位数（带 15-60d sanity window），优先级：history median > Claude 写的 cycle_length > 28d。`PeriodMetrics` 加 `cycleSource: 'history' \| 'logged' \| 'default'` + `cycleSampleSize`，HealthSyncPage 把来源 inline 在「平均周期」一行 |

### 主页 widget 相关

| 症状 | 触发条件 | 修法 |
|---|---|---|
| 编辑 → 预览时上面的「编辑图标」面板还露着 | `.icon-editor-toolbar` 只 gate 了 `showSettingsPanel`，没 gate `!editPreviewing` | 加 `!editPreviewing` 到条件里 |
| 编辑模式下 widget 网格还在底下，画面拥挤 | 网格只 gate 了 `showPreviewPanel`（默认 true） | 改成 `showPreviewPanel && (isSettingsPage \|\| !editMode \|\| editPreviewing)` |
| inline 删除/尺寸控件在预览 tab 还显示 | 控件 gate `editMode` 没考虑 editPreviewing | 改成 `editMode && (isSettingsPage \|\| !editPreviewing)` |
| 设置 tab 没了网格 → 删不掉单个 widget | 网格隐藏后没替代入口 | 新增 `.widget-list-panel`「当前组件」列表，emoji + label + 尺寸 + × |
| TS 报 `Property 'type' does not exist on type 'never'` | widget 类型穷举完后 `widget.type` 被收窄为 never | 兜底返回字符串字面量 `"组件"` 而不是 `widget.type` |
| iOS 风格 dock 删干净后 home 还残留旧 CSS | `.home-dock` / `.app-icon-slot` / `tile-pop-in` keyframes 死代码 | `HomePage.css` 一次性清掉，shortcut 用 `.shortcut-widget / .shortcut-emoji / .shortcut-label` 区分 |
| 加完 widget 点进去再退回来 widget 又消失 | `App.tsx` 里 `onOpenChat` 写成 inline arrow，每次 App re-render 引用都新 → HomePage 的 `defaultAppIconConfigs` memo 重算 → load useEffect 重跑 → 在 save useEffect flush 之前读 localStorage 拿到旧数据 → 覆盖刚 setPages 出来的新 widget | HomePage 加 `hasLoadedPrefsRef`，load useEffect 只跑第一次。一行 ref guard 解决 |

### 聊天 / 主动消息相关

| 症状 | 触发条件 | 修法 |
|---|---|---|
| 主动消息发出后又被新对话误删 | clear pending 时把主动消息的 ChatMessage 一起删了 | 区分 `nimbus_pending_proactive`（待发提醒）和已经写进 Supabase 的 ChatMessage（不删）|
| 改名只在聊天界面生效，通知 title 还是「哥哥」 | 通知模块硬编码 `'哥哥'` | 抽 `storage/assistantPersona.ts`（`getAssistantName / setAssistantName`），聊天 + 通知共用 |
| 流式期间消息列表末尾留个空气泡 | 临时把 streaming 消息放进 messages | 改成只在 chat header 名称下显示 `.chat-typing-subtitle` + 三跳动点，messages 不动 |
| 输入框和聊天区域之间有缝，看起来分开了 | `.chat-composer` 没去掉自带 padding/border | 把 `.chat-messages` 设透明 + `.chat-composer.glass-card` 显式 `background: #ffffff !important; border-top: 1px solid rgba(15,23,42,0.06) !important` |
| 朋友圈也走思考链了（两句话发个帖也 thinking，慢 + 贵） | `feedAiConfigBase.reasoning` 写成了 `latestSession?.overrideReasoning ?? activeSettings.chatReasoningEnabled`，直接继承聊天的思考链开关 | hardcode 成 `reasoning: false`，把朋友圈与聊天的思考链解耦。朋友圈用例零收益 |
| 55min cache 续命 ping 一直在跑但 cache 命中率没涨 | 续命 body 同时踩了三个坑：① `max_tokens: 0` Anthropic 不收，adapter 兜底成 4096 → 续命变成全量生成；② `delete pingBody.tools` —— tools 是 cache 前缀的一部分，删了 cache key 就不一样，续命的 ping 跟原 conversation 不是同一个 cache entry；③ `reasoning` 还在 snapshot 里，配合 thinking 把 max_tokens 顶到 budget+1024 ≈ 9024 | `App.tsx:scheduleKeepalive` 改成 `max_tokens: 1`、保留 `tools`、`delete pingBody.reasoning` + `tool_choice` + `usage`。`/usage` 页能看见 cache hit % 持续上涨 = 续命真的在 work |

---

## 2026-06-06 改动记录

### 修复:prompt 缓存此前只在 OpenRouter 生效,放开到金瓜瓜等原生中转
- **症状/根因**:`applyClaudeCaching` 第一行 `if (getActiveProvider() !== 'openrouter') return messages` 把缓存标记**写死成只有 OpenRouter 才挂**。切到金瓜瓜(走 msuicode 槽)时一个 `cache_control` 都不挂 → 哪怕金瓜瓜支持原生缓存也完全用不上。
- **修法**:门控改为「会走原生 `/v1/messages` 的渠道都挂」——即 OpenRouter,或 **msuicode 且格式=Anthropic**(指向金瓜瓜/PumpkinAPI 这种)。
- **TTL 按渠道区分**:OpenRouter 用 1h(配 55min 续命 ping);金瓜瓜类只支持 5m、挂 1h 会被拒,所以那条路径用普通 5m ephemeral 标记。`marker` 参数透传进 `markSystem/UserMessageForCaching` + `attachCacheControlToLastTextBlock`。
- 金瓜瓜不需要续命 ping(ping 仍只在 OpenRouter 触发):5m TTL 连续对话自然命中,停>5min 下条重建一次即可。
- ⚠️ 纯前端改动,需重新打 APK 才生效。验证:Anthropic 兼容格式下连聊 3 句,看 `/usage` 缓存命中是否非零。

### 修复:记忆提取「忽略」点了没反应(缺 DELETE 的 RLS 策略)
- **症状**:待确认记忆只能「确认」,点「忽略」毫无反应。
- **根因**:`memory_entries` 的 RLS 只有 INSERT/SELECT/UPDATE 三条策略,**没有 DELETE**。确认走 UPDATE(`status='confirmed'`)能过;忽略走硬删除 `DELETE` 被默认拒绝。而 PostgREST 在 RLS 拦截 DELETE 时**返回成功+0 行、不报错**,加上 `handleDismissEntry` 失败只 `console.warn`,所以表现为「死按钮」。
- **修法**:① 新增迁移 `20260606120000_add_delete_policy_to_memory_entries.sql`,补 `for delete using (auth.uid() = user_id)` 策略,并已 apply 到线上库(**服务端改动,立即生效,无需重装 APK**);② `handleDismissEntry` 改用 `.delete().select('id')` 检测影响行数,0 行或报错时 `setError` 提示,不再静默。

### 体验：思考链开了但不会生效时,在开关下给灰字提示
- 🧠思考链开关此前在两种情况下是**静默空操作**:① 当前模型非 Claude 且没开全局「高触发 Thinking」;② 模型是 Claude 但 API 提供方是「OpenAI 兼容」格式,请求没走原生 `/v1/messages`,中转端直接丢掉 `reasoning`。
- 现在在开关下方按这两个门控(对齐 `App.tsx` 的 reasoning 附加 + `openrouter.ts` 的原生路由判断)给出⚠️提示,告诉用户为什么没思考链、怎么修。纯前端改动。

### 修复:屏幕时间——新 App 进前台时关闭其它所有未收尾的计时
- 续上一条屏幕时间修复。除了息屏/锁屏事件,再补一条**不依赖机型上报**的健壮性规则:同一时刻只有一个前台 App,所以一旦某新 App 进前台,就把其它所有还「计时中」的 App 在该时刻收尾。
- 防的是:快速切换 App、或某些 OEM 锁屏时,旧 App 的「切后台」事件丢失 → 它一直累加,把切走之后的时间也算进去 → 总时长虚高(总时长 = 所有 App 之和)。
- ⚠️ 原生改动,需重新打 APK 才生效。

### 优化：健康同步限速退避改成指数式 + 拉大 IPC 间隔（解决"卡卡的"）
- **症状**：健康数据刷新感觉卡顿/迟滞——撞一次限速就整页卡住一段时间。
- **根因**：① 退避是**固定 3 分钟**,一次偶发限速(例如 Health Sync 恰好同时在写)和真正配额耗尽被一视同仁地罚 3 分钟;② 心率改聚合后每次同步从 5 个 IPC 增到 7 个,突发更密、更易撞 Health Connect 的令牌桶限速。
- **修法**:
  - **指数退避**:按**连续**限速次数递增——首次只等 60s,然后 2m、4m,封顶 5m;任意一次同步成功立刻清零计数。瞬时抖动 1 分钟就恢复,只有持续耗尽配额才吃长冷却。新增 `nimbus_health_rate_limit_count_v1` 计数;`clearRateLimitBackoff` 同时清计数(成功同步 / 手动同步入口都会清)。
  - **拉大调用间隔**:`READ_GAP_MS` 100→250ms,7 个 IPC 摊到 ~1.5s,显著降低撞限速频率(后台异步,用户无感)。
  - 手动「立即同步」仍然完全绕过退避,并重置计数。
- ⚠️ 含原生依赖,需重新打 APK 才生效。

### 修复：心率 min/max 偏窄、历史天大量缺失（改走聚合 API）
- **症状**：健康页心率「波动范围」异常窄（如 `70–85`），且很多天 avg/min/max 直接空白。
- **根因**：心率走 `readSamples`，Capgo 默认 `limit=100`。手表几秒一个样本 → 最新 100 个只覆盖最近几分钟，所以全天 min/max 严重偏窄，稍早/历史的读数被截断丢掉。
- **修法**：心率改用 `Health.queryAggregated`（`heartRate` + `average`/`min`/`max`，映射 Health Connect 的 `BPM_AVG/MIN/MAX`），当天 00:00→现在、day 桶，各 1 次 IPC，拿**真·全天**值——和 steps 同款套路。`READ_SAMPLE_TYPES` 移除 `heartRate`；`aggregateSamples` 的 heartRate 分支保留但不再触发。血氧/睡眠插件不支持聚合，维持 readSamples。
- 每次同步比之前多 2 个 IPC，保留 100ms 间隔 + 限速退避。⚠️ 含原生依赖，需重新打 APK 才生效。

### 修复：屏幕时间总时长虚高（锁屏挂机被算成使用）
- **症状**：屏幕使用时间总时长远超实际，通常是锁屏前最后开的那个 App 占了一大坨（早上尤其明显——把整夜挂机算进去了）。
- **根因**：`UsageStatsPlugin.java` 用 `queryEvents` 配对 `MOVE_TO_FOREGROUND/BACKGROUND`，但**安卓息屏/锁屏时不保证给当前 App 发 `MOVE_TO_BACKGROUND`**，于是那条前台计时一直不收尾，末尾兜底时把「锁屏 → 现在」的整段空闲全算成前台时间。
- **修法**：事件循环里额外处理设备级事件——`SCREEN_NON_INTERACTIVE(16)` / `KEYGUARD_SHOWN(17)` / `DEVICE_SHUTDOWN(26)`，遇到就把所有「正在计时」的 App 在那一刻收尾。这些事件包名常为 null，所以放在 `pkg == null` 跳过之前处理。
- ⚠️ 这是原生（Java）改动，需重新打 APK 才生效。

---

## 2026-06-05 改动记录

### 新增：Android 分享接收
- 从其他 App（浏览器、微信、微博）分享文本到 Nimbus → 自动打开聊天页 + 预填内容到输入框
- AndroidManifest.xml 注册 `ACTION_SEND` intent filter + `ShareReceiverPlugin.java` 自定义 Capacitor 插件

### 优化：发送速度 & 离线可用
- **消息本地先存、后台同步**：用户消息和 AI 回复都不再等 Supabase。本地 localStorage 秒存 → 立刻显示 → 后台 5 秒超时异步同步到 Supabase。不挂梯子也能正常聊天
- 工具迭代第 2-4 轮关闭 extended thinking（仅第一轮和收尾开启），每轮工具调用省 ~8000 thinking tokens
- Extended thinking budget 从 8000 → 2000（首 token 延迟降约 4 倍）

### 修复：缓存 & 中转折中
- 中转站关闭显式 prompt caching（中转 relay 的 keepalive ping 无法匹配聊天请求的缓存 key → 白白浪费钱写无用缓存）
- OR 保留完整 BP1+BP4+HEAD 三锚点缓存 + 客户端/服务端保活
- OR 模型列表缓存永不过期的 bug 修复

### 修复：Bug
- ChatPage 只有图片没有文字时发送按钮灰色不可点
- SettingsPage 保存并离开时不等待保存完成就跳转
- SettingsPage 模型列表对比用 `join('|')` 有碰撞风险
- MAX_TOOL_ITERATIONS 触发后 finalizer 的用量不记录到 usage_logs

### UX 改进
- **独立工具状态栏**：工具执行状态从消息气泡中拆出，在消息区和输入框之间显示蓝色状态条（带旋转动画）
- 发送按钮 disabled 条件考虑 pending attachments
- 编辑状态提示更清晰

### 修复：构建 & 模型兼容（晚间补丁）
- **修复 CI 构建失败**：share-intent 重构把 `pendingShare / clearShare / shareDraftRef / toolStatus` 声明在了 `App`、却在 `ChatRoute` 里使用,`tsc` 两头报错(一边"声明未用"一边"找不到名字"),`npm run build` 直接挂、APK 没打成。把 `usePendingShare()` + `shareDraftRef` 移进唯一使用者 `ChatRoute`,`toolStatus` 作为 prop 传入;补 `lastUsage` 类型缺的 `cache_creation_input_tokens` 字段
- **修复 Opus 4.7/4.8 思考链直接 400**：旧逻辑对任何 `claude-…-4…` 模型都发 `budget_tokens`,但 Opus 4.7 起该字段(连同 `temperature`/`top_p`/`top_k`)已被移除、收到即 400 —— 选了最新 Opus 又开思考链就每条消息必失败。改为解析模型版本号,≥4.7 自动切 adaptive thinking(`thinking:{type:'adaptive'}` + `output_config:{effort}`)并 drop 采样参数;4.6 及更早保持原 `budget_tokens` 路径不变

### 优化：小清理
- `loadSnapshot` 之前把 map+sort 跑了两遍(赋值一次、return 再算一次),改成赋值后直接返回浅拷贝,省一半遍历
- keepalive 注释与代码对齐:保活本来就**只对 OR** 生效(OR 才需要客户端打 cache_control 断点;中转站是服务端自动缓存,无需保活),顺手去掉重复的 `getActiveProvider()` 调用
