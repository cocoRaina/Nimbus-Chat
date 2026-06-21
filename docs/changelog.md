# 改动记录 & Debug 日志

> 从 README 拆出来的开发历史与踩坑记录(README 太长了)。功能清单和使用说明见 [README](../README.md)。

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
| 工具迭代 cached_tokens = 0(但 chat 2 还命中)| Anthropic 服务端在请求里有 `tool_use`/`tool_result` block 时,HEAD 和 BP4 cache 都 miss(只有 BP1 walk-up 还工作)。同时如果还留 HEAD marker,会写一份 ~77k token 的"没人读"的新缓存白烧 \$2 | ~~结构性检测:最后一条 user message 之后有 tool block 时,**只标 BP1**,不标 HEAD/BP4~~ **（已被下一条修正,见 ↓）** |
| 工具迭代历史全价重读、钱哗哗烧(2026-06)| 上一条的"只标 BP1"修法**矫枉过正**:它让 BP1↔最后一条 user 之间的几万 token 历史在**每次**工具调用时全价重读。`search_memory` 几乎每轮触发 → 长会话里"写日记/写信/查记忆"等带工具的轮次主导账单。复查 Anthropic 文档发现:`cache_control` **可放 tool_result**,walk-up 回溯窗口 **20 个内容块**,而 Nimbus 每轮工具调用只 1~2 块、稳定命中。旧顾虑(标 HEAD 会写含 tool 块的大缓存)是误判——标"最后一条 user"的前缀**不含**其后 tool 块,且正是上一轮 HEAD 已写过的缓存,本轮是读命中不是写 | 工具迭代时标 **BP1 + 最后一条 user message**(在 tool 块之前),**不标 tool_result 本身**。历史回到 0.1× 读命中。详见 [caching.md §7](caching.md) |
| MAX_TOOL_ITERATIONS 收尾每次冷写 ~$0.15 | `App.tsx` 收尾(`tool_choice='none'` 那段)用 `delete body.tools` 阻止模型继续调工具,但 `tools` 是 Anthropic cache key 的一部分,删了之后整段前缀字节不匹配 → 全量冷写 ~50k。**根本原因**是 `convertOpenAiRequestToAnthropic` 没翻译 `tool_choice` 字段,silent 丢掉,删 tools 是当时唯一阻止调用的方式 | converter 加 `tool_choice` 翻译(`'none'/'auto'/'any'` → `{type:...}`,`'required'` → `{type:'any'}`,`{type:'function',function:{name}}` → `{type:'tool',name}`);收尾保留 `tools`,只用 `tool_choice:'none'` 阻止调用。cache 命中,收尾从 $0.15 降到 $0.015 |
| 工具迭代每轮第 2 次调用必冷写一次(2026-06-18)| 为省 thinking 输出,旧代码只在**迭代 1**开 thinking、迭代 2+ 关掉。但 `thinking` 参数**本身是缓存键的一部分**(开/关让前缀差 **22 token**:实测两组工具冷写对 `61265/61243`、`67780/67758` 差值都恰好 22,与 ping 实测的 thinking 链差 `65931/65909=22` 同源)。于是迭代 2 落到一条**独立缓存链**,每次工具调用第 2 次迭代必冷写 ~¥1.43 | 所有迭代**统一开 thinking**(budget 一字不差),迭代 2+ 改为**读迭代 1 缓存**。连带坑:工具选择轮把 `max_tokens` cap 到 512,而 extended thinking 要求 `max_tokens > budget`(2000)→ 512<2000 会 400 或被 OR 静默丢 thinking(又退回不一致),故 cap 提到 `budget+512`。详见 [caching.md §7](caching.md) |
| 中转保活 ping 永远冷写 ~$0.22 | `cache_keepalive` Edge Function 用 `stream:false` 发非流 ping,推测 relay 把 stream:true(聊天)和 stream:false(ping)路由到不同后端节点,Anthropic 那边落在不同缓存分片。Anthropic 官方文档说 stream 字段不进 cache key,但 relay 黑盒拗不过。验证字节稳定性(tools 顺序硬编码 / system 静态 / 时间戳每条消息固化 / 图像 base64 确定性)都 OK,根本不是字节问题 | ~~停掉 `pg_cron` job~~ **（上面这条推测已证伪,见下一条）** |
| 服务端保活其实能用、之前的"stream 路由"是误判(2026-06-17)| 上一条把锅扣给"stream:true/false 路由到不同节点",**错了**。真因:① `App.tsx` 写死 `activeProvider==='openrouter'` 才存请求体 → 金瓜瓜用户的 `cache_keepalive_state` 表是空的,cron 扫不到行;② 复测时用 `net.http_post`(pg_net/libcurl)直打金瓜瓜,libcurl 对该 relay 有 HTTP/2 framing bug 全挂,被误读成"ping 不命中"。~~改用 Deno fetch 实测 cache_read=65909 整段命中~~**(这个"命中"是假阳性,见下一条)** | ① 触发门改 `isClaudeModel && (provider==='openrouter' \|\| format==='anthropic')`;② Edge Function 加安静时段;③ 重启 `pg_cron` job 3 |
| ping 刷的是另一条缓存链、真实聊天该冷写还是冷写(2026-06-17,最关键)| 用户截图发现:一条带 thinking 的真实聊天命中缓存(`缓存读 65,874`)后 **13 分钟**,服务端 ping 仍然**冷写** `65,909`(¥1.32)。说明 ping 落在和聊天**不同的缓存链**上。探针(临时 Edge Function 跑 5 个单变量请求读 usage)定位:金瓜瓜/Anthropic 把**带 thinking**(聊天,缓存 `65931`)和**不带 thinking**(旧 ping 删了 thinking,缓存 `65909`)当成**两条独立链**,互不相通。旧 ping 看似命中,其实读的是**自己上一条 ping** 的私有副本,真实聊天永远读不到。另测:`stream` 不影响缓存键(非流 ping 读到流式聊天的 65931);`budget_tokens` **是**缓存键一部分(budget 1024 vs 2000 冷写)| ping **保留 `thinking` + 原样 budget**,`max_tokens=budget+1`(extended thinking 要求 max_tokens>budget;budget 是上限,模型实际只吐 ~17 token,ping 仍 ~¥0.07)。验证:生产 ping 现读 `cache_read=65931 / cache_create=0 / output=17`,与真实聊天同链。详见 [caching.md §9](caching.md) |
| 工具调用后隔 >1h 再聊必冷写(2026-06-18)| 服务端 keepalive 快照存的是 `lastSentBody`=**最后一次迭代**(tool 模式,messages 末尾带 `tool_use`/`tool_result`)的请求体,和普通聊天读的链不是同一条 → ping 一直刷 tool 链、普通链照样过期 → 工具调用后隔 >1h 再聊冷写(实测 18:11、23:39 两次,都紧跟在带工具的轮次后)| 快照改存**第一次迭代**(普通模式、HEAD 在当前 user、无 tool 块)的 `firstIterBody`,正是后续普通消息 walk-up 命中的那条链 |
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
| 深/浅/REM 分段永远 null（总睡眠时长正常） | Health Connect 里明明有分段（截图可见 `1h 11m deep sleep` 等），但 Capgo 每个睡眠 session 只返回**一个** `HealthSample`，父 session 的 `sleepState` 是泛型 `sleeping`，分段藏在该样本的 `stages[]` 数组里。`aggregateSamples` 只读了 `s.sleepState`，于是分段累加恒为 0 → 写 null | `case 'sleep'` 改成：`hasStageData && stages.length>0` 时遍历 `s.stages[]`，按 `stage.stage`（`deep`/`light`/`rem`）累加 `stage.durationMinutes`；无 stage 数据的设备回退到 session 级 `sleepState`（`storage/healthSync.ts`）|
| 步数/心率近 3 天里第 3 天永远 null | steps & HR 聚合只查今天+昨天 2 天，但 sleep/血氧走 48-72h `readSamples` 窗口，于是同一天同步后第 3 天有睡眠没步数/心率 | steps 与 HR 的 `queryAggregated` 循环从 `[0,1]` 扩到 `[0,1,2]`（各请求仍间隔 250ms 防限速）|
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

