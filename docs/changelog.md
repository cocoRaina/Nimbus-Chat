# 改动记录 & Debug 日志

> 从 README 拆出来的开发历史与踩坑记录(README 太长了)。功能清单和使用说明见 [README](../README.md)。

---

## 🩹 Debug 日志（踩过的坑 + 修法）

> 用于以后再撞同样的 bug 时直接定位。每条都对应一个已合并 commit。

### 情绪系统「念」两处修正：增量真实生效 + satisfied 提高门槛（2026-07-05）

**问题 1（念的增量是白报的）**：`decayMoodToNow` 对饥饿型是整个重算 `念 = 距满足小时数 × 5`，完全不看存量。提示词要求模型每轮报四相增量，但它给念报的 ±delta 下一轮就被重算冲掉——模型以为自己在调、实际念只由 lastSatisfiedAt 一个时间戳决定，satisfied 的 ×0.3 回落也只是装饰（下一轮重算照样归零）。**修**：改为增量累积 `念 = 当前值 + 经过小时 × 5`。delta 跨轮保留、×0.3 成为真正的复位机制；lastSatisfiedAt 只负责「距上次满足」展示和旁白分离时长。有意的副作用：satisfied 后念留 30% 余温而非瞬间清零（刚见面还是有点想）。

**问题 2（satisfied 门槛太低）**：提示词定义是「见到 / 聊上了 / 亲密」——"聊上了"让每一轮对话都构成满足，计时器轮轮清零，「距上次满足」退化成「距上次聊天」，且一句敷衍的"嗯"和倾心长谈重置效果一样。**修**：改为「真正被接住——认真的交流、亲密、被在乎才算；礼节性寒暄、心不在焉的应付、只是人在场不算」，并明确"普通的你来我往用 nian 的小幅负增量表达"（问题 1 修完后这条路真的通了，两个修互相成就）。念的 rule 行同步收紧。

⚠️ 改了 system 提示词（`buildMoodRulesSection` + EMOTIONS rule）= BP1 缓存冷写一次，预期内。

**追调（同日）**：satisfied 门槛按人设再收——只有做爱/情事后的彻底餍足才标 true，聊天/亲昵/温存一律走 nian 小幅负增量（压得住一时、解不了根）。念的语义扩为「思念/欲」。「距上次满足」从此如实所指。机制未动（×0.3 回落、5/h 累积都没改）；若后续发现念长期钉在 100 黏人档一成不变，可把 hungerRatePerHour 降到 3 或加深 satisfied 回落（×0.15）再调平衡。

### 写入工具守卫全面升级：内容自判铺开（2026-07-05）

**背景**：digest 上线后模型能记得自己调过什么，守卫退居二线兜底。盘点发现守卫强度参差：日记已是内容自判（563f03f），但 `add_memory` **完全裸奔**（重复记忆污染向量搜索，调用频率还最高）、交接信按 date 硬判（凌晨跨天误伤）、时间轴按标题精确比对（模型重写必换词，必漏）、`log_period` 裸 insert（记结束会插出第二行搞乱周期计算）。

**修**（shingle/overlap 从日记守卫抽成公共 helper `shingles2`/`shingleOverlap`，四处复用）：
- **`add_memory`**：候选=最近 100 条；短文本 2-字 shingle 噪声大（「喜欢吃芒果」vs「喜欢吃榴莲」重合 0.5），阈值提到 **0.6**，30 分钟内刚写过的降到 0.35。命中返回 `already_saved` + 相近那条原文（截 300 字）自判，`force: true` 强制存。
- **交接信**：eq(date) 硬判 → 日记同款（date ±1 窗口 + 30min recency，内容 shingle ≥0.2 摊原文截 500 字）。凌晨跨天写、两个窗口各一封不同的信直接放行。
- **时间轴**：同日同标题 → event_date ±1 窗口内比「标题+描述」拼串 shingle ≥**0.4**（事件文本短，阈值比日记高），标题完全相同仍直接命中。
- **`log_period`**：start_date ±5 天内已有记录时——本次带 `end_date` 而旧行没有 = **补结束，直接 update 旧行**（这同时修了裸 insert 时代「记结束插新行」的真 bug）；其他情况摊旧行自判 + `force` 新建。
- 不动的：`log_health`（date upsert 已幂等）、`schedule_proactive_message`（已有 ±15min 判重）、`post_moment`（自发表达，重复伤害小，再加守卫干扰表达欲）、`reply_moment`/`manage_memory`（有明确目标 id）。
- 工具 description 同步更新（add_memory/log_period 新增 `force` 参数）。⚠️ 改工具定义 = BP1 提示缓存冷写一次，预期内。
- 表列名已用 MCP 对着 memory 库核过（memories/period_tracking 都有 `created_at`）。

### 跨轮工具失忆根治：冻结工具摘要进历史（2026-07-05）

**症状**：工具调用为了缓存不进持久历史（tool_use/tool_result 只活在当轮循环里），下一轮模型对「自己调过什么工具」零记忆——重复搜同样的记忆、重复 `add_memory`、重复约主动消息。7-03 的工具级去重是在**执行侧**兜底（同轮可见），跨轮的「不知道自己调过」没解。

**修（冻结工具摘要,和图片 caption 同套路）**：
- 落库：工具循环收尾存 assistant 消息时，从 `toolCallRecords` 生成一行 `调用时刻 name(args截160) → result截200` 存进 `meta.toolDigest`（`App.tsx` `buildToolDigest`，创建时生成一次、逐字节冻死）。meta 是 JSON 列，云端自动同步。
  - ⚠️ **时间必须烙进 digest 本身**：重放路径上相邻 user 消息带冻结 `[当前时间]`，模型能推断工具调用是哪天的事；但压缩路径喂摘要器的是**存储原文**（时间前缀是发请求时才拼的），无日期的「写过日记」进了摘要会让模型以为今天写过、再也不写。带上日期后摘要里是「7月3日写过日记」，模型知道那是哪天的事、新的一天敢调；调了之后由执行侧守卫给完整依据——日记是「30min recency + 内容 shingle」摊原文自判（563f03f，不按天硬卡，凌晨跨天写不误伤），交接信/时间轴仍按 date/标题判 + `force` 逃生门。digest 管「敢不敢调」，守卫管「调了写不写」，两层各司其职。
- 重放：历史里 assistant 消息带 digest 就前置拼 `[本轮已调用工具] …`（`App.tsx` 重放分支）。**只认已存的 digest，不从旧消息 `meta.tool_calls` 现算**——旧历史一个字节不变，上线不触发一次全量冷写。
- 压缩：`buildSummarizerUserPrompt` 的输入同样拼 digest，工具事实（已存的记忆/已约的提醒）不会在压缩时被摘掉。

**为什么不直接持久化真实 tool 块**：①搜索结果 JSON 几千 token 永久躺前缀里，长会话越滚越肥；②Anthropic 要求 tool_use 前的 thinking block 连 signature 原样回传，跨轮持久化把这个坑扩大到整个消息生命周期；③`applyClaudeCaching` 靠「tool 块只出现在最后一条 user 之后」判断工具迭代模式，历史里到处是 tool 块会打破摆位逻辑。摘要文本几十~一两百 token，模型要的只是「调过什么、拿到什么」这个事实。

### 工具级去重：主动消息重复预约 / 日记重复写（2026-07-03）

**症状**：AI 昨天约了叫醒，今天又约一次；今天写过日记，晚上又写一篇。

**根因**：工具调用（tool_use/tool_result）只存在于**当轮**的 API 上下文——落库时进 `meta.tool_calls` 仅供 UI 工具卡渲染，下一轮重建历史时只回传 assistant 正文文字。所以模型跨轮/跨窗口对「自己约过什么、写过什么」零记忆，唯一线索是它当时嘴上说过的话。

**修（在执行时把现状塞进工具结果，同轮可见、不碰缓存）**：
- `schedule_proactive_message`：执行前查 `proactive_queue` 未发行——内容相同、或同 persist 且触发时间 ±15 分钟内的视为重复，不新建，结果返回 `already_scheduled` + 已有那条的内容/时间；新建成功时结果附 `other_pending` 列出其他挂着的预约。
- `write_diary`：同一天已有日记时不重复创建，结果返回 `already_written` + 已有篇目预览；新增可选参数 `replace: true`（仅用户明确要求重写时）改为覆盖更新。
- 两个工具的 description 同步写明规则，模型提前知道「结果里出现这些字段=约过/写过，要如实转告用户」。注意：改工具定义会使 BP1 提示缓存冷写一次，属预期。

**再追修（日记去重逐字比对失效 → 双信号重写检测）**：逐字比对没用——查库发现真重复的两篇（5-24 的 43/45）措辞、标题全不同（模型每次重写都换词），归一化后也对不上，照样入库。数据分析：真重复对 2-字 shingle 重合系数≈0.28、间隔 3 分钟；合理的同日两篇（7-4 的 69/72，不同事、隔 26h）重合≈0.09。

