# 改动记录 & Debug 日志

> 从 README 拆出来的开发历史与踩坑记录(README 太长了)。功能清单和使用说明见 [README](../README.md)。

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
| 连发只能发几条,AI 就抢答并锁住输入框 | 批量回复的 debounce 定时器只在两次"发送"之间重置,但人打下一条字往往超过窗口 → 定时器到点,AI 抢着流式回复,流式一开始停止键就挡住后续输入 | 输入框 `onChange` 调 `onComposerActivity`(→ `App.tsx` `notifyComposerActivity`),**只在定时器已在跑时**重置它(平时打字不受影响);窗口 `BATCH_REPLY_MS` 放宽到 2.5s。只有真正停顿才自动回复(commit `1b8c162`) |
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

## 2026-06-10 新增：经期+桌宠 2×1 组合小组件（多状态动画）

新增第三个桌面小组件 `ComboWidgetProvider`（2×1）：左边日期 + 🩸经期相位/天数/预测，右边会动的 Clawd 螃蟹。
- **多状态**：夜里→睡觉、排卵期→happy、经期中→静止 base、其余→idle，按时段+相位切 ViewFlipper 可见性。
- **更顺**：动画帧从 8 提到 16（idle/happy/sleeping），rest 用 static-base 单帧；都铺 128×128。新增 `crab_happy_*` / `crab_rest_0`。
- 日期用 `SimpleDateFormat("M月d日 EEE", Locale.CHINA)`。复用 `PeriodCalc`；`PeriodWidgetPlugin` 推数据时一并刷新三个 widget。
- 原有经期卡 + 桌宠保留（可单独添加）。MIT 署名见 `THIRD_PARTY_NOTICES.md`。**原生改动，重打 APK 生效。**

## 2026-06-10 桌宠换成 Clawd 螃蟹（真·动画精灵）

把 emoji 桌宠换成 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) 的 Clawd 螃蟹（**MIT**，© Marcio Granzotto；非官方 Anthropic 同人）。
- 从它 `assets/slack-emojis/` 的干净角色 GIF（`clawd-idle-living` / `clawd-sleeping`）各抽 8 帧、统一铺到 128×128 透明 PNG，放 `res/drawable-nodpi/`。
- 布局用两个 ViewFlipper 自动循环（白天 idle、夜里 sleeping），Provider 按时段切可见性 + 按经期相位配台词。**纯帧动画，无需 GIF 解码/动画代码**。
- MIT 合规：`THIRD_PARTY_NOTICES.md` 附完整 MIT 许可 + 署名 + 同人声明。
- **原生改动，重打 APK 生效**；Java/资源仅静态 review（此环境无法编 APK，请装新包后亲测渲染/动画/切换）。

## 2026-06-10 新增：emoji 桌宠小组件

第二个桌面小组件，一只会随你状态变心情的 emoji 小宠物（独立于经期数据卡，可单独添加）：
- 用 emoji 当宠物（无需图片素材，任意尺寸清晰）。`ViewFlipper` 双帧自动循环 → 不写动画代码也会"眨眼"。
- 心情联动经期相位 + 时段：经期中🥺 / 滤泡期😊 / 排卵期😻 / 黄体期😌 / 深夜😴 / 无数据🐱，配一行台词。点击开 App。
- 复用经期数据（`PeriodWidgetPlugin` 推的同一份 SharedPreferences）。抽了共享的 `PeriodCalc`（相位/天数计算），经期卡和桌宠都用，逻辑不再两份。
- 原生：`PetWidgetProvider` + `PeriodCalc` + `widget_pet` 布局 + `pet_widget_info` + manifest receiver；plugin 推数据时一并刷新两个 widget。**原生改动，重打 APK 生效。**

## 2026-06-10 新增：经期桌面小组件（Android 主屏 AppWidget）

第一个真·桌面小组件（不是 App 内的 widget）。长按桌面 → 添加小组件 → Nimbus → 经期，主屏直接看当前阶段 / 第几天 / 距下次几天，点一下开 App。