## 2026-06-21

### 自发叫醒消息：列名写错，从来没真正触发过（关键修）

`proactive_dispatch` 的自发叫醒分支查 `cache_keepalive_state` 时 `select` 了**两个不存在的列** `api_key`、`model`。PostgREST 对不存在的列**静默返回 null**，于是 `validRouting=false`，每次都走 `spontaneous='bad_routing'` 提前返回——**从来没有真正调用过 AI**。用户「说了话也不主动叫醒」就是这个原因。

- **根因**：真正的 API key 列叫 `openrouter_key`（历史命名，见 `cache_keepalive`），模型名在 `body.model` 里，没有独立的 `api_key`/`model` 列。
- **修**：`select` 改 `openrouter_key`，`model` 从 `body.model` 取。
- **实弹验证**（用 `pg_net` 从 SQL 复刻整条自发请求打中转站，读 `usage`）：`status 200` + `cache_read_input_tokens=29208` + `cache_creation_input_tokens=0`——**缓存命中、零冷写**，每次自发约 ¥0.05–0.1（热读），不烧钱。模型正常返回 `NO_SEND`/消息。之前看到的 `no_send` 是 AI 正常决策、不是报错。

### 自发 vs 定时消息「双发撞车」（防御性修）

每分钟的 `send_proactive_push` 会抢先把 `proactive_queue` 到期行标 `sent=true`，导致 `proactive_dispatch` 里 `dispatched` 恒为 0、那个「刚发过定时消息就跳过自发」的 `dispatched>0` 守卫失效，理论上会「定时推送 + 自发」连发。修：发自发前额外查「最近 30min 内 `fire_at` 已触发的队列行」，有就 `spontaneous='recent_scheduled'` 跳过。
> 注：经查 `send_proactive_push` 的 cron（job 1 `send-proactive-pushes`）**5/30 起 `active=false` 已停用**（FCM 推送退役，改用 WorkManager `poll_proactive` 轮询），所以这个撞车当前不会真发生，修复是留作防御。

### Firebase 私钥从硬编码挪进 Secrets

`send_proactive_push` 里内联了整把 Firebase service-account 私钥（`Deno.env.get(...) ?? '<硬编码>'`），且该函数源码**从未进仓库**（只在 Supabase 上）。改：私钥移到 `FIREBASE_PRIVATE_KEY` Edge Function secret（已设并用「换 Google token 成功」验证），源码删钥后纳入仓库；`config.toml` 给它固定 `verify_jwt=false`（它的 cron caller 发的是空 Bearer，`supabase.service_role_key` GUC 在本项目取不到值，默认 `true` 会 401）。CI 部署后 Supabase 上的明文私钥也清掉了（v5）。

### 复查旧修复：memories 有 11 条 embedding 缺失（补）

顺手核验「最近修的东西」时发现 `memories` 表 11 行 `embedding IS NULL`（其余 diaries/letters/timeline/posts/replies 全 0）。不是异步延迟——9 条来自 6/19、2 条来自 6/9，早过窗口。和 6/16–6/19 日记缺嵌入同源：embedding key 删除窗口期 auto_embed 静默失败，当时补了日记**漏了 memories**。这些（偏好/规则/情感等）语义搜索**完全搜不到**。`auto_embed_memory` 触发器逻辑是 `embedding IS NULL AND content IS NOT NULL` 才发，所以 `UPDATE memories SET content=content WHERE embedding IS NULL` 即可重新触发补嵌入。补完 58/58 全部命中。
> 隐患：embedding key 一旦中断，失败行会**永久 null** 直到有人手动重试，没有自动兜底。可考虑加个 cron 周期性给 null embedding 补嵌入。