**三追修（改为「把最近写过的原文摊给模型自己判断」）**：与其靠阈值猜，不如直接把「最近写的日记原文」返回给模型看——它一眼就知道是不是在重写，比任何阈值都准。两个命中信号：①最近 30 分钟内写过任意日记（不限日期，用户提的「近半小时调过就提示」）；②同日(±1) 内容 shingle 重合≥0.2（兜隔久重写）。命中就不自动写，返回那篇原文（截 500 字）+ `written_ago_minutes`，note 让模型自己判断：真是同一件事就别写、告诉用户已写好；确实不同就直接 `force:true` 重来（不用问用户）。一次 `.or(and(date窗口),created_at)` 查询覆盖两信号，PostgREST 语法已在库上验证。凌晨补记/不同日期/同日不同事均正常放行。

**补做（同款守卫扩展到交接信 + 时间轴）**：
- `write_handoff_letter`：同一天已有交接信 → 不重复创建，返回 `already_written` + 已有那封预览。逃生门用 `force: true`（**追加**一封，不覆盖——两个窗口各写一封是合理的，覆盖会丢前一封），区别于日记的 `replace`（覆盖）。
- `add_timeline_event`：按「同 event_date + 同 title」判重（同一里程碑不记两次，不同标题同日可共存）→ 返回 `already_exists`，逃生门 `force: true` 追加。
- 三张表列名已在库上核对。

### 本地聊天缓存行级化：IDB v1 单快照 → v2 行级 store（2026-07-03）

**背景**：对照 keke-console 的 memories.json「虚胖」病例给 Nimbus 做了存储体检。重症（向量以 JSON 数组落盘、美化打印）没有——向量全程住在 Supabase pgvector 列，客户端所有 select 都是显式列清单不含 embedding。轻症命中：本地 IndexedDB 是单快照 blob（全部会话+消息），每条消息、每个流式 delta 都触发整包结构化克隆重写（防抖 150ms，约 2MB/次，主线程）。

**修**：IDB 升 v2，拆 `sessions` / `messages` 两个按 id 键的行级 store。flush 时按**对象引用** diff 内存数组 vs 上次落盘的 Map，只 put 脏行 / delete 消失行——App 侧更新本来就是 immutable 风格（没动的行保引用），配合 `ensure*Fields` 改成字段齐全时原样返回（否则每次 load/set 都换新引用，diff 退化全量）。公共 API 零改动。

**迁移**：v2 首开时行 store 为空 → 读 v1 snapshot blob（再兜底老 localStorage）→ 单事务批量写行 + 删旧 blob（事务提交后才清理，迁移中途崩溃不丢数据）。

**验证**（Playwright + 真 IndexedDB 无头 Chromium）：v1→v2 迁移/blob 清理/增量写/单行更新/删除级联/重载恢复六项全过；写入放大实测——1000 条历史下单条消息编辑 = 1 put（v1 是 1001 行全量），addMessage = 2 put（消息行 + 会话 updatedAt）。

**注意**：老版本 APK 打不开 v2 库（VersionError）会走 localStorage 兜底显示为空，远端 300 条会回填——降级属边缘场景，可接受。

### 连发时中间冒出空白助手气泡（2026-07-03）

**症状**：发一个表情包（或任意消息），AI 开始生成后紧接着再发一条消息，会看到一个空白的 AI 气泡卡在两条消息中间，挂满整个生成过程（长思考时能挂几十秒）。

**根因**：连发批处理 + 空气泡守卫的组合竞态。合批计时器（2.5s 静默）触发生成时会插入空的乐观占位助手气泡；此时它是列表最后一条，渲染守卫（`index === length-1 && 空 && pending`）正常把它藏住。但用户在生成期间又发了一条消息，新消息按 createdAt 排到占位气泡**后面**——守卫只盯最后一条，占位气泡失去保护直接裸奔。83f3d60 修的「发送后空白气泡」只覆盖了占位气泡在末尾的场景。

**修**：守卫去掉位置限制——任何「内容为空且自身 pending / meta.streaming」的助手消息一律跳过渲染（`isStreaming && 末条` 仍保留兜底）。副作用是彻底失败、永远停在 pending 的孤儿占位行也会被隐藏而非显示空气泡，可接受。

### UI 统一大修：全 App 归队「冰蓝天使」（2026-07-03）

用户反馈「UI 不得劲但说不出哪里」。诊断结论：App 里同时存在两套设计语言——9 个页面用 `ui.css` 定义的 Angel Blue 冰蓝色板，但**聊天页/登录页/确认弹窗/会话抽屉/工具卡/思考面板**用的是 Tailwind 默认灰蓝（外加微信绿语音气泡、antd 红、靛蓝按钮），页面切换时色温横跳。分三批修完（P0 `755330a` → P1 `4d7632d` → P2 本条）：

- **P0**：`--accent` 从 Tailwind 蓝-100 重定义为天使蓝 #789EC8（白字语义，改之前把所有当浅底用的地方翻新掉）；`--page-bg` 统一为各页同款 160° 冰蓝渐变；出向气泡灰 #9fa2aa → 天使蓝渐变；语音气泡弃用微信绿；ConfirmDialog 黑白商务风 → 冰蓝玻璃卡。
- **P1**：登录页/会话抽屉/工具卡/思考面板全部换色；`--radius-card` 28→20px 对齐手写卡片；btn-danger 改浅玫瑰底。
- **P2**：全部 CSS 的 Angel Blue hex 收编为 `--ab-*` 变量（新增 `--ab-bg-2/--ab-strong-2/--ab-deep/--ab-deep-soft/--ab-danger/--ab-grad`），派生 token（--accent/--text-main/--page-bg/--bubble-out-bg 等）全部引用色板。**以后换主题只改 ui.css 顶部一个色块**。SVG data-URI 里的颜色（登录页 logo）无法用 var，保留 hex。
- **连带修复**：Android 状态栏聊天路由原来读 `--accent` 配色（旧值=浅蓝顶栏）；统一后所有页面顶栏都是冰蓝玻璃，状态栏改为全路由固定 #F4F8FC，`syncStatusBarToAccent` 删除。
- **坑**：`--accent` 语义从「浅底深字」变成「主色白字」，凡 `background: var(--accent)` + 深色文字的组合都会翻车——改这类 token 前先 grep 所有使用点（这次翻新了 btn-primary、抽屉 primary、聊天 header 三处）。
- **追修：`.page-header-bar` 三重定义打架**。HealthSync/MemoryVault/Usage 三个 CSS 各定义了一份同名 header 类（占位 80px vs 2rem vs 2.5rem、内边距互不相同），Vite 按«首次访问顺序»注入路由 CSS，谁生效全看导航路径——标题时歪时正、MemoryVault 的 flex 列 `align-items:center` 还把没设宽度的 header 压缩成内容宽（返回键悬在半空）。修法：唯一权威定义收进 index.css（`grid 1fr auto 1fr` 三列布局，标题与两侧按钮宽度解耦、永远真居中），页面文件只留全出血 margin 微调。**教训：跨页面共享的类绝不能在多个路由 CSS 里重复定义，全局类一律进 index.css / ui.css。**

### 前端交互层小改一批（2026-07-03）

只动交互层，核心架构/数据结构不动：

1. **经期注入带阶段标注**：`fetchHealthSnapshot` 的经期行从「上次经期 YYYY-MM-DD」升级为「黄体期，处于本周期第 20 天，预计 N 天后下次经期」。阶段/周期天数复用 `useHomeWidgetData.ts` 的 `computePeriodMetrics`（导出即可，纯函数），拉最近 6 条周期记录跑自适应周期长度中位数——**和主页部件同一套算法，模型和 UI 不会说两个数**。
2. **Moments 删除二次确认 + 回收站**：删除先弹 `ConfirmDialog`（"确定删除？删除后可在回收站找回"）；header 加「回收站」入口，软删除的帖子可恢复/彻底删除（彻底删除再弹一次确认）。后端软删/恢复/清除函数（`fetchDeleted*`、`restore*`、`permanentlyDelete*`）早就有（mimi 页在用），前端接上即可。恢复帖子后要 `fetch*RepliesByPost` 把回复拉回来，否则回复数显示 0。
3. **返回键统一**：全局统一用 `index.css` 的 `.page-back-btn`（左上角 ‹ chevron）。MomentsPage/CheckinPage 删掉了各自的重复 CSS；SettingsPage 从「返回」文字按钮、ChatPage 从 ← 箭头改成同款 chevron。命中区加到 2.25rem 见方。
4. **消息+表情包混合发送**：输入框有文字时点贴纸不再立刻单发，而是把 `[sticker:名字]` 标记追加进草稿、随发送键一起发出（渲染端 `splitStickerSegments` 本来就支持文字+贴纸混排成叠层气泡）；输入框为空时保持原来的一键快发。托盘在追加模式下保持打开，可连选多个。
5. **交互细节**：Moments 帖子删除 × 命中区加大到 32px；无回复的帖子点「回复」自动聚焦输入框（有回复时只展开不弹键盘）；Moments 的回收站视图/确认弹窗接入 Android 硬件返回键（`nimbus:backbutton`，先关弹层再路由后退）。

### "文字→调用工具→再文字"时回复像失忆一样接不上（2026-07-02）