- 原生：`PeriodWidgetProvider`（AppWidgetProvider，RemoteViews 渲染 + 从 SharedPreferences 读数据 + 点击开 App）、`PeriodWidgetPlugin`（Capacitor 插件，把数据写进 SharedPreferences 并刷新 widget）、`res/layout/widget_period.xml` + `res/drawable/widget_period_bg.xml` + `res/xml/period_widget_info.xml`、manifest `<receiver>`、MainActivity 注册。
- 数据：`useHomeWidgetData` 算出 periodMetrics 后，把 raw start/end date + 解析后的 cycleLength 推给 widget（`storage/periodWidget.ts`）。**相位/天数在 Java 里按 UTC 纯日期重算**（和 useHomeWidgetData 的时区修复一致），所以跨天不打开 App 也会随 `updatePeriodMillis`（30min）自刷。
- **原生改动，重打 APK 才有**。装新包后：home 页加载会推一次数据；首次没数据时 widget 显示「暂无记录」。

## 2026-06-10 移除 FCM + 工具审查

- **移除 FCM 推送**：改用本地通知（`@capacitor/local-notifications`）后 FCM 成死代码（`PushNotifications.register()` 早已注释，listener 永不触发）。清掉 `@capacitor/push-notifications` 插件 + App.tsx 注册/接收 listener + 已弃用的 `proactive_queue` 写入 + gradle 引用。**原生改动，重打 APK 生效**。服务端 `send_proactive_push` 函数 + `fcm_tokens` 表需在 Supabase Dashboard 手删（无 MCP 删除工具）。
- **工具审查**：12 个工具中 `log_health`（in-app tool）之前用 `.insert()`，但 `health_data.date` 无唯一约束、读取走 `.eq(date).maybeSingle()`（>1 行即报错）。当天已有数据时再调一次会造重复行、读取崩。改为按 date upsert（和自动同步 / log_health edge function 一致）。其余写库工具（add_memory/write_diary/...）正常。

## 2026-06-10 全局代码审查修复

并行审查全仓库后修掉的确认 bug（详见对应 Debug 日志行）：

**安全（edge functions，CI 部署后生效）**
- `search_memory`：删掉硬编码的 SiliconFlow API key 兜底（已进 git 历史，key 已轮换）；补 `getUser()` JWT 校验，放在 embedding 调用之前——之前未鉴权请求也能触发 embedding 烧钱。
- `memory-extract`：客户端可控 `apiBase` + 服务端 key 兜底 = SSRF + key 外带。改为只有用默认 OpenRouter base 时才用 env key 兜底；自定义中转站必须自带 key。
- `tts`：补 JWT 校验，和其他 function 对齐（虽 MiniMax key 客户端自带、不烧服务端钱）。

**前端核心管线（`App.tsx` / `anthropic.ts`）**
- 死流检测 abort 后不再把 `streamingControllerRef` 置 null——之前会让 finalizer 的 `=== controller` 守卫失败，UI 永久卡在「正在输入…」、自动记忆抽取被阻塞。
- 停止键保存半截回复：改成本地先存 + 远端 `Promise.race(5s)` + catch，断网时不再丢半截回复 / 抛 unhandled rejection。
- keepalive `firePingNow` 完成后清空 controller ref——之前首次 55min ping 后预热永久失效，吃冷写。
- MAX_TOOL_ITERATIONS 收尾请求带 reasoning 若失败，去掉 reasoning 重试一次（防 thinking + 无 thinking 块的 tool_use 历史 400 → 空回复）。
- Anthropic 流解析：流结束无尾随空行时 flush 残留 buffer（之前丢最后一个事件：content delta / message_stop / usage）；非流式收集器同修，并改用 max-merge 收集 usage（覆盖 message_start 顶层 + message_stop）。