## 2026-06-20

### 自发主动消息：命中 BP1 缓存 + 今日门（改）

`proactive_dispatch` 的"叫醒"调用(自发主动消息)两处优化:

1. **命中缓存**:原来重新从 `user_settings.system_prompt` 拼纯文本 system,全价计费。改为**复用整个 `cache_keepalive_state.body`**(保活 ping 每 55min 刷的那条热缓存的原始 body),只替换 system 末尾追加块 + messages。保活每 55min 续命、自发在静默 1h 后触发,缓存必热,命中率接近 100%,Opus 下每次省约 20%。首次冷启动(`body` 为空)回退到 `user_settings` 纯文本(无 `cache_control`,不冷写)。
   - **⚠️ 关键修(同日)**:第一版只复用了 `body.system`,**漏了 `tools`/`thinking`/`metadata.user_id`**。这三者都是缓存键的一部分(tools 在缓存前缀里、thinking 开/关是两条独立链、user_id 做粘性路由),漏掉 → 前缀对不上热缓存 → **不命中**;而复用的 system 又带着 `cache_control` → 反而**冷写 ¥1.5**,比原来纯字符串(不带 cache_control、不冷写)更糟。修法:复用**完整 body**,保留 `tools` 但加 `tool_choice:{type:'none'}` 强制出文字(这个组合 caching §7 验证过仍命中);`max_tokens` 缓存中性,按 thinking budget 放宽到 `budget+1024`(adaptive/无 thinking 给 1024)。
2. **今日门**:和 `cache_keepalive` 同款逻辑——只有当天 08:00(北京)后有过用户消息才触发自发。`lastUserMsg.created_at < todayWakingStartMs` 则 `spontaneous='not_active_today'`,不调 API。防止昨晚最后一条消息导致清晨被自动叫醒,也确保不会拿隔夜状态触发计费。

### 自发主动消息本地通知:WorkManager 后台轮询(新)

app 关着时,自发主动消息(服务端 `proactive_dispatch` 随机时刻写库)没法像定时消息那样预排本地 alarm。新增原生 **WorkManager** 周期任务(~15min)轮询 `poll_proactive` Edge Function,有新 `provider='spontaneous'` 消息就弹本地通知。不依赖 FCM/HMS,华为等无 GMS 机型也能用。`ProactivePollPlugin.java`(配置/取消 PeriodicWorkRequest)+ `ProactivePollWorker.java`(POST + 通知 + `since` 指针推进)+ `ProactivePoll.ts`(TS 桥)。**原生改动,重打 APK 生效。**

**踩坑:WorkManager `ListenableFuture` 编译失败(两条 classpath 不一致)**

`ProactivePollWorker extends Worker`,`Worker` 基类签名引用 Guava 的 `com.google.common.util.concurrent.ListenableFuture`,但这个类在两条 classpath 上状态矛盾,绕了三次才修对:

| 尝试 | 结果 |
|---|---|
| 加 `androidx.concurrent:concurrent-futures` | ❌ 那是 AndroidX 的库,根本不含 Guava 的 `ListenableFuture` |
| 加 `implementation "com.google.guava:listenablefuture:1.0"` | ❌ 传递依赖拉了 `listenablefuture:9999.0-empty-to-avoid-conflict-with-guava`(空 jar,版本号故意巨大),Gradle 按版本号选了空 jar,类还是缺 |
| `configurations.all { force "...:1.0" }` 全局强制 | ❌ 编译过了,但运行 classpath 上某 Capacitor 插件**早已传递完整 guava-31.1-android**(自带该类),force 1.0 把它也塞进运行时 → 重复类,dex(CheckDuplicateClasses)失败 |
| **只在 `*CompileClasspath` force 1.0** | ✅ 编译 classpath 补上缺的类、运行 classpath 不动(guava 独家提供),两边都干净 |

根因是**编译 classpath 只看得到空占位 jar、运行 classpath 有完整 guava**,所以必须只补编译侧、不碰运行侧。`android/app/build.gradle`。

### 搜索：交接信 / 日记近期内容搜不到（修）

- **根因 1**：6/16–6/19 的日记和 6/19 交接信 embedding 缺失（auto_embed 在旧 SiliconFlow key 删掉期间静默失败），手动补嵌入。
- **根因 2**：`search_letters` 纯相似度排序，新信频繁输给旧信；`search_memories_hybrid` 时间权重系数 0.006 太小，近期内容排不上来。
- **修**：`search_letters` 改为 60% 相似度 + 40% 新鲜度排序；`search_memories_hybrid` 时间系数从 0.006 → 0.05；`search_handoff` Edge Function 加 `days`/`after` 过滤参数，AI 可以指定"只搜最近 N 天"。
- **踩坑**：`search_letters` 加 `filter_after` 参数时用 `CREATE OR REPLACE`，因签名变化产生两个重载，PostgREST 调用歧义报 non-2xx → `search_handoff` 整个挂掉。删掉旧的三参数重载修复。

### 消息加载：新窗口只显示几条消息（修）

`fetchRemoteMessages` 按 `client_created_at ASC` 排序、不加 limit，PostgREST 默认 1000 行上限截断后只返回**最老的 1000 条**。用户有 3641 条消息，今天新开窗口的消息完全不在里面，只有 `refreshCurrentSession`（limit=20）补回来一点。改为 `DESC` 排序，保证最近的 1000 条优先加载；localStorage 兜底老历史。

### 主动消息：用户回复后服务端 cron 仍然投递（修）

客户端 `cancelProactiveNotification()` 的 DELETE 是 fire-and-forget，网络抖动时静默失败，`proactive_dispatch` cron 到点照样插消息。在 claim 行之后、insert 之前加一条查询：`session` 里 `fire_at` 之后有 `role='user'` 的消息则跳过。不依赖客户端 DELETE 成功，从服务端兜底。