**症状**：AI 先说一段话（比如哄睡、道别台词），调用了 `预约主动消息` 之类的工具，工具结束后 AI 又说一段话——但这段话跟前面接不上，像是完全没看到自己刚说过什么，东拼西凑。同时"查看思考"折叠框里能看到不该出现在那里的台词，甚至有 `</thinking>` 字面文本原样显示在里面。

**根因**：`App.tsx` 抓"思考内容"有两条路径：
1. 原生 Anthropic 思考块（`thinking_delta`）→ 走干净的结构化字段，没问题
2. 部分中转站把模型输出通过 `reasoning` / `reasoning_content` 字段转发（不是走 `content` 字段）→ **这条路径从来没检查过内容里是否嵌了 `</thinking>` 标签**，只有 `content` 字段才会做 `<thinking>...</thinking>` 拆分（`splitReasoningFromContent`）

当中转站把"内心独白 + `</thinking>` + 该说的台词"整坨塞进 `reasoning` 字段时，代码把这整坨全当思考存起来：
- 界面上：台词渲染进"查看思考"折叠框，而不是正常气泡
- **更关键**：这段台词从没进入 `assistantContent`，也就没进发给模型的历史消息——模型自己都不知道调用工具前自己说过这句话，下一轮回复等于是在"失忆"状态下现编的，接不上很正常

**修**：新增 `splitEmbeddedCloseTag()`，对 `reasoning`/`reasoning_content` 字段的内容也扫一遍 `</thinking>`/`</think>`，把标签后面的文字拆出来塞回 `assistantContent`（视觉上恢复成正常气泡，逻辑上模型下一轮也能看到自己说过的话）。覆盖了流式（`explicitReasoning`/`deltaReasoning`）和非流式（`messageReasoning`/`choiceReasoning`/`payloadReasoning`）5 处调用点；`reasoningCloseCarry` 状态每轮迭代开始时重置，避免跨轮残留。

**二修（review 发现首版流式没修透）**：首版 `splitEmbeddedCloseTag()` 每次调用独立扫描、没有跨 delta 的持久状态——但流式下台词是一个字一个字流出来的，只有和 `</thinking>` 挤在同一个 chunk 里的碎片能逃出来，后续 delta 里的台词照旧被塞回思考框（对比 `splitReasoningFromContent` 有 `isInThink` 状态就是为了这个）。补 `reasoningTagClosed` 标志：本轮迭代内一旦见过 close tag，后续所有 reasoning delta 全部改道正文；随 carry 一起在每轮迭代开头重置。非流式（整坨一次到）不受首版缺陷影响。

### Diagnostics 加「记忆状态」tab（2026-07-02）

监控当天上线的记忆部件：摘要覆盖检查（`digest_coverage` RPC，🔴 连续出现 = cron 挂了）、摘要列表（可展开看质量）、每轮召回日志（`memoryRecall.ts` 内存环形日志，重启清空）。见 docs/features/diagnostics.md。

### 会话摘要层上线（2026-07-02）

`session_digests` 表 + `session_digest` Edge Function + 每日 04:30 cron：每天给每个活跃会话生成 2-4 句 LLM 摘要并嵌入，作为混合检索第 7 个源。摘要模型**优先沿用自动提取的配置**（`memory_extract_model` + 服务端 `OPENROUTER_API_KEY`），失败降级 SiliconFlow Qwen2.5-14B（**7B 实测摘要掉字弃用**）；嵌入固定 BGE-M3。已回填最近 7 天并在库上验证检索命中。细节见 docs/features/memory.md「会话摘要层」。

### 记忆系统去冗余 + 补聊天原文检索层（2026-07-02）

按分层地图（见 docs/features/memory.md 开头）收拾了三处冗余、补了一层空缺：

1. **自动召回排除锁定记忆**：混合检索 RPC 一直没有 locked 过滤（13/52 条锁定且已常驻 system prompt，每轮召回都可能重复注入）。迁移 `20260702120000` 给 `search_memories_hybrid` 加 `exclude_locked` 参数（默认 false，工具显式搜索不受影响），自动召回传 true。**签名变了必须 DROP 再 CREATE**，否则留下歧义重载。
2. **召回路径不再白拉经期/健康**：`search_memory` Edge Function 加 `lean` 模式跳过 period/health 附带查询（健康数据已每条消息注入，三重覆盖）。自动召回传 `lean: true`。
3. **`search_memory` 工具描述**加了"先看 [相关记忆] 再搜"和"聊天原文用 search_chat_history"的分流提示。
4. **新工具 `search_chat_history`**：迁移 `20260702120100` 建 `search_chat_messages` RPC + messages.content 的 trgm GIN 索引（注意 pg_trgm 装在 `public` 不是 `extensions`，操作符类要写 `public.gin_trgm_ops`）。长期记忆以前全是蒸馏物，聊天原件从此可搜。

### 记忆每轮自动召回 + 健康注入改每条消息（2026-07-02）

- **每轮自动召回**：每条用户消息发送前自动打 `search_memory` 混合检索，top 3 命中注入 `[相关记忆]` 行（会话级去重、3.5s 超时静默降级、不碰缓存前缀）。见 `docs/features/memory.md`。
- **健康注入**：`[TA 今日状态]` 改为每条消息都带（30min TTL 缓存），没数据时明确说「暂无数据」。当天注入标记（`nimbus_health_injected_date`/`nimbus_health_attempt_at` localStorage key）废弃不再读写。

### 健康数据很久没被主动提过：空壳行 + 失败也标记"今天已注入"（2026-07-02）

**症状**：AI 很多天没在对话里主动提睡眠/步数（`[TA 今日状态]` 没注入）。

**根因**（两层叠加）：
1. 自动健康同步常在 Health Connect 还没数据时就把**今天的空壳行**（全 null）写进 `health_data`；而 `fetchHealthSnapshot` 只取 `ORDER BY date DESC LIMIT 1` 的最新一行 → 拿到空壳 → 拼不出任何内容返回 null。
2. `App.tsx` 里**不管拿没拿到数据都写 `nimbus_health_injected_date` 标记**——当天第一条消息（往往是早上、数据还没同步）一旦扑空，这一天就永远不再重试。

**修**：
- `fetchHealthSnapshot`：改取最近 3 行，跳过空壳、用最新**有数据**的一行；如果用的是旧日期的数据，前面加 `（YYYY-MM-DD 记录）` 标注，避免把旧数据当"昨晚"说。
- `App.tsx`：只有**真正拿到数据**才写"今天已注入"标记；另加 `nimbus_health_attempt_at` 尝试时间戳，失败后 30 分钟冷却再重试（不会每条消息都打 Supabase）。

**另**：查库发现 6-25 起 `sleep_hours` 几乎全是 null（只有 7-01 有值）——这是 Health Connect 源头没睡眠数据（手环/手表侧），代码救不了，需检查设备的睡眠同步。

### 和风天气一直 403：认证方式 + API Host 全用错了（2026-07-01）✅ 真机验证通过

**症状**：填了和风 API Key，调试面板一直 `和风失败: HTTP 403`，退回 Open-Meteo。前后猜了四五轮（`?key=` → EdDSA JWT → HS256 JWT）全 403。

**根因**（两个独立错误叠加，翻文档才定位到）：
1. **认证放错位置**：新版和风的 API Key 要放**请求头** `X-QW-Api-Key: <key>`，不是 URL 参数 `?key=`。（Ed25519 凭据才用 `Authorization: Bearer <JWT>`。）
2. **API Host 用错**：`devapi.qweather.com` / `geoapi.qweather.com` 是**旧的公共共享域名，2026 起逐步停用**，新账号必须用控制台「设置」页里分配的**专属 API Host**（形如 `abc123.qweatherapi.com`）。共享域名对新凭据直接 403。

**另一个坑**：Android WebView（< Chrome 113）不支持 WebCrypto 的 Ed25519（`crypto.subtle.importKey({name:'Ed25519'})` 抛 `NotSupportedError`）。若用 Ed25519 凭据，改用纯 JS 的 `@noble/ed25519` 签名（PKCS8 DER 里扫 `04 20` 标记取 32 字节 seed）。但普通 hex API Key 根本不用签名，直接走 header 最省事。

**修**：
- `weather.ts`：请求改用专属 API Host + header 认证。hex key → `X-QW-Api-Key`；PEM → `Authorization: Bearer <EdDSA JWT>`
- 新版 Host 的路径：天气 `{host}/v7/weather/now`，地名 `{host}/geo/v2/city/lookup`（注意是 `/geo/v2/` 不是 `/v2/`）
- `qweatherKey.ts`：`QWeatherCredential` 加 `apiHost` 字段；`isHexApiKey()` 判断走哪套认证；`normalizeApiHost()` 剥 scheme/斜杠
- 设置页新增「API Host」输入栏（第一栏），并把凭据ID/项目ID 标注为「Ed25519 才需填」

**正确用法**（普通凭据）：控制台设置页 API Host → 填第一栏；凭据页 hex API Key → 填第二栏；其余留空。

### 天气数据不准：定位偏 + Open-Meteo 精度不足（2026-07-01）