**前端数据层（`storage/` + `hooks/`）**
- 经期判断时区 bug：`new Date('YYYY-MM-DD')` 按 UTC 午夜解析，UTC+8 下经期最后一天早上 8 点后被提前判「已结束」。改为纯日期比较。
- `deleteRemoteSession` 改为只删 session（messages 有 ON DELETE CASCADE，原子），不再两步删可能残留空 session。
- `deleteRemoteMessage` 按 id **或** client_id 删（超时但实际插入成功时本地存的是 local id，否则删不掉远端 → 下次 fetch「复活」）；非 UUID 的 local id 不查 uuid 列防类型错。
- `chatStorage` 加 pagehide/visibilitychange 同步 flush——安卓杀后台不再丢 150ms debounce 窗口内的最近消息（离线时是唯一副本）。
- `ensureUserSettings` 改 upsert（onConflict user_id），并发首登不再撞主键 23505 导致设置加载失败。
- `weather` cityOverride 结果不写共享缓存，避免之后无 override 的 GPS 调用拿到 override 城市天气。

### 新增：连发（批量回复）
- composer 发送改走 `queueUserMessage`：只落用户消息 + 2 秒 debounce,期间再发重置;到点用 `sendMessage(skipUser)` 一次性回这一批。连发期间无流式,不被停止键挡。
- 后续修复:打字推后定时器防抢答(窗口放宽 2.5s,见 Debug 日志);跨会话连发不丢回复(切会话时先 flush 旧会话那批);窗口内编辑/重新生成会撤销挂着的定时器防双重生成,删消息只推后;定时器到点如有流在跑则推迟一个窗口再回,不抢 streamingController。
- 贴纸名导入时过滤 `[`/`]`/换行(会弄坏 `[sticker:名字]` 标记,解析正则吃不下)。

### 清理：移除死掉的语音输入依赖
- `@capacitor-community/speech-recognition` 功能早已移除但依赖还挂着:从 package.json、AndroidManifest(`RECORD_AUDIO` + microphone feature)、capacitor gradle 引用全部清掉(CI `cap sync` 会按 package.json 重新生成 gradle,安全)。**原生改动,重打 APK 生效**。

### 新增：表情包（共用一套,你和 AI 都能发）
- `[sticker:名字]` 引用,前端双方都解析成图片;`storage/stickers.ts` 压缩成小 PNG 存 localStorage;`+ → 🧷 表情` 导入/发送/删除;可用贴纸列表注入 system prompt(`buildStickerSystemSection`)让 AI 自己发。

### 杂项（TTS 后续）
- TTS 模型列表改小写 `speech-2.8-turbo/hd`(MiniMax 拒显示名大小写);失败回 200 + 真实 `status_msg`;`@capacitor/clipboard` 修复复制;移除内置 🎤 语音输入。

---

## 2026-06-09 改动记录

### 新增：语音消息（TTS · MiniMax）
- AI 用 `[voice]…[/voice]` 包内容 → 微信式语音条（点 ▶ 才合成、缓存、转文字、未配置降级为文字）。`tts` Edge Function 代理 MiniMax T2A v2（hex→base64，key 从设置页发、不入库/仓库）；设置页 🔊 语音区（voice_id/key/GroupId/Base URL/模型）。详见 [features/voice-tts.md](features/voice-tts.md)。
- **失败也返回 200 + 真实原因**：`supabase.functions.invoke` 会把任何非 2xx 压成笼统 "non-2xx status code"，所以 tts 失败时回 200 带 MiniMax 的 `status_msg`，App 红字能看到真因。

### 修复：复制不进剪贴板 → 改用原生 `@capacitor/clipboard`
- WebView 里 `navigator.clipboard` 静默失效；改用原生 Clipboard 插件 + navigator 兜底 + 复制成功震一下。新增原生依赖,需重打 APK。

### 移除：内置 🎤 语音输入
- `@capacitor-community/speech-recognition` 在 Android 11+ 因缺 RecognitionService `<queries>` 静默失效,且和输入法语音转文字重复 → 撤掉,用输入法的。

---

## 2026-06-07 改动记录