### 缓存：发图片后下一条消息冷写（修）

图片在 HEAD 时被缓存进前缀（含 base64 bytes），下一轮图片替换成文字描述后前缀不匹配 → 全量冷写（~31k token，≈¥1.3）。`applyClaudeCaching` 检测 HEAD 是否含 `image_url`/`image` block，有则跳过对 HEAD 的标记，只保留 BP1 + BP4。下一轮图片变文字后服务端 walk-up 到前一个 BP4，只写一小段扩展（≈几百 token，≈¥0.02）。

### 消息加载：加了 limit(300) 防慢加载（改）

`fetchRemoteMessages` 只改排序方向不加 limit，PostgREST 仍默认返回 1000 行（用户现有 3654 条），每次新窗口都下载 ~800KB JSON，手机网络下体验差。加 `.limit(300)` 使初始加载约 240KB；localStorage 存着老历史，300 条已覆盖约 2.5 天的对话窗口。

### 主动消息：发到 keepalive body 格式错误（修）

`proactive_dispatch` 往 `cache_keepalive_state.body` 追加主动消息时用了字符串格式 `{ content: 'text' }`，而 keepalive body 是 Anthropic 原生格式，assistant 消息 content 必须是 `[{ type: 'text', text: '...' }]` 数组。格式不一致导致 cache key 不匹配，主动消息发出后下次真实请求的那段前缀 miss，多写一段缓存。已改为数组格式。

### 主动消息：调度后用户活跃仍触发（修）

`proactive_dispatch` 的"用户已回复"检查用 `created_at > fire_at`（火点之后有没有消息），但 fire_at 是未来时刻，用户在调度后、fire_at 前的活跃完全绕过检查 → 已经过时的提醒照常发出。例：12:32 AI 调度 55min 后的 1:27pm 提醒，用户 12:46 和 12:47 继续发消息，检查没命中，1:27pm 提醒仍发出。

修：对 `persist=false` 的普通提醒，截止时间改为 `created_at`（调度时刻）：调度后有任何用户消息就跳过。对 `persist=true` 的闹钟，保留 fire_at 截止（睡前聊天不应取消早起闹钟）。

---

## 2026-06-17

### 主动消息：冷启动首次前台丢失（修）

清掉通知后冷启动 App，主动消息不弹。根因：Android 冷启动时 Capacitor `appStateChange(isActive:true)` 在 React auth 解析完、`visibilitychange` 监听器注册**之前**就 fire 了，于是首次进前台的那次检查永远被错过。修：监听器注册后用 `window.setTimeout(handleVisibilityChange, 0)` 补跑一次（等所有 effect 落地后），cleanup 里 `clearTimeout`。`App.tsx`。

### 状态栏：每页颜色与各自 header 底色统一

之前状态栏只有一个固定色，和各页 header 对不上。`storage/statusBar.ts` 加 `syncStatusBarToColor(hex)`、`syncStatusBarToAccent()`（读 `--accent`），`App.tsx` 按路由切：聊天=`--accent` #DBEAFE、记忆库/用量=#F8FAFC、设置=#FFFFFF、首页=#F4F8FC（渐变顶色，无缝融进背景）。

- **踩坑**：一度想给首页用 `setOverlaysWebView({overlay:true})` 让背景图顶到状态栏下做「真全屏」，但在路由间来回切 overlay 会让其他页短暂进 overlay 态、内容被摄像头挖孔挡住。最终放弃 overlay，改用「首页状态栏=渐变顶色」纯色融合，安全区零改动。
- ⚠️ 没动 header 底色，只改状态栏（上次误改 header 背景被骂过，已 revert）。

### 首页布局：全屏 + 垂直居中

- 删掉 `.home-page` 的 `padding:1rem`（之前让背景像描了一圈边，不全屏）。
- `.phone-shell` 改 `min-height:100dvh` 撑满视口，消掉底部那块空白渐变。
- `.home-page:not(.--settings) .phone-shell { justify-content:center }`：内容不够一屏时上下留白均分（用户选的「整体垂直居中」）；`min-height` 而非定高，编辑模式内容超屏照常滚动不裁切。设置态布局不受影响。

### 记忆库 toolbar 三行 + 设置改名

- `source-filter` 按钮（全部/手动/自动）溢出成多行 → toolbar 改 `flex-direction:column`、`source-filter` 加 `flex-wrap:nowrap`；active 态改浅蓝 #DBEAFE。
- 锁定预算 🔒 单独挪到 `toolbar-row3`，防止和筛选挤一行溢出。
- 设置页标题「API设置」→「设置」。

## 2026-06-16

### 缓存：工具迭代恢复历史命中（省钱·重要）

工具调用轮次（写日记/写信/查记忆等）此前**只标 BP1**，导致 BP1↔最后一条 user 之间的几万 token 历史每次工具调用全价重读——`search_memory` 几乎每轮触发，长会话里这是账单主因。复查 Anthropic 文档确认 `cache_control` 可放 `tool_result`、walk-up 回溯窗口 20 块（Nimbus 每轮仅 1~2 块稳定命中），修正为工具迭代时标 **BP1 + 最后一条 user message**（在 tool 块之前，正是上一轮 HEAD 写过的前缀，本轮读命中）。`applyClaudeCaching` in `App.tsx`。详见 [caching.md §7](caching.md)。

### 主页重设计：冰蓝配色 + 背景图 + 去框