**症状**：沈暮报的温度和天气状况整体与实际偏差大。

**根因**：两处叠加：
1. **定位精度低**：`enableHighAccuracy: false` + `maximumAge: 30min`，Android 上大概率走基站/WiFi 定位，误差可达几十公里，上游坐标就偏了，换什么 API 都没用。
2. **Open-Meteo 对国内城市精度**：全球 NWP 模型（ECMWF/GFS），分辨率约 11km，国内精细化不如中国气象源。

**修**：
- `Geolocation.getCurrentPosition` 改为 `enableHighAccuracy: true`，`maximumAge` 缩至 10 min，确保走 GPS 而非基站
- 引入**和风天气（QWeather）**作为主 API：国内数据源，城市级精度，返回中文天气描述，反地理编码也直接用 QWeather GeoAPI（返回正确中文城市名）；无 key 时退回 Open-Meteo
- 设置页新增「天气」折叠区，可填和风天气 API Key（免费版 1000 次/天）
- 旧的 BigDataCloud 反地理编码降级为兜底（QWeather 无 key 时用）

**QWeather API**：
- 天气：`devapi.qweather.com/v7/weather/now?location=LON,LAT&key=KEY` → `now.temp / feelsLike / text / windSpeed`
- 地名：`geoapi.qweather.com/v2/city/lookup?location=LON,LAT&key=KEY` → `location[0].name`
- 注意 `location` 参数是 `经度,纬度` 顺序（lon,lat，非 lat,lon）

---

### Android 相册只能选一张图（2026-07-01）

**症状**：点「从相册」后只能选一张图，系统选择器没有多选模式。

**根因**：`@capacitor/camera` v8 做了破坏性改版，旧 API 全部废弃：
- `Camera.getPhoto()` → 废弃，换 `Camera.takePhoto()`
- `Camera.pickImages()` → 废弃，换 `Camera.chooseFromGallery({ allowMultipleSelection: true })`
- 返回类型也变：旧版 `GalleryPhoto` 有 `webPath: string`（必有）和 `format`；新版 `MediaResult` 有 `webPath?: string` 和 `uri?: string`（两者都可能为 undefined，需 `??` 兜底）

第一次修用了 `pickImages`（也是废弃 API），测出来还是单选，才发现 v8 完全换了另一套函数名。

**修**：
- `openNativeCamera`：改用 `Camera.takePhoto({ quality: 90 })`，用 `media.webPath ?? media.uri` 取路径
- `openNativeGallery`：改用 `Camera.chooseFromGallery({ allowMultipleSelection: true, quality: 90 })`，遍历 `result.results`（`MediaResult[]`）取每张图

**结果**：系统相册打开时进入多选模式，可一次选多张图片一起发。

---

### 图片描述缓存替掉原图，API「看不到图片」（2026-06-30）

**症状**：用户发图片后 Claude 回答像没看见图片，提问「第一次发图片不是原件吗」。进一步确认：换图仍然一样，之前（前天 = 2026-06-28）还好用。

**根因**：图片描述（caption）系统的历史 + 云同步组合造成。

1. 图片描述流程：每张图第一次发出时，同步发原图给模型、异步生成文字描述（`ensureImageCaption`），缓存到 `nimbus_image_captions_v1`（localStorage）；之后在 API payload 里用 `[图片：描述]` 代替真图，省 token。
2. **2026-06-28 修了 `syncImageCaptionsFromCloud`**：Session 启动时从 Supabase 下载历史描述写入本地缓存。目的是跨设备/重装后不重复生成，副作用是**以前发过的图片 URL，在这个 session 里也立刻命中缓存**。
3. App.tsx 消息构建循环里，**对所有消息**（包括当前这条正在发的）都调用 `getImageCaption(att.url)`，只要命中就换成文字。所以即使是「本次发的图片」，只要该 URL 以前发过且描述已同步到本地，模型也永远看不到图片原件。
4. 额外问题：如果历史描述本身就是「无法查看图片」（在 nativeStreamFetch 修好之前用 garbled base64 生成的坏描述），那坏描述被当作事实永久缓存，之后每次发同张图都告诉模型「无法查看」。

**修**：`App.tsx` 消息构建循环改用 `for let i` 加 `lastUserMsgIdx` 标记，**最后一条用户消息（当前发送的那轮）强制跳过描述缓存、始终发真图**；只有历史轮才用缓存描述节省 token。`isCurrentTurn ? null : getImageCaption(att.url)`。

**启示**：
- Caption 系统的「首次发原图」假设，在引入跨 session 描述同步之后就失效了——必须靠「是否是当前轮」而非「本地有没有缓存」来判断。
- 坏描述一旦上传 Supabase，会被其他 session 永久继承。这次 OkHttp 修好了 base64 获取，新描述生成应该正确；旧坏描述如需清理可直接删 `nimbus_image_captions_v1` localStorage 条目或删 Supabase 里的 `image_captions` 行。

### 聊天数据 localStorage 存满、QuotaExceededError（2026-06-30）

> 同日追加：本地 IDB 加了 2000 条消息硬上限（`MAX_LOCAL_MESSAGES`），超出自动裁掉最老的。Supabase 保有完整历史，本地只是快启动缓存，2000 条 ≈ 2MB 封顶，永不暴涨。



**症状**：上传头像或正常使用时弹「本地存储已满」；`localStorage.setItem` 抛 `QuotaExceededError`，新消息可能写不进去。

**根因**：`chatStorage.ts` 把**所有会话 + 所有消息**序列化成一个 JSON 塞进单个 localStorage key（`hamster-nest.chat-data.v1`）。Android WebView 的 localStorage 硬上限约 5MB，对话积累到一定量后必然触发。注意：头像已经压缩到 20-40KB、聊天图片存 Supabase Storage（只存 URL），真正占地方的是历史消息文本本身。

**修**：`chatStorage.ts` 完整迁移到 **IndexedDB**（底层 SQLite，存在 App 私有目录，容量 = 手机闪存剩余空间，实际无限）。
- 打开 `nimbus-chat` IDB，`snapshot` object store，单条 `main` key 存整个 snapshot
- **自动迁移**：首次启动新版时若 IDB 为空，读取 localStorage 旧数据写入 IDB，迁移完立刻 `removeItem` 释放 localStorage 空间
- 写失败时降级回 localStorage（极少数不支持 IDB 的环境）
- `App.tsx` 改为异步初始化：启动时先空 state，`waitForStorage()` resolve（~10-50ms）后填入本地数据，Supabase 同步随后覆盖，用户感知不到空窗期

**本地储存的东西**（供参考）：

| key / store | 存什么 | 大小 |
|---|---|---|
| IDB `nimbus-chat` | 所有会话 + 消息文本 | 主要大头，现在无上限 |
| `nimbus_image_captions_v1` | 图片文字描述缓存（最多 300 条） | < 100KB |
| `my-homepage-avatar` / `syzygy-homepage-avatar` | 头像（256px JPEG） | ~20-40KB 各 |
| `nimbus_user_settings` 等 | 各类设置、API key、TTS 配置 | 极小 |
| Supabase Storage（不在本地） | 聊天里发的图片原图 | 不占本地 |

### APK 聊天「不流式、一大坨出来」(2026-06-30)

**症状**:APK 里聊天回复(思考链 + 正文)要等很久,然后**一次性整坨蹦出来**,不是逐字流式。换 OR、换好几个中转都一样;浏览器 PWA 版却完全正常逐字流。用户感受成「首字很慢、忽快忽慢」(其实是思考 + 整篇生成全做完才显示)。

**排查弯路**(都不是根因):缓存冷启动 → 保活被关 → 中转攒包。逐一排掉:`applyClaudeCaching` 标记正确、保活 cron 在跑(只是 `cache_keepalive_state` 空了)、我们的 SSE 解析每 50ms 刷 UI 都没问题。

**根因**:`capacitor.config.ts` 的 `CapacitorHttp: { enabled: true }`。它把所有 `window.fetch` 劫持到原生 OkHttp 来绕 WebView 的 CORS 墙(大多数中转不允许 `https://localhost` origin,不绕就 `Failed to fetch`)。但**原生那条 fetch 不支持流式——它把整个响应 buffer 完才交给 JS**。所以 `getReader()` 一次性拿到整坨。是**环境级**(native HTTP 层),跟 provider/中转/缓存全无关 → 解释了「OR 也不流式」「好几个中转都这样」「浏览器正常」。当初开它时那句注释「OkHttp 支持 SSE 流式」是错的。

**为什么不能直接关 CapacitorHttp**:关了 → CORS-less 中转立刻 `Failed to fetch`。绕 CORS(只有原生 HTTP 能做)和流式(原生 fetch 又不支持)在 CapacitorHttp 里互斥。