### 修复：用量统计把"没回复成功"的失败请求也算上了
- **症状**：`/usage` 把失败/报错的消息也统计进去（调用计数虚高）。
- **根因**：`flushUsageRecord` 在硬失败（无 usage、0 token）时用 `forceRecord` 强插一条 0-token 行（本是为存 `request_debug` 排查）——0 成本却占了一条调用。
- **修法**：改成**没拿到 usage 就不记**（`if (!lastUsage) return`），不再 force-insert 0-token 失败行。失败但已产生计费（部分消费）的仍会按真实 token 记。另外把库里已有的 22 条 0-token 行清掉了（服务端，立即生效）。
- ⚠️ 代码部分纯前端，需重打 APK；DB 清理已即时生效。

### 修复：朋友圈/TA 动态正文里漏出 `<thinking>` 标签
- **症状**：TA 动态（syzygy）发的帖子正文开头带一整段 `<thinking>…</thinking>`，即使聊天思考链已关。
- **根因**：发帖路径 `reasoning:false`（原生思考确实关了），但模型（多为 `*-thinking` 变体）会把思考当**纯文字**写进 content；而发帖路径**没有**像聊天那样剥离 `<thinking>`（聊天有 `splitReasoningFromContent`）。
- **修法**：`AssistantHomePage.tsx` / `MyHomePage.tsx` 取到正文后用正则剥掉 `<thinking>…</thinking>` 和 `<reasoning>…</reasoning>` 再保存。
- 备注：若默认模型选的是 `*-thinking` 变体，它仍会**花思考 token 再被剥掉**（浪费）；想省可把朋友圈默认模型换成非 thinking 版。⚠️ 纯前端，需重打 APK。

---

## 2026-06-06 改动记录

### 修复:金瓜瓜报错「temperature 和 top_p 不能同时指定」
- **症状**:切到金瓜瓜后弹错 `` `temperature` and `top_p` cannot both be specified for this model ``。
- **根因**:`anthropic.ts` 在不开思考链时,会把 `temperature` 和 `top_p` **两个都透传**给上游;风铃草上游只允许其一。
- **修法**:原生路径上**两者并存时只保留 `temperature`、丢掉 `top_p`**(无 temperature 时才用 top_p)。对所有上游都安全,Anthropic 本身也建议只用一个。
- ⚠️ 纯前端,需重新打 APK 才生效。

### 新增:中转预设(多个中转站一键切换)
- **需求**:想存多家中转(当前家、金瓜瓜…)随时切,而不是每次覆盖那唯一的自定义槽。
- **做法(低风险)**:`apiProvider.ts` 加 `RelayPreset`(name/baseUrl/apiKey/format)+ `get/save/delete/applyRelayPreset`,存 `nimbus_relay_presets_v1`。**故意不新增 provider 类型**——`applyRelayPreset` 只是把预设值写进现有 msuicode 槽并设为激活,所以全套按 `'openrouter'|'msuicode'` 分支的路由/缓存/续命逻辑**一行都不用动**。
- **UI**:设置 → 中转 API Key 区,加「＋ 把当前中转存为预设」+ 预设列表(点一下应用 / × 删除)。
- ⚠️ 纯前端,需重新打 APK 才生效。

### 新增:历史图片转文字描述(省缓存冷写 + 不污染前缀)
- **动机**:每轮都会把会话里的历史图片原样重发,冷写/缓存失效时很贵(图片 token 重),还撑大前缀。
- **做法(低风险)**:新增 `storage/imageCaptions.ts` 本地缓存层(url 哈希 → 描述)。图片**第一次出现照常发原图**(模型看得到)并异步用当前模型生成一两句中文描述;**之后的轮次改发 `[图片：描述]` 文字**。原图仍存在消息里供 UI 显示——只改"发给模型的内容"。captioning 失败就没有缓存项 → 继续发原图,**优雅回退、不动消息/数据库**。
- ⚠️ 纯前端,需重新打 APK 才生效。

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
> ⚠️ 本节第一条**已于 2026-06-06 推翻**：放开了中转(Anthropic 兼容格式)的原生缓存，金瓜瓜实测 99% 命中。见上方 06-06「prompt 缓存放开到金瓜瓜」与 [docs/caching.md](caching.md)。
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