- **去掉时钟**，主页直接从打卡卡片开始，顶部只留一行小日期。
- **背景图上传**：编辑模式工具栏「＋ 背景 / 换背景 / 移除背景」，存 IndexedDB（`backgroundImageKey` 进 `HomeSettingsState`），挂在 `<main>` 的 inline `backgroundImage` 上铺满全页。踩坑：`.home-page--has-bg { background: none !important }` 的 `!important` 优先级高于 inline style，把上传的图强制盖成 none → 删掉该规则才生效。
- **去掉 phone-shell 框**：`border-radius:0` + `box-shadow:none`，`__mask` 直接 `display:none`，内容浮在背景上。
- **冰蓝配色**替换之前的灰 slate：BG `#F4F8FC`、SURFACE `#DEEAF5`、MUTED `#C5D6EC`、ACCENT `#98B5D8`、STRONG `#789EC8`、TEXT `#586878`；数字渐变与打卡按钮改蓝；glass-card 改白色磨砂在蓝雾底上提升层次。
- **图标网格 4 列 → 3 列**：9 个图标正好 3×3，无孤儿行。
- **清理 Together 卡片**：移除卡内重复日期 + ❤️天数 pill（与大数字重复）。

## 2026-06-14

### 网易云放歌 + 媒体控制（新增 2 个 APK 工具）

让 API 哥能**放指定的歌** + 控制播放（工具数 17 → 19）：

- **`play_music`**：新建 `supabase/functions/netease_search` Edge Function（JWT 校验，服务端带浏览器头 + `Referer` 打 `music.163.com/api/search/get`，绕 WebView CORS，返回 `{id,name,artist,duration_seconds}`）。`App.tsx` 工具分支调用后取首条结果，用 `orpheus://song?id=xxx` deep link 直接拉起网易云播放。
- **`control_media`**：新建自定义原生插件 `MediaControl`（`MediaControlPlugin.java` + `src/plugins/MediaControlPlugin.ts` 桥，`MainActivity` 注册），走 `AudioManager.dispatchMediaKeyEvent` 发媒体键（play/pause/next/previous），任意正在播放的 App 都生效。
- 两个工具都 `Capacitor.getPlatform() !== 'web'` 平台门控（deep link / 媒体键只在 APK 有意义）。原生插件改动需重打 APK 生效。
- **局限**：`play_music` 只取搜索首条（网易云首条通常即最热门正确匹配），未做多结果消歧。

### 🩹 play_music deep link 三连修（最终确认可用）

deep link 格式踩了三个坑，逐一记录：

1. **`orpheus://song?id=SONGID`（query string 格式）** → 打开 app 但停在首页，没导航到歌曲。原因：网易云只识别 path 格式。
2. **`https://music.163.com/song?id=SONGID` + `setPackage("com.netease.cloudmusic")`** → 打开了浏览器网页版（顶部「立即体验」条，底部「打开」按钮）。原因：网易云没有把 `music.163.com` 注册为 Android App Link，`setPackage` 失效后降级到浏览器。
3. **`orpheus://song/SONGID/?autoplay=1`（path 格式 + autoplay 参数）** ✅ → 直接打开 app 并播放指定歌曲。

正确格式出处：NFC 音乐卡片社区（多人写 `orpheus://song/{id}/?autoplay=1` 进 NTAG213 芯片做「碰一下播歌」），可信度高。`?autoplay=1` 是关键——没有这个只会跳到歌曲详情页但不播放。

**教训**：**纯前端(TS/CSS)改动也打进 APK，同样要装新包才生效**，只有 Edge Function 改动不需要重装——每次说「不用装 APK」都要先想想是不是 Edge Function。

---+ 精准媒体控制 + 修 deep link bug

接着把「读当前播放」补上（工具数 19 → 20），顺手升级了控制精度：

- **`get_now_playing`**（新工具）：读当前正在播的歌名/歌手/专辑/进度/来源 App。原生走 `MediaSessionManager.getActiveSessions()` → `MediaController.getMetadata()/getPlaybackState()`，优先挑处于 `STATE_PLAYING` 的会话。
- **通知使用权**：`getActiveSessions()` 要求调用方是「已启用的通知监听器」。新建空壳 `NowPlayingListener extends NotificationListenerService`（`AndroidManifest` 注册，`BIND_NOTIFICATION_LISTENER_SERVICE` + `exported=false`）——**不读任何通知**，纯当权限开关。`MediaControlPlugin` 加 `hasPermission()` / `requestPermission()`（开 `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`）；权限检查读 `Settings.Secure.enabled_notification_listeners`。`get_now_playing` 工具发现没权限时自动弹设置页 + 回 `NO_PERMISSION` 让 AI 引导用户。
- **`control_media` 升级**：有通知使用权时改走 `MediaController.getTransportControls()` 精准控制那个正在播的会话（比广播全局媒体键可靠）；没权限时仍降级 `dispatchMediaKeyEvent`。
- **🩹 修 `play_music` deep link bug**：上一条记录里 `play_music` 用了 `@capacitor/app` 的 `App.openUrl()` —— **该 API 在 `@capacitor/app` v8 不存在**（`AppPlugin` 无此方法），`tsc -b` 报 TS2339，等于上次根本没过 `npm run build`，装上 APK 也只会静默失败。改成给 `MediaControl` 原生插件加 `openUrl()`（发 `ACTION_VIEW` Intent），App.tsx 改用 `MediaControlPlugin.openUrl()`。教训：**原生相关改动 commit 前必须真跑 `npm run build`**（不只是 `tsc --noEmit`，两者用的 tsconfig 不同）。

---

### 主动消息：服务端兜底派发 + 三连修

主动消息原来只在「用户打开 app」时才插入，三个坑一起修（详见 [features/proactive.md](features/proactive.md)）：