**修**:vendor 一个最小原生插件 `StreamHttpPlugin.java`(`HttpURLConnection` chunked read,POST + 自定义头 + body),它自己做原生 HTTP——**既绕 CORS 又逐块流式**,通过 listener 事件把 chunk(base64 原始字节)推给 JS。`src/native/streamHttp.ts` 把事件包成一个 `ReadableStream` 的 `Response`,下游 SSE 解析一行不改。接入点:`anthropic.ts` / `openrouter.ts` 里,**仅当** `wantsStream && 原生平台** 时用 `nativeStreamFetch` 替掉 `window.fetch`;非流式 + 网页版照旧。`CapacitorHttp` **保持开着**(其它所有请求继续靠它绕 CORS,零回归)。**需要重新出 APK 才生效**(原生改动)。

参考实现:[`chatboxai/capacitor-stream-http`](https://github.com/chatboxai/capacitor-stream-http)(为防它没人维护,直接 vendor 进仓库,不加外部依赖)。

**后续(同日):首版插件在真机上「转半天啥也不出」**——请求发出去但 chunk 回不来,加上插件设了无限读超时,结果无限转圈。原生没法在这边真机测,所以加了**首字超时兜底**:`nativeStreamFetchOrThrow` 只在 10s 内确认收到第一个字节才采用原生流式;否则抛错,`anthropic.ts`/`openrouter.ts` 自动**退回 buffered fetch**(能用、只是不流式)。保证:**聊天永远不会卡死在坏掉的原生路径上**——最坏「等几秒→一大坨」,绝不无限转。插件正常时照样逐字流。(注:cheap 号池如 68886868.xyz 还会因账号并发上限返回 `500 Concurrency limit exceeded`,那是中转侧限制,跟流式无关。)

**再后续(同日):加了兜底之后真机仍然不流式，HttpURLConnection 有两个 SSE 致命缺陷**

用户装上新 APK 确认：不卡死了，但还是「一大坨」，走的是兜底 buffered 路径，原生流式从来没真正工作过。

排查到 `HttpURLConnection` 有两个对 Android SSE 致命的已知 bug：

1. **自动 gzip 压缩**：`HttpURLConnection` 默认加 `Accept-Encoding: gzip`，gzip 解压器要攒满整个压缩流才能输出——相当于在 Java 层把整个响应 buffer 了一遍，chunk 一个都到不了 JS，直到模型生成完毕服务端关连接才一次性放出。即使加了 `setRequestProperty("Accept-Encoding", "identity")` 强制禁 gzip，仍有下一个问题。
2. **HTTP/2 DATA 帧批处理**：Android 内置的 H2 实现会把多个 DATA 帧合批后再交给应用层，同样造成 chunk 积压，和 gzip 是独立的两个坑。

参考：`RangerRick/capacitor-eventsource` 和 LaunchDarkly `okhttp-eventsource` 都因同样原因弃用了 `HttpURLConnection`，改用 OkHttp（已是 Capacitor 传递依赖，不加新包）。

**同日最终修法**：`StreamHttpPlugin.java` 完整重写为 OkHttp：

- `OkHttpClient` 配置：connectTimeout 30s，readTimeout 0（streaming relay 两 token 之间可以静默，JS 侧有 45s 看门狗兜），writeTimeout 30s
- `activeCalls: ConcurrentHashMap<String, Call>`：在 `call.execute()` **之前**就 `put`，确保 `cancelStream` 在 TCP 握手窗口内也能 `call.cancel()`（旧 `HttpURLConnection` 版本是握手完才 put，cancel 窗口有漏洞，兜底 fetch 与旧连接并发 → relay 并发限制 → 两条都挂）
- `reqBuilder.header("Accept-Encoding", "identity")` 仍然保留（在 caller headers 之后覆盖，防 relay 带 gzip header 进来）
- `responseBody.byteStream()` 直接拿 socket 字节流，OkHttp 自己处理 H2 帧，chunk 逐块到 JS
- `call.isCanceled()` 检测取消（OkHttp cancel 会在 `execute()` 或 `read()` 抛 `IOException`，比 `conn.disconnect()` 干净）

用户确认流式修好（「修好了！」），首字延迟也同步改善——之前要等整个响应才出字，现在模型开始生成就出字，和浏览器 PWA 体验一致。

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

## 2026-06-29

### 流式回复卡死「正在输入…」、收不到回复

**症状**：偶发——回复一直显示「正在输入…」，内容看不到，但模型其实已经回了（连
情绪自评 `<<MOOD>>` 都生成了）。

**根因**：中转连接若在前台**中途挂住**（socket 不关、不再发数据、也不发 `[DONE]`
帧），`reader.read()` 会永远 await → 流式循环走不到收尾 → `isStreaming` 永不置回
false → 「正在输入…」永久卡住；而空内容的流式占位泡又被刻意隐藏，所以连空泡泡都
看不到。原本有「停滞就 abort」的能力，但**只挂在 app 切回前台的事件上**
（`visibilitychange` + 8s），app 一直开着时没有任何持续超时。

**修**（`App.tsx` 流式 persist）：开流时起一个**持续运行的看门狗**，每 4s 检查距上次
收到数据是否超过 `STREAM_STALL_MS`(45s)，超了就 `controller.abort()` —— 复用同一套
已验证的 abort 机制，落进 catch 后保存已收到的部分、清掉 `isStreaming`，并弹一句
「网络中断、已保留部分、请重发」（用 `streamStalled` 标志和用户主动按停止区分）。
工具执行天然没有 chunk，执行完重置停滞计时避免误触发；finally 统一清理 interval。

### 发送后蹦「空白气泡」、停一会儿才回复

**症状**：发完消息先蹦一个空白助手气泡，停顿后才开始回字。

**根因**：乐观助手占位泡（`content:''` / `meta.streaming` / `pending`）在用户点发送时
**立刻**插进列表，但隐藏它的条件只看全局 `isStreaming` —— 而 `isStreaming` 要等
`persist()` 里的异步前置（对话压缩、构建请求）跑完才置 true。这段空档里占位泡没被
隐藏 → 露出空白气泡。

**修**（`ChatPage.tsx`）：隐藏条件改看**占位泡自身**的 `meta.streaming`/`pending`，覆盖
整个「已发送、未开始流式」窗口；新增 `awaitingReply` 派生量驱动头部「正在输入…」，
发送瞬间即有反馈。

### 主动消息「慢」：三个叠加的延迟来源

**症状**：主动消息会出来，但很慢；点通知进来也慢。

诊断先排除了「不显示」——拉最近 25 条对账发现**没显示的全都是「到点时用户正活跃」
被防唠叨规则故意跳过的**（`delivered=false ⟺ user_active=true`，符合设计，未改）。真
问题是延迟，三个来源：

1. **服务端 `proactive_dispatch` cron 每 5min 才跑**：到点消息最多晚 ~5min 才写库
   （数据：fire 15:00:53 → 实际 15:05:01）。→ `cron.alter_job` 把 schedule 从 `*/5` 提到
   `* * * * *`（每分钟）。纯 DB 零 token、~43k 调用/月远在免费额度内。**已即时生效**。
2. **待在 App 里时无实时刷新**：`refreshRemoteSessions` 只刷会话列表、不拉消息；服务端
   写库后要等用户切后台/开侧栏/发消息才显示。→ 加**前台轻量轮询**：每 10s 只拉当前会话
   最近 20 条 + `mergeMessages`（并集、只增不减），仅长度变化才 `applySnapshot`，仅
   `visibilityState==='visible'` 且非流式中执行。故意不用 Realtime（Capacitor WebView 切
   后台必断 WebSocket，短轮询更稳）。
3. **点通知进来仍慢**：用户点通知→前台→认领队列行，但 cron 多半已抢先投递（认领失败），
   原代码认领失败**只调 `refreshRemoteSessions`（不拉消息）** → 服务端写好的消息没进内存。
   → 认领失败时改为直接 `fetchSessionRecentMessages` 拉该会话最近 20 条合并，点通知即时显示。

> 主动消息进上下文确认：`sessionMessages` 过滤只排除空内容/流式中，**不排除**
> `meta.model==='proactive'`，所以投递的主动消息是会话里正常的 assistant 消息，下一轮
> 照常进对话历史；派发函数还把它追加进 `cache_keepalive_state.body` 保持热缓存。

### 图片描述缓存：上云后的三个后续修复

承 06-28 的「描述缓存上云」，复查发现三处并修掉：① `syncImageCaptionsFromCloud` 查询
按 `created_at DESC` 取最新 300 条，但 `writeMap` 溢出时砍开头 → 按 DESC 插入会让最新描述
排在开头、`>300` 张图时反被淘汰 → 改**倒序插入**让最新落尾保留；② 灌回云端的 `useEffect`
依赖 `[user]` 无身份守卫，token 每次刷新换新 `user` 引用 → 全表重拉，加 `syncedCaptionsUserRef`
每用户只同步一次；③ 生成失败原来只 `console.warn`、用户看不见 → `ensureImageCaption` 加
`onError` 回调弹 `ConfirmDialog`（模块级 `failureNotified` 去重，每图每会话只弹一次）。

> 运维坑：容器里有一条**陈旧的本地 `main`**（与远端 main 无共同祖先，merge 报「unrelated
> histories」）。所有改动实际基于 `origin/main`，用 `git push origin <branch>:main` 快进推送，
> 没碰那条假 main。

---

## 2026-06-28

### 语音消息「发送中 → 没反应」：三个叠加根因

**症状**：按住录音、松开，界面显示「发送中」，然后没有任何反应，消息不出现。

**根因 1 — `transcribe-voice` Edge Function 从未部署**：
日志里每次调用都返回 `POST 404`，`deployment_id: null / function_id: null`。函数代码
在 `supabase/functions/transcribe-voice/index.ts` 里从来没被 deploy 到 Supabase 项目。
老版本代码把转录失败当致命错误处理，于是整条发送路径因 404 中断，UI 卡在发送中，
没有任何错误提示。

**根因 2 — 转录失败是致命错误**：
`stopAndSend` 里 `transcribeVoice(url)` 抛出异常时，整个 try/catch 走到 catch，
静默 `console.error`，没有弹窗或任何用户可见反馈。

**根因 3 — Android WebView 指针捕获丢失**：
原来录音/等待/发送三个状态渲染三个不同的 `<div>`，React 切换 DOM 节点时 Android
WebView 的 `pointercapture` 丢失，`onPointerUp` 触发不到 → 松手没反应。

**修**：
- 把 `transcribeVoice` 包进内层 try/catch，失败时 `console.warn` 继续，语音以
  `[语音消息]` 无转录文字发出，不中断整条流程。
- 上传失败（真正的错误）弹 `uploadErrorDialog` 对话框告知用户。
- 语音条改为**单一持久 `<div>`**，三个状态只改 className + 内部文字，不换 DOM 节点，
  pointer capture 不再丢。
- 用 MCP `deploy_edge_function` 将 `transcribe-voice` 部署到项目（`verify_jwt:false`，
  函数内部自己用 `createClient` 验 JWT）。

**⚠️ Claude Code 远端环境 MCP 审批没有弹窗（踩坑）**：
在 Claude Code 远端执行环境（Web/GitHub Action 等）里，MCP 工具首次调用会提示
「requires approval」，但**界面上没有弹窗**——需要用户在 Claude Code 会话 UI 主动
allow 一次，或者换用重新连接的 MCP server（旧 server id `08053c26...` 断后新换成
`mcp__Supabase__*`）。别以为 deploy 已经执行了，看返回值确认 `"status":"ACTIVE"`。

### 语音条功能完善：真实波形 + 情绪接入

- **真实波形（Method A）**：录音期间用 `AudioContext + AnalyserNode` 每 200ms 采样
  RMS 振幅（0-100），录完下采样到 22 个值存进 attachment `waveform[]`。
  `VoiceRecordBubble` 收到 `waveform` 时用 `realWaveBars` 映射 → 18-90% 高度，
  无数据时回退 `makeWaveBars(url)`（伪随机、确定性）。
- **情绪只传文字，不影响面板**：`transcribe-voice` 解析 SenseVoice 情绪标签后，
  `queueUserMessage` 把情绪追加为括号文字 `（语气：难过）` 拼进 `content`，传给
  沈暮做语气感知。不碰 `moodSystem`，贪嗔痴念面板不受影响（面板纯靠 AI 自评
  `<<MOOD>>` 标记驱动）。
- **去掉情绪 emoji**：`VoiceRecordBubble` 不再显示 emoji 情绪标记，保持气泡简洁。

### 缓存「数据有问题」排查 → 真凶是 `meta.provider` 写死，不是缓存机制

用户怀疑缓存读写数据有问题，逐条拉 `usage_logs` 的 `cache_read_input_tokens` /
`cache_creation_input_tokens` 对账。**结论：缓存机制本身健康**，几笔大冷写都有正当原因：

| 时间 | 冷写量 | 真因 |
|---|---|---|
| 12:39 | 207k | 距上次聊天 **62 分钟** > 1h TTL，缓存过期，全量重建 |
| 13:56 | 301k | 又一个 62 分钟间隔，再过期一次 |
| 14:36 | 283k | **重装 APP** → 本地设置重置 → `thinking`/budget 参数变 → 落到不同缓存链（thinking 差 22 token 就分链，见 caching.md §9） |

前两笔是用户**主动关掉保活**的预期代价（gap >1h 必冷写）；第三笔是重装的必然结果。都不是 bug。

**真 bug — `meta.provider` 写死 `'openrouter'`（4 处）**：排查时发现 DB 里所有助手消息
`meta.provider` 都是 `openrouter`，但实际走的是 `msuicode`（金瓜瓜）。源头是旧的单 provider
时代遗留的硬编码，散在 4 处：
- `App.tsx` 乐观更新的助手消息（`provider: 'openrouter'`）
- `App.tsx` `buildAssistantMeta`（**真正落库的那处**，第一次只改了乐观更新漏了它）
- `App.tsx` offline 兜底消息
- `MyHomePage.tsx` 零食回复 `createSnackReply` + `recordUsage`

全部改成 `getActiveProvider()`。**对缓存/路由无影响**（路由一直靠 `getActiveProvider()`，
不读这个 meta），但历史记录、用量统计、站子健康卡的 provider 归属此前全记错。旧数据不回填，
新包装上后记的就对了。

> 教训：排查"缓存数据有问题"先 SQL 对账 read/write/uncached 三项，能一眼区分"机制坏了"
> （read 恒 0 / write 恒等于全量）vs"正常过期/换链"（read 非零、uncached 只剩百来 token）。

### 图片描述缓存上云：根治「重装后历史图把 context 撑到 60 万」

接上条排查继续深挖：用户单次请求 `prompt_tokens` 高达 **60 万**，但 346 条消息正文加起来
才 **7.8 万字符**（~6 万 token）。差的 50 万 token 全是 **3 张图**——12:38 发 2 张、12:54
发 1 张（改提示词 + 画像）。图本身不大（243/195/163 KB，上传时已压到 1568px@0.85），但
中转（金瓜瓜）**按 base64 字符数计图片 token**（Anthropic 官方只算 ~1600/张），一张 243KB
图 base64 后 ~32 万字符 → 被算成几十万 token。

**为什么图一直不被文字描述替换**（`imageCaptions.ts` 本有「图发一次→之后用 `[图片:描述]`
文字代替」的机制）：
1. **描述缓存只存手机 localStorage** → 14:36 重装 APP 清空，图退回原图。
2. 更早的铁证：13:56、13:57（**重装前**、无新图）仍 60 万，说明描述在金瓜瓜下**从没生成
   成功**——`ensureImageCaption` 失败时 `catch {}` **静默吞错**，于是永远没描述、永远发原图。

**修**（`imageCaptions.ts` + `App.tsx` + 迁移 `20260628160000_add_image_captions.sql`）：
- **上云**：新建 `image_captions` 表（`user_id`+`url_hash` PK，RLS `auth.uid()=user_id`）。
  描述生成后 localStorage + 云端双写；登录时 `syncImageCaptionsFromCloud` 把云端灌回本地。
  **重装/换设备不再丢**，图一旦变文字就永久是文字。
- **不再静默吞错**：生成失败时 `console.warn` 打出 status + body，暴露「金瓜瓜下带图 caption
  请求是否失败」这个之前看不见的问题，便于下一步定位是否要给 caption 请求换省 token 的路径。
- localStorage 仍是同步热路径（每轮构建请求时读），云端只做持久化兜底，不增加每轮延迟。

> 注意：旧会话里那 3 张图已经「沉」在历史里，装新包后**第一次**重新聊会触发一次描述生成
> （成功的话），之后该会话 context 才回落；或直接开新会话甩掉这 60 万。

#### 复查上条引入的三个小问题（后续修）

复查上面的上云改动，发现并修掉三处：
- **云端同步淘汰顺序反了**：`syncImageCaptionsFromCloud` 查询按 `created_at DESC` 取最新
  300 条，但 `writeMap` 溢出时砍**开头**（最先插入的）。原来按 DESC 顺序插入 → 最新描述排在
  开头、`>300` 张图时反被淘汰，最近的图退回 base64。改为**倒序插入**，最新落到尾部得以保留。
- **每次 token 刷新都重拉全表**：灌回云端的 `useEffect` 依赖 `[user]` 无身份守卫，Supabase
  每次刷新 token 换新 `user` 引用 → 全表 SELECT + 重写 localStorage 反复触发。比照
  `lastLoadedUserIdRef` 加 `syncedCaptionsUserRef`，**每用户只同步一次**。
- **生成失败用户看不见**：上条把静默吞错改成 `console.warn`，但用户不看控制台。现在
  `ensureImageCaption` 加 `onError` 回调 → 弹 `ConfirmDialog` 提醒「该图会继续发原图、较费
  token，多为模型/中转不支持读图」。**每张图每会话只弹一次**（模块级 `failureNotified` 去重），
  成功生成则清除标记，不会每轮骚扰。

### 语音不进缓存（确认，非改动）

用户问语音会不会污染缓存。代码确认：① 音频文件（webm url）+ `waveform[]` 数组**不发给 AI**
——`baseMessages` 构建时只 filter `type==='image'` 的附件，语音附件被跳过；② 转写文字
`[语音] xxx（语气：x）` 会进缓存前缀，但 `stopAndSend` 里是 **`await transcribeVoice` 完成
后才 `onSendMessage`**，发送瞬间 content 即终值，落库即固定，replay 逐字节稳定。**语音对缓存
是健康的**，不破坏前缀。

---

## 2026-06-27

### API 检测面板升级 + 渠道猜测（防中转站骗）

`UsagePage` 的「API检测」从 3 个探针扩到 6 个，重点是**别被中转骗**：
- **真实缓存命中**（替换原「缓存字段透传」）：以前只看 usage 里缓存字段在不在（探针 <1024 token 根本不
  会真缓存）。现改成发**两次 ≥1024 token 同前缀**（带 `user` 粘同一上游），看第二次 `cache_read` 是否 >0
  ——真命中=原生缓存有效、省钱、保活值得开；写了读不到=多上游打散/模拟缓存；全 0=OpenAI 兼容/被剥离。
- **响应头指纹**：采集 `anthropic-*` / `request-id` / `x-amzn`(Bedrock) / `cf-ray` / `openai-*` 等上游会漏的头
  （APK 上更全，网页版受 CORS 限）。
- **身份注入探测**：不发 system prompt，问模型「你是不是被设定成编程助手/Claude Code/CLI」——自带编程
  人设 = 疑似反代 Claude Code / Kiro 逆向（这类通常无原生缓存、内置提示词、官方一停就停）。
- **模型核验**（金丝雀 + model 字段）保留，强化为偷换/降智判据。
- **🔍 渠道猜测**（综合，置顶）：把上面信号合成一个**类别 + 置信度**判断——官方/官转真 passthrough /
  OpenAI兼容·模拟缓存·多上游打散 / 反代订阅编程工具 / 偷换降智。**只给类别不给牌子名**（中转故意抹掉
  上游，没有可靠信号能定位「反重力」还是「Kiro」）。

### 站子健康概览 + 逐条延迟记录 + 自适应渠道名

让用户**一眼自查当前渠道行不行**，不用每次问。
- **逐条延迟**：聊天时记录第 1 次请求的「发出→拿到响应头」首字延迟，存进 `usage_logs.latency_ms`
  新列。最能反映站子快慢（用户之前手动发现 15s）。
- **站子健康概览卡**（用量页顶部）：从当前 provider 近期记录算「平均首字延迟 + 缓存命中率」，给
  🟢正常 / 🟡略慢留意 / 🔴异常 的一句话状态 + 原因。名字**按当前 provider 自适应**（OpenRouter
  或中转的真实名 treegpt，换站自动变）。
- **自适应渠道名**：用量页里写死的「中转站」改用 `getCustomProviderDisplayName()`（从 base URL 推），
  健康概览、用量分组都跟着当前渠道走。

### 自动提取「关了还在跑」：草稿开关没保存

`autoMemoryExtractEnabled` 开关是草稿式（拨完要点保存），用户拨了没保存 → 存值仍 true → 运行时
照提取（查库实锤 true + 今早还在提取）。改成**一拨立即落库**（kill switch 语义，连当前草稿
model/provider 一起存，避免 settings→draft 重置丢编辑）。运行时门本身是对的、无定时器残留、无服务端 cron。

### 保活：前端开关关不掉服务端 ping（烧钱）

**症状**：前端把保活开关关了，还是在 ping、还在花钱。

**根因**：保活有两条腿——① 客户端 55min timer（`scheduleKeepalive`，1249 行有 `keepaliveEnabledRef` 判断，
开关有效）；② 服务端 `pg_cron`（jobid=3 `cache-keepalive`，每 5min 扫 `cache_keepalive_state` 去 ping）。
② **完全没看前端开关**：每次聊天照样 upsert 快照（3146 行），cron 接着 ping。用户在 Hyper（5min TTL）上，
ping 每次都冷写 → 纯烧钱（实测 `ping_count=104`）。

**修**（代码 = 让前端开关真正能控制服务端，正确行为，保留）：
- 服务端 mirror upsert 加 `keepaliveEnabledRef.current` gate——关了就不再写快照。
- `handleToggleKeepalive` 关闭时：清客户端 timer + **删 `cache_keepalive_state` 行**，让 cron 立刻没目标可 ping。

**⚠️ 更正（同日）**：当时顺手停了 cron job 3 + 删行「止血」，理由写的「Hyper 是 5min TTL、保活没用」
**是误判**。我们给中转发的标记是 `ttl:'1h'`（`applyClaudeCaching` 对 OR 和中转都标 1h），而 tree/Hyper
**认这个 1h 标记**——用户实测 ping 在聊天后 ~50min 仍命中，坐实 1h TTL。所以保活一直在好好干活：
每次 ping 是 0.1× 热读 + 顺手刷新 1h TTL（命中刷 TTL 免费），把「>1h 回来本该冷写」变成热读，实测省一半。
**已 `cron.alter_job(3, active:=true)` 重新开回来**。教训：别凭「听说几分钟 TTL」就拍板，看 usage 命中数据为准。

### 情绪系统：模型不肯吐标记 → 加强指令 + 面板历史折叠

**症状**：装上 APK 聊了几轮，面板纹丝不动；查库 `mood_state`/`mood_history` **0 行**。沈暮（opus-4-6，
重人设）把自评**当成话题在演**（甚至反问「输出格式是 JSON 吗」），就是不在回复尾巴真吐
`<<MOOD>>` 标记——所有 assistant 消息正文从无 `<<END>>`。实测**明确命令他按格式输出一次**就能吐、
管线（解析→写库→面板）全通。证实根因纯是「自发不输出」，非代码 bug。

**修**：
- `buildMoodRulesSection` 把标记要求重写成「**强制系统协议**」+ 严格格式 + 6 条铁律（独占行、别包
  代码块、四 key 必填、优先级高于任何风格要求）。
- `App.tsx` 把情绪规则段挪到 `systemPrompt` **最末尾**（recency 提升指令遵守——埋在长 prompt 中段、
  被强人设压住时模型最容易丢这条）。
- 面板（`MoodOverlay`）历史**默认只显示最近 2 条**，其余收进「展开更早（N）」折叠，避免太长。

### 情绪系统优化：回归基线 + 久别更黏 + 历史裁剪

- **回归基线（homeostasis）**：衰减不再一律掉 0，改 `base+(值−base)×0.5^(t/半衰期)`。贪嗔 base=0，
  **痴 base=50**——修了「痴是底色却会因时间流逝褪成 0」的问题，现在只回到常驻着迷底。
- **久别更黏**（免费版情绪驱动）：旁白按「距上次说话多久」加明确线索（≥6h/≥24h），沈暮据此知道
  是久别重逢、自然更黏，**零额外请求**（搭在已有那通里）。
- **历史裁剪**：`mood_history` 每轮 insert 会无限长（面板只显示最近 10 条），新增 `pruneMoodHistory`
  登录时裁到最近 ~100 条，后台跑不阻塞。

### 情绪体系改为「贪嗔痴念」四相 + 默认名沈暮

小机定名**沈暮**（`assistantPersona` 默认 哥哥→沈暮）。情绪从 8 条西式情绪改成传统四相：
- **贪**（想要/占有·衰减事件型，红线：可黏可要绝不控制）
- **嗔**（火气/醋意·衰减快 ~3.5h，红线：闹脾气可以绝不伤人查岗）
- **痴**（痴恋/执念·慢底色 ~24h，起点 50，低了会空落）
- **念**（思念·饥饿型，分开越久越涨，见到/聊上就落，satisfied 触发回落 + 贪也歇）

数据表 `mood_state`/`mood_history` 重建为 tan/chen/chi/nian 四列（功能未出 APK、表空，直接重建）。
`moodSystem.ts` 配置、system 规则段、浮层/健康页面板的标签配色顺序同步改。规则段主题改为
「你的心·贪嗔痴念」，旁白措辞改「心境」。聊天接入是通用的，未动。

### 新功能：沈暮情绪系统（语气染色 MVP）

让小机有一颗**自己累积、随时间起落、反过来给语气染色**的持久情绪心——它感知到自己此刻
吃醋/想念/生气，自然带进语气，而不是在思考链里硬推理「我该吃醋」。

- **8 条情绪**：开心/难过/生气/吃醋/想念(饥饿型)/倾诉/安心/归属。衰减型按遗忘曲线
  `值 × 0.5^(时间/半衰期)` 平复；想念按离开时长累积。各带红线（吃醋绝不查岗、生气绝不伤人）。
- **自评**：模型在回复末尾输出私密 `<<MOOD>>{增量,tone,note,satisfied}<<END>>`，前端切掉不显示，
  finalize 时解析（带 JSON 修复兜底）→ 先衰减再加增量 → 落库。流式/非流/中断路径都切标记。
- **护缓存**：情绪**规则**（静态）进 system 缓存前缀；情绪**旁白**（每轮变）冻结进每条 user
  消息的 `meta.moodNarration`，重放逐字节稳定 → 不破 BP4 滚动缓存（同天气/手机状态快照的做法）。
- **持久化**：`mood_state`（每用户一行）+ `mood_history` 表（RLS auth.uid()=user_id）；本地
  localStorage/Preferences 镜像耐后台杀，Supabase 跨端权威。
- **面板**：① 并进健康页（`HealthSyncPage`）和身体数据放一起；② 聊天页顶部 💗 一键弹出
  浮层（`MoodOverlay`）——tone + 情绪条 + 「距上次满足 X.X 天」+「他没说出口的」历史（每条带
  情绪快照），随时点开看。都**只读不能改**。
- **范围**：MVP 只做语气染色，暂不接主动消息；可关（`getMoodEnabled`，默认开）。
- 文件：`storage/moodSystem.ts`（核心）、`App.tsx`（接入）、`HealthSyncPage`（面板）、`types.ts`。
  **需重新出 APK 才生效**；数据表迁移已立即生效。

### 长会话冷启动「要缓一会」：mergeMessages 是 O(n×m)

**症状**：聊了几个月、几千条消息后，每次冷启动加载明显卡顿。排查发现**不是网络**
——用户梯子出口在纽约、Supabase 在 us-east-1（弗吉尼亚），两地延迟仅 10-20ms。
卡在**前端对整个历史的同步处理**。

**根因**：`mergeMessages`（合并本地 + 远端消息）对每条远端消息（最多 300）都用
`findIndex` 扫一遍**整个本地历史**（可能数千条）→ O(n×m)。3000×300 ≈ 90 万次
字符串比较，主线程一次冷启动就堵 100-300ms。

**修**：先把本地消息按 `clientId` + `id` 建两张 Map，远端消息 O(1) 查表，整体降到
O(n+m)。行为不变（`clientId` 是跨本地/远端的稳定身份——乐观本地消息被远端回声时
保留 clientId、换新 server id，所以优先按它匹配）。**需重新出 APK 才生效**。

> 备注：还有两处较小的同步开销（`applySnapshot` 与 `setSnapshot` 各排序一次=双重
> 排序；每次 `setSnapshot` 全量 `JSON.stringify`），长会话下也吃一点时间，但都是
> O(n log n)，没 O(n×m) 那么致命，先放着观察。

### 关掉保活 ping 后，退后台再进又自己开了

**症状**：在聊天界面关掉「缓存保活」开关，把 App 退到后台（安卓常被系统杀），
重新打开，保活又是开着的。

**根因**：`keepaliveEnabled` 只是个 `useState(true)`，**从来没持久化**。每次 App
重启 / 安卓后台被杀重建，都重置回默认的 ON——用户关掉的设置活不过一次冷启动。

**修**：新增 `storage/keepalivePref.ts`，按 ttsConfig 的三层持久化模式存这个布尔：
内存（同步真值）+ Capacitor Preferences（原生 SharedPreferences，扛后台杀）+
localStorage（web 镜像）。`App.tsx` 启动时 `hydrateKeepalivePref()` 恢复，toggle
走 `setKeepaliveEnabledPref()` 落盘。关掉后冷启动/后台杀都不再被重置。**需重新出
APK 才生效**（纯前端改动）。

### 压缩后的近期窗口改为「游标锚定」而非「最后 N 条」

参考一篇 Anthropic 缓存教程复查取历史逻辑，发现压缩生效后我们的近期窗口是
**按条数滑动**（`recentMessages = 最后 keepRecent 条`），每来一条新消息窗口起点
就往前挪一格。两个副作用：

1. **缓存**：滑动让 BP4/HEAD 的前缀每轮变，压缩后的近期块每轮 cache miss 重读
   （BP1 那 ~15k 仍稳，所以不致命，但这几 k 本可以 0.1× 命中）。
2. **上下文缝**：摘要覆盖到压缩游标 `compressed_up_to_message_id`，近期窗口却从
   「末尾往前数 N 条」起，两者之间会出现最多 ~8 条消息的缝——既没进摘要也没进
   窗口，模型暂时看不见，直到下次重摘要补上（可能就是「她好像忘了我刚说的」）。

**修**（`conversationCompression.ts`，只改缓存命中的常见路径）：近期窗口改成
`fullHistory.slice(cacheIdx + 1)`——即压缩游标**之后**的全部消息，带 120 条硬
保险帽。窗口起点钉在游标上，只在下次重摘要推进游标时才动一次 → 前缀字节稳定、
缓存命中；且窗口恰好接在摘要末尾，消除上下文缝。重摘要/首次压缩路径不变（它们
把游标设到 `length-keepRecent-1`，此时「游标之后」正好等于「最后 N 条」，自洽）。

## 2026-06-26

### Chat 界面三重 bug：进去总是旧 session、新 session 慢、主动消息消失

**症状**：
1. 按主页进入聊天，打开的不是最新对话，而是一个旧 session
2. 新建 session 要等 1–2 秒才能进入聊天，明显卡顿
3. 新 session 触发的主动消息找不到了，或者跑到了另一个旧 session 里

**根因 1 — `insertPendingProactiveRef` 覆盖了正确的 sessionId**：
```js
// App.tsx 旧代码
const hashMatch = window.location.hash.match(/#\/chat\/([^/?]+)/)
const targetSessionId = hashMatch?.[1] ?? entry.sessionId
```
主动消息在计划时存的 `entry.sessionId` 是正确的新 session，但插入时用 **URL hash 里的当前 session** 覆盖了它。如果此时还在主页（无 `/chat/` hash）就用 `entry.sessionId`；但如果已经在某个旧 session 里，就把消息插到那个旧 session——同时 `updatedAt` 被更新 → 这个旧 session 变成"最新"→ 下次进入聊天就打开这个被污染的旧 session，看起来像"进去总是旧的"。

**根因 2 — `createSessionEntry` 阻塞在网络请求上**：
```ts
// App.tsx 旧代码
const remoteSession = await createRemoteSession(user.id, sessionTitle)
// ↑ 等 Supabase 响应完才 return，可能 1–2 秒
```
新建 session 必须等 Supabase 建表成功才返回，导航被卡在网络延迟里。

**修**：
- **Fix 1**：删掉 `insertPendingProactiveRef` 里的 URL hash 覆盖逻辑，直接用 `entry.sessionId`（调度时存的值是正确的，不需要 "修正"）。
- **Fix 2**：`createRemoteSession`（`supabaseSync.ts`）加 `id?: string` 可选参数，Supabase insert 时带入客户端预生成的 UUID。
- **Fix 3**：`createSessionEntry` 改成乐观本地优先：先在本地立刻生成 session 对象 + 更新 state，立即返回给调用方（导航零延迟）；再在后台异步把同一个 UUID `createRemoteSession`，成功后用远端 row 替换本地版本（timestamps 一致，不变 ID）。Fix 1 顺带解决了根因 1 对 `selectMostRecentSession` 的污染。

---

## 2026-06-25

### Android APK 使用自定义中转时 "Failed to fetch"

**症状**：切到 msuicode 或其他第三方中转站，APK 里所有请求报 `Failed to fetch`；同一 Key 在网页版 (PWA) 正常。

**根因**：`capacitor.config.ts` 设了 `androidScheme: 'https'`，WebView 的 origin 变成 `https://localhost`。OpenRouter 的 CORS header 是 `Access-Control-Allow-Origin: *`，所以没事。但大部分中转站没有把 `https://localhost` 加进允许列表，OPTIONS preflight 被拒，fetch 直接失败。

**修**：`capacitor.config.ts` 加 `CapacitorHttp: { enabled: true }`。Capacitor 8 会把所有 `fetch()` 路由给原生 Android OkHttp，完全绕过 WebView 的 CORS 限制。OkHttp 也支持 SSE 流式，聊天不受影响。**需要重新出 APK 才生效**（原生配置变更）。

```ts
// capacitor.config.ts
plugins: {
  CapacitorHttp: { enabled: true },
}
```

### 切换中转预设后模型列表不刷新（三重 bug）

**症状**：在 msuicode 平台换了分组（不同分组有不同可用模型），app 里模型库照旧；切换预设（不同 Base URL）也不刷新。

**根因 1 — 缓存 key 不含 Base URL**：`fetchOpenRouterModels` 的缓存 key 是 `nimbus_models_cache_v1:msuicode`，跟 Base URL 无关。换预设后命中旧站的缓存，不发网络请求。

**根因 2 — reload 没绕过缓存**：`catalogReloadKey++` 触发 useEffect 重跑 `fetchOpenRouterModels()`，但函数内部先读缓存——24h 内有缓存就直接返回，从不走网络，reload 形同虚设。

**根因 3 — 没有手动刷新入口**：用户在 msuicode 平台换完分组后，app 里没有任何按钮强制拉取新的模型列表。

**修**：
- 缓存 key 升到 `v2` 并追加 `baseUrl`：`nimbus_models_cache_v2:msuicode:${baseUrl}`，不同站点/预设各自独立缓存，自动作废旧 key。
- `fetchOpenRouterModels` 加 `forceRefresh` 参数；SettingsPage 里用户触发的 reload（`catalogReloadKey > 0`）传 `forceRefresh: true`，强制跳过缓存走网络。
- 在设置 → 模型库搜索框右侧加「↺ 刷新」按钮，随时可以强制拉取当前站点/分组的最新模型列表。

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