1. **🩹 连发三条**：`visibilitychange` + Capacitor `appStateChange` + `localNotificationActionPerformed` 三个事件在前台/点通知时**同时**触发同一个 `handleVisibilityChange`，各自同步读到同一条 pending 就各插一遍（`clearPendingProactive` 在异步 `finally` 里太晚）。修：读到 pending **立即同步清 localStorage**，后两次调用读不到；1h nudge 加 `proactiveNudgePendingRef` 防并发。
2. **🩹 时间戳错**：插入用 `new Date()`（你点进去的时刻），不是计划时间。修：`client_created_at` 改用 `entry.fireAt`，气泡显示「本该发出的时间」。
3. **新增服务端派发**：建 `proactive_queue` 表 + `proactive_dispatch` Edge Function（pg_cron `*/5`），到点扫未发的行写进 `messages`——**app 关着也照写**，不再依赖你点通知。客户端/服务端靠 `UPDATE … WHERE sent=false` 原子抢占防重；前台回 app 调 `fetchSessionRecentMessages` 拉最近 20 条把离线期间服务端写的消息立刻合并显示。
4. **🩹 persist 一致性**：发新消息时本地只清 transient（`clearPendingProactive`），但服务端 delete 原本 `.eq('sent',false)` 会连 persist（叫醒闹钟）一起删 → 本地 persist 还在、DB 行没了 → persist 本地触发时拿 `queueId` claim 失败误判「服务端已发」→ 消息丢。修：delete 加 `.eq('persist', false)`，persist 在本地和 DB 都保留。

> 旧 FCM 推送方案（`send_proactive_push` 函数 + 旧 `proactive_queue` 表 + `fcm_tokens`）此前已彻底移除；现在的 `proactive_queue` 是新建的，用途是服务端**写库派发**，非远程推送。`docs/features/proactive.md` 同步重写。

---

## 2026-06-13

### 思考链 + 工具卡片交错显示（claude.ai 风格）

之前一条助手消息把所有思考挤进一个折叠面板、所有工具卡片叠在一起，看不出「先想了啥 → 调了啥工具 → 又想了啥」的真实顺序。改成按发生顺序交错：

- `App.tsx` `sendMessage` 工具循环里加 `currentIterationReasoning`（每轮单独累计思考）+ `flowEvents[]`，工具分支前 push `{type:'thinking'}`、工具执行后 push `{type:'tool',index}`，最后一轮（非工具）收尾再 push 末段思考。存进 `message.meta.flow`（`types.ts` 加字段）。
- `ChatPage` 有 `flow` 时按事件序列交错渲染「思考面板 → 工具卡 → 思考面板 → 正文」；旧消息无 `flow` 回退到原「单面板 + 卡片堆叠」。
- 纯前端，等 APK 生效。

### `<thinking>` 裸标签泄漏进正文 + 思考中途调工具吞正文

两个流式解析 bug（截图里思考标签直接显示成文字、或工具后正文消失）：

- **双标签**：`splitReasoningFromContent` 原本只认 `<think>`/`</think>`（DeepSeek 式），遇到 `<thinking>`/`</thinking>`（部分 Claude 兼容中转）就把整个标签当正文吐出来。改成同时识别两种开标签、各配对应闭标签，优先匹配更长的（防 `<thinking>` 被当 `<think>` 截断）。
- **迭代重置**：模型「思考没闭合就调工具」时，`isInThink` 会卡在 `true`，下一轮工具返回后的正文整段被吞进思考面板（气泡空白）。改成每轮迭代开头强制 `isInThink=false` + 清 `thinkCarry`/`activeCloseTag`。

### 微信/LINE 风格附件 + 表情面板

输入栏交互重做（`ChatPage.tsx` + `.css`）：

- **表情独立出来**：原来藏在 `+ → 🧷 表情` 三级菜单里，挪成输入栏专属 🧷 按钮。点开 **LINE 风格** 4 列网格面板（贴纸大图、可滚动、虚线导入格、底部滑入动画）。
- **`+` 改微信风格**：底部白色面板（圆角顶 + 拖动把手）放 `📷 拍照 / 🖼 从相册` 两个图标格子。两个面板互斥。

### 相机修复：改用 `@capacitor/camera` 原生相机

APK 里点拍照只弹出文件选择器、调不起相机。根因：`<input capture="environment">` 在新版 Android WebView 被忽略、退化成普通文件选择。改成装 `@capacitor/camera` 插件，`Camera.getPhoto({source:CameraSource.Camera})` 走原生 `ACTION_IMAGE_CAPTURE` intent 直接拉起系统相机；返回 base64 → Blob → File 喂进既有 `handleFilePick`。Web 端降级为 `getUserMedia` 应用内相机模态。`file_paths.xml` 补 `external-path`。**踩坑**：首版漏了 `import { Capacitor }`，连挂 3 次 APK CI（TS2304），补上后绿。

### 健康同步：睡眠深/浅/REM 分段 + 边界/截断修复

- **睡眠分段**：`health_data` 加 `deep_sleep_hours`/`light_sleep_hours`/`rem_sleep_hours`（迁移 `20260613110000`）。`healthSync.ts` 聚合时按 `sleepState`（`deep`/`light`/`rem`）分桶累计，泛型 `sleeping` 只计总时长。健康快照显示 `昨晚睡了 9h（深睡 2.1h／REM 1.8h／浅睡 4.3h）`。partial-update upsert 只塞非 null 字段。
- **血氧截断**：`oxygenSaturation` 的 `readSamples` limit 提到 500（之前默认 100 只覆盖最近几分钟，全天均值偏窄）。
- **边界泄漏**：聚合分桶按 `endDate` 锚定，加守卫防跨日边界数据漏算。

### README 手机端渲染修复

GitHub Android app 看 README 卡顿、大片白条。根因是 **markdown 表格**——每个表格被塞进独立滚动容器、高度算错留巨大空隙。把全部 13 个表格转成 bullet 列表；两个宽 ASCII 块（架构图、文件树）包进 `<details>` 折叠。

### CI：SessionStart hook 自动设 git 身份

`.claude/hooks/session-start.sh` 每个 session 开头自动跑 `git config user.email noreply@anthropic.com && user.name Claude`，避免提交显示 Unverified。

---

## 2026-06-12

### 搜索:日记/交接信改用 date 而非 created_at
`search_memories_hybrid` 里 diaries / handoff_letters 的时间筛选 + 近度加权改用各自的 `date` 列（条目真实日期，与 timeline 用 event_date 一致），不再用 created_at（入库时间）——导入/补写的日记 date 才有意义。RPC 即时生效。

## 2026-06-11

### 记忆系统 P1：可锁定记忆

借鉴 kiwi-mem 的「lockable memories」(非抄代码,AGPL)。`memories` 加 `locked` 列(迁移 `20260611160000`,已上线);记忆库每条加 🔒 锁定/解锁开关 + 锁定指示。锁定的记忆将来不会被自动冲突消解作废(见 P2)。改 `Memory` 类型 / `MemoryRow` / `mapMemoryRow` / `MEMORY_SELECT_FIELDS` / `updateMemory` + `MemoryVaultPage`。

### 核心记忆改为自动注入(不再靠搜索)

之前 `memories` 只能靠 AI 主动调 `search_memory` 才读到——"想不起来搜"就等于不知道。改成:**核心记忆默认注入系统提示**(常驻档案),日记/交接信/时间轴继续按需搜。
- `supabaseSync.buildMemorySystemSection()`:把所有记忆按 **id 排序**拼成「关于 TA 的核心记忆」块,追加进 system prompt(在 `sendMessage` 里 `await listMemories()`)。固定顺序=逐字节稳定,进 Anthropic 缓存前缀;只在记忆增删改时下条冷写一次。
- `search_memory` 工具描述更新:核心记忆已注入、不必再搜它,本工具主要用于日记/交接信/时间轴/朋友圈 —— 少一次工具调用,反而对缓存更好(工具块会破坏缓存)。
- 纯前端,等下次 APK 生效;部署后首条消息会冷写一次(系统前缀变了),之后稳定。

### 核心记忆自动注入改为「只注入锁定的」

记忆库噪音多(旧的/ChatGPT 导入的/没用的),全注入既费 token 又喂垃圾。改成**只自动注入用户锁定(🔒)的记忆**:
- `listLockedMemories()` 只查 `locked=true`(随库变大也只拉锁定的几条);`buildMemorySystemSection` 也 filter locked。没锁任何记忆时不注入任何东西。
- `search_memory` 工具描述更新:锁定的核心记忆已注入、不用搜;**未锁定的记忆**仍需用工具检索(日记/交接信/时间轴照旧)。
- 用法:在记忆库把重要的记忆 🔒 一下,它们才常驻;其余的当作可搜索的归档。

### 让 Claude 自己管理记忆库(锁定/解锁/修改/通览)

给 Claude 两个新工具,配合"锁定=常驻注入"的架构,让它按需整理记忆:
- `manage_memory`(action: lock / unlock / update + id):锁定重要的(→ 常驻)、解锁噪音/过时的(→ 退出常驻但仍可搜)、修正或合并某条内容(走 updateMemory,改内容会清 embedding 触发重嵌)。
- `list_memories`(只读,limit/offset/only_unlocked):通览记忆库,整理时看有哪些、哪些已锁定。
- **删除暂不开放**(AI 误删风险高;要做会做成可恢复软删除)。`search_memories_hybrid` 本就返回 id,所以 Claude 能精确定位某条。
- 工具加在请求体 tools 数组(部署后首条冷写一次,之后稳定)。纯前端,等 APK。

### 记忆软删除:归档表 + Claude 可 archive

按用户方案做软删除(不真删,移到另一张表,可找回):
- 新表 `memories_archive`(AI 不读/不搜/不注入)+ RPC `archive_memory(id)`(原子:复制到归档表 + 从主表删,**锁定的不归档**)+ `restore_memory(archive_id)`(移回主表、新 id 重嵌)。开放 RLS,用户可在 Supabase 后台直接看/恢复。迁移 `20260611170000`,已上线。
- `manage_memory` 工具加 `action=archive`(走 `archive_memory` RPC);描述说明"软删除、锁定的不归档、用户能找回"。
- 主表自然保持干净,搜索/注入不用加任何过滤。

### 搜索加时间近度加权

借鉴 paramecium 的 RRF + recency 思路(MIT,重写非抄)。`search_memories_hybrid` 最终排序在 RRF 分上加一个**指数衰减的近度小加分**(半衰期 30 天、权重 0.006):相关度差不多时,越近的越靠前;但加分上限 0.006 远小于强相关项的 RRF,所以明显更相关的旧记忆/日记**不会被近度盖过**。只改了 ORDER BY,签名不变,edge function 不用动。RPC 即时生效(不用等 APK)。

---

## 2026-06-10

### 桌宠可点击：戳一下随机播 24 个动画

- **分区点击**:组合组件左半(日期/经期)点 → 开 App;右半(螃蟹)点 → 随机切到 **24 个动画之一**(`setOnClickPendingIntent` 广播 → `onReceive(ACTION_POKE)` → 随机 index 存 prefs → 刷新;下次周期刷新 `onUpdate` 自动回到相位默认)。
- **全部 24 个动画**各 40 帧(从 clawd-tank slack-emojis 抽,和 6 状态版一样顺),共 960 张,**放进独立资源目录 `android/app/src/main/res-crab/drawable-nodpi/`**(build.gradle `sourceSets.main.res.srcDirs += 'src/main/res-crab'` 挂上,仍并进 `R.drawable`),主 `res/` 不再堆几百张帧。
- 帧用编译期 `R.drawable` 数组引用(`minifyEnabled false`,且不走 getIdentifier,资源不会被误删)。
- 默认相位映射不变(夜→sleep、经期中→away、滤泡期→walk、排卵期→happy、黄体期→idle、无记录→rest)。**原生改动,重打 APK 生效。**

### 组合组件升级：6 状态 + 40 帧动画

- **6 个状态各一动画**（回应"多做几个状态"）：经期中→going-away、滤泡期→crab-walking、排卵期→happy、黄体期→idle、夜里→sleeping、无记录→静止 rest。
- **40 帧/状态**（回应"帧多一点、别短短的"）：从原 GIF 线性采样 40 帧（不足的循环补齐），比之前 16 帧顺滑很多。
- **架构改成单 ViewFlipper 复用**：一个 40 槽 flipper，Provider 按状态 `setImageViewResource` 填充当前状态的 40 帧——避免每状态堆一组 flipper 导致几百个 View。帧用编译期 `R.drawable` 数组引用（不走 getIdentifier，资源压缩不会误删）。
- 新增素材 `crab_away_*` / `crab_walk_*`；idle/sleep/happy 重抽到 40 帧。原经期卡 + 独立桌宠保留。**原生改动，重打 APK 生效。**

### 新增：经期+桌宠 2×1 组合小组件（多状态动画）

新增第三个桌面小组件 `ComboWidgetProvider`（2×1）：左边日期 + 🩸经期相位/天数/预测，右边会动的 Clawd 螃蟹。
- **多状态**：夜里→睡觉、排卵期→happy、经期中→静止 base、其余→idle，按时段+相位切 ViewFlipper 可见性。
- **更顺**：动画帧从 8 提到 16（idle/happy/sleeping），rest 用 static-base 单帧；都铺 128×128。新增 `crab_happy_*` / `crab_rest_0`。
- 日期用 `SimpleDateFormat("M月d日 EEE", Locale.CHINA)`。复用 `PeriodCalc`；`PeriodWidgetPlugin` 推数据时一并刷新三个 widget。
- 原有经期卡 + 桌宠保留（可单独添加）。MIT 署名见 `THIRD_PARTY_NOTICES.md`。**原生改动，重打 APK 生效。**

### 桌宠换成 Clawd 螃蟹（真·动画精灵）

把 emoji 桌宠换成 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) 的 Clawd 螃蟹（**MIT**，© Marcio Granzotto；非官方 Anthropic 同人）。
- 从它 `assets/slack-emojis/` 的干净角色 GIF（`clawd-idle-living` / `clawd-sleeping`）各抽 8 帧、统一铺到 128×128 透明 PNG，放 `res/drawable-nodpi/`。
- 布局用两个 ViewFlipper 自动循环（白天 idle、夜里 sleeping），Provider 按时段切可见性 + 按经期相位配台词。**纯帧动画，无需 GIF 解码/动画代码**。
- MIT 合规：`THIRD_PARTY_NOTICES.md` 附完整 MIT 许可 + 署名 + 同人声明。
- **原生改动，重打 APK 生效**；Java/资源仅静态 review（此环境无法编 APK，请装新包后亲测渲染/动画/切换）。

### 新增：emoji 桌宠小组件

第二个桌面小组件，一只会随你状态变心情的 emoji 小宠物（独立于经期数据卡，可单独添加）：
- 用 emoji 当宠物（无需图片素材，任意尺寸清晰）。`ViewFlipper` 双帧自动循环 → 不写动画代码也会"眨眼"。
- 心情联动经期相位 + 时段：经期中🥺 / 滤泡期😊 / 排卵期😻 / 黄体期😌 / 深夜😴 / 无数据🐱，配一行台词。点击开 App。
- 复用经期数据（`PeriodWidgetPlugin` 推的同一份 SharedPreferences）。抽了共享的 `PeriodCalc`（相位/天数计算），经期卡和桌宠都用，逻辑不再两份。
- 原生：`PetWidgetProvider` + `PeriodCalc` + `widget_pet` 布局 + `pet_widget_info` + manifest receiver；plugin 推数据时一并刷新两个 widget。**原生改动，重打 APK 生效。**

### 新增：经期桌面小组件（Android 主屏 AppWidget）

第一个真·桌面小组件（不是 App 内的 widget）。长按桌面 → 添加小组件 → Nimbus → 经期，主屏直接看当前阶段 / 第几天 / 距下次几天，点一下开 App。

- 原生：`PeriodWidgetProvider`（AppWidgetProvider，RemoteViews 渲染 + 从 SharedPreferences 读数据 + 点击开 App）、`PeriodWidgetPlugin`（Capacitor 插件，把数据写进 SharedPreferences 并刷新 widget）、`res/layout/widget_period.xml` + `res/drawable/widget_period_bg.xml` + `res/xml/period_widget_info.xml`、manifest `<receiver>`、MainActivity 注册。
- 数据：`useHomeWidgetData` 算出 periodMetrics 后，把 raw start/end date + 解析后的 cycleLength 推给 widget（`storage/periodWidget.ts`）。**相位/天数在 Java 里按 UTC 纯日期重算**（和 useHomeWidgetData 的时区修复一致），所以跨天不打开 App 也会随 `updatePeriodMillis`（30min）自刷。
- **原生改动，重打 APK 才有**。装新包后：home 页加载会推一次数据；首次没数据时 widget 显示「暂无记录」。

### 移除 FCM + 工具审查

- **移除 FCM 推送**：改用本地通知（`@capacitor/local-notifications`）后 FCM 成死代码（`PushNotifications.register()` 早已注释，listener 永不触发）。清掉 `@capacitor/push-notifications` 插件 + App.tsx 注册/接收 listener + 已弃用的 `proactive_queue` 写入 + gradle 引用。**原生改动，重打 APK 生效**。服务端 `send_proactive_push` 函数 + `fcm_tokens` 表需在 Supabase Dashboard 手删（无 MCP 删除工具）。
- **工具审查**：12 个工具中 `log_health`（in-app tool）之前用 `.insert()`，但 `health_data.date` 无唯一约束、读取走 `.eq(date).maybeSingle()`（>1 行即报错）。当天已有数据时再调一次会造重复行、读取崩。改为按 date upsert（和自动同步 / log_health edge function 一致）。其余写库工具（add_memory/write_diary/...）正常。

### 全局代码审查修复

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
