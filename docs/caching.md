# Prompt Caching 指南

> 给下一个 session / 其他人查阅:Nimbus 怎么用 Anthropic **原生 prompt caching** 省钱、怎么配中转、怎么验证命中、踩过哪些坑。
> 配套代码:`src/App.tsx`(`applyClaudeCaching`)、`src/api/anthropic.ts`(原生适配器)、`src/api/openrouter.ts`(路由)、`src/storage/apiProvider.ts`(provider/格式/预设)、`src/storage/imageCaptions.ts`(图片转文字)。

---

## 1. 一句话原理

每一轮对话都要把「system + 全部历史」重新发给模型,对话越长越贵。**Prompt caching 让供应商把已经发过的「前缀」缓存在它自己的节点上**,下次命中只按 **0.1× 输入价** 收费(省 ~10 倍)。省的是**服务端少算钱**——客户端没法凭空造缓存,只能:① 正确发出缓存标记;② 让前缀逐字节稳定以提高命中率。

---

## 2. 两个必要条件(缺一不可,否则静默失败)

1. **`cache_control: { type: 'ephemeral' }`** 挂在内容块上(system / 历史 message 的 text block 上)。
2. **顶层 `metadata.user_id`**(固定字符串)。中转的负载均衡会把请求随机派到不同后端;`user_id` 让同一用户**粘在同一节点**,否则"只写不读、命中永远 0"。

Nimbus 现状:`anthropic.ts` 把 OpenAI 风格的 `body.user` 映射成 `metadata.user_id`(用 Supabase user id),`applyClaudeCaching` 负责挂 `cache_control`。

---

## 3. 走哪条路才有缓存

**只有 Anthropic 原生 `/v1/messages` 路径**认 `cache_control`。OpenAI 兼容的 `/chat/completions` 不认(中转一般直接丢掉)。

在 Nimbus 里,这取决于 **provider + 格式**:

| provider | 格式 | 走哪条 | 有缓存? |
|---|---|---|---|
| OpenRouter | (自动) | 自动路由 Claude 到原生 `/v1/messages` | ✅ |
| 中转(msuicode 槽) | **Anthropic 兼容** | 原生 `/v1/messages` | ✅ |
| 中转(msuicode 槽) | OpenAI 兼容 | `/chat/completions` | ❌ |

> ⚠️ 用中转(金瓜瓜等)想要缓存,**格式必须选「Anthropic 兼容」**。这同时也是思考链能不能出来的开关。
> 历史坑:`applyClaudeCaching` 曾经写死 `if (provider !== 'openrouter') return`,导致中转**永远不挂缓存**;已改为「会走原生路径的渠道都挂」。

---

## 4. 各家中转对比(2026-06 实测)

倍率 = 每 $1 官方价付多少人民币(越低越便宜)。OR 实际倍率 ~7.8。

| 渠道 | 倍率 | 缓存(三方客户端) | 备注 |
|---|---|---|---|
| 金瓜瓜·风铃草 | 2.0 | ✅ 原生(**1h TTL**) | 官转级别;控制台标"无缓存"指不做 OAI 模拟缓存,原生 `cache_control` 照样命中 |
| 金瓜瓜·金色铃兰 | 7.5 | ✅ | Anthropic 官方直连,最稳但≈OR 价 |
| OpenRouter | ~7.8 | ✅ 原生(**1h TTL**) | 最稳/最全,国内可能要梯子 |
| 某些便宜号池/逆向中转 | 0.5~0.9 | 看渠道 | 便宜但易"空回",新模型滞后看渠道 |

**TTL 很关键**:
- OpenRouter **1h**:配 55 分钟"续命 ping"保活(见 §9)。
- 金瓜瓜 **5m**:连续聊天才命中;**停超过 5 分钟缓存就掉**,下一条重建一次(冷写)。**不需要也不该 ping**(55 分钟救不回 5 分钟的缓存)。
6.11金瓜瓜也改为1h 但无ping
  - ⚠️ **TTL 是「滑动窗口」,不是「总共只能用 5 分钟」**:每次命中都把 5 分钟**重新计时**,所以只要聊天间隔 <5 分钟就一直热着,聊几小时也一直命中。只有**静默 >5 分钟(期间零请求)**才真过期。
  - **冷写没那么亏**:过期后那一条只是把前缀按 **1.25× 写一次**(不是永远全价),之后立刻回到 0.1× 读。约等于多花"一条普通消息"的钱。所以**一阵一阵地聊**=每阵开头冷写一次、其余全便宜;真正吃亏的只有"每条都隔 >5 分钟"的极端节奏(那样缓存几乎帮不上、甚至略亏 0.25×)。

---

## 5. 在 Nimbus 里接一个中转(以金瓜瓜风铃草为例)

设置 → 「🪞 中转 API Key」:
1. **格式** → **Anthropic 兼容**(关键)
2. **Base URL** → `https://gua.guagua.uk`(Nimbus 自动补 `/v1/messages`)
3. **API Key** → 中转后台的 key
4. **模型** → 从中转「模型广场」复制风铃草的 id(如 `claude-opus-4-6` / `claude-opus-4-6-thinking`),别手敲

**多中转混用**:同一区底部「＋ 把当前中转存为预设」,可存多套(当前家 / 金瓜瓜 …)一键切换(`apiProvider.ts` 的 `RelayPreset`,只写入现有自定义槽,不改路由逻辑)。

---

## 6. 怎么验证真的命中了

看响应 `usage`:
- 第一轮:`cache_creation_input_tokens` 一大坨(在建缓存),`cache_read=0` —— 正常冷启动。
- 第二轮起:`cache_read_input_tokens` 非零 —— **命中了**。
- 一直 `read=0 write=0` → `cache_control` 没生效(格式不对 / 没走原生)。
- 一直只 write 不 read → 路由飘了(`user_id` 没带,或超过 TTL)。

途径:
- App 内 `/usage` 页的缓存命中 %。
- 中转后台账单(如金瓜瓜 `woof.guagua.uk/console`):一行里「**缓存读 66,759 · 写 248**」=命中;「**输入 10**」=本轮新增的非缓存输入。命中率 = 缓存读 ÷(缓存读+输入+写)。
- 后台里"只有输入/输出、无缓存字样"的小条,多半是**辅助调用**(图片转文字描述 §8 / 压缩摘要),不是聊天主请求,无需缓存。

---

## 7. 块布局与高命中率(踩出来的铁律)

缓存是**前缀匹配**:从第一个字节起,有一个字节变了,从那往后全部失效重算。所以把请求按「最不会变 → 最会变」码好,只给前面稳定的部分挂标。

Nimbus 的做法(`applyClaudeCaching`):
- **BP1**:第一条 system(人设 + 工具 schema),最稳的垫底锚点。
- **BP4(rolling)**:挂在**倒数第二条 user 消息**上,把全部历史纳入缓存边界。挂倒数第二条而非最后一条,因为最后一条是本轮新输入、每次都不同。
- **工具迭代**:若最后一条 user 之后还有 tool 块,挂 **BP1 + 最后一条 user 消息**(=本轮 HEAD,它就是上一次请求已写过的缓存前缀的末端)。**故意不标 tool_result 本身**——那段前缀含工具块、下一轮读不到,写了纯浪费 2× 写入费。
  - ⚠️ **2026-06 修正(重要省钱)**:早期工具迭代**只标 BP1**,理由是"BP4 在带 tool 的请求里 walk-up 静默 miss"。但据 Anthropic 文档,`cache_control` **可以放 tool_result**,且 walk-up 有 **20 个内容块**的回溯窗口——Nimbus 每轮工具调用通常只 1~2 个 tool 块,远在窗口内,稳定命中。只标 BP1 的旧行为导致 **BP1↔最后一条 user 之间的几万 token 历史在每次工具调用时全价重读**(`search_memory` 几乎每轮触发 → 长会话哗哗烧钱)。修正后:标到最后一条 user(在 tool 块之前),缓存前缀止于 user 消息,正好是上一轮 HEAD 写过的那份,这次是 **0.1× 读命中**而非全价。

通用铁律:
1. **易变内容不要进缓存前缀**。Nimbus 的时间戳是**按每条消息创建时刻烙死**的(`[当前时间] …` 写进当时那条 user 消息),历史逐字节不变,不会每轮把"现在几点"塞进前缀。
2. **工具调用不进持久历史**:`tool_use/tool_result` 只在本轮工具循环里临时存在,重放的历史是纯文字(+图片描述)。
3. **`user_id` 固定不变**。
4. **不要 retry 重写前面的轮次**(会改前缀,整段重建)。
5. **工具 schema 顺序固定**。

---

## 8. 图片转文字描述(`imageCaptions.ts`)

历史图片每轮重发很贵(图片 token 重)且撑大前缀。做法:
- 图片**第一次出现照常发原图**(模型看得到),同时**异步用当前模型生成一两句中文描述**,存进本地缓存(url 哈希 → 描述)。
- **之后的轮次改发 `[图片:描述]` 文字**;原图仍留在消息里供 UI 显示。
- 生成失败就没缓存项 → 继续发原图,**优雅回退,不动消息/数据库**。

---

## 9. 续命 ping(OpenRouter + 金瓜瓜 1h 档)

1h TTL 的缓存在静默时会过期。续命 ping 用一条极小请求把缓存**读**一次,刷新 TTL 防过期——冷写一次 ~¥1.32,保活一次 ~¥0.07,差近 20 倍所以值得。

**两条腿,缺一不可:**

1. **客户端 timer**(`App.tsx`):一次成功对话后约 55 分钟发一条 ping。App 在前台/未被杀时有效。
2. **服务端 pg_cron**(`cache_keepalive` Edge Function,每 5min,`*/5 * * * *`,jobid=3):覆盖**手机把 App 杀后台**的情况——客户端 timer 那时已经死了。每条聊天会把当时的原生请求体(连同 key + 路由)存进 `cache_keepalive_state` 表,cron 扫"90min 内聊过的行",对 ≥50min 没 ping 过的发一条。这是真正的「常驻服务器」,不用买 VPS。

**⚠️ ping 必须和真实聊天「同形」,否则刷的是另一份缓存(2026-06-17 实测踩坑)**:金瓜瓜/Anthropic 把**带 thinking** 和**不带 thinking** 的请求当成**两条独立缓存链**。实测同一段 ~66k 历史:带 thinking 的真实聊天缓存在 `cache_read=65931`,去掉 thinking 的 ping 缓存在 `65909`——**互不相通**。所以早期那版「`max_tokens:1` + 删掉 thinking」的 ping 看似成功(读到 65909),其实读的是**它自己上一条 ping** 留下的私有副本,真实聊天(带 thinking)**永远读不到**,该冷写还是冷写。证据:一条带 thinking 的真实聊天命中后 13 分钟,那版 ping 仍然**冷写**了整段 65909。
  - **修法**:ping **保留 thinking**(连 `budget_tokens` 都要和聊天一字不差——budget 1024 vs 2000 也会分裂成两条链),`max_tokens` 设成 `budget+1`(extended thinking 要求 `max_tokens > budget`;budget 是**上限不是目标**,模型实际只吐 ~17–26 token,所以 ping 仍 ~¥0.07)。`stream` 实测**不影响**缓存键(非流 ping 能读流式聊天的缓存,都命中 65931),所以 ping 用 `stream:false` 省事。
  - **`stream` 路由那套旧说法是误判**:曾以为 relay 把 stream/非 stream 路由到不同节点导致 ping 不命中,实测证伪——非流 ping 照样读到流式聊天的 65931。真凶是 thinking。

**触发条件**(`App.tsx`,2026-06-17 修正):凡是走了原生 `/v1/messages` 的 Claude 对话都存体保活,即
`isClaudeModel && (provider==='openrouter' || providerFormat==='anthropic')`。
旧代码写死 `activeProvider==='openrouter'`,导致**金瓜瓜用户的请求体从不入表**,服务端没数据可 ping——这是服务端保活对金瓜瓜"不生效"的另一个真因。

**安静时段 00:00–08:00(北京时间)不 ping**(Edge Function 顶部早返回 `quiet_hours:true`):睡觉时缓存过期就让它过期,夜里 ping 纯浪费。早上**第一条消息**会冷写一次(无法避免,这是关安静时段的代价),但它会更新 `last_chat_at`,8 点后下一个 cron tick 就把这条新缓存 ping 热,**之后**整天的消息都命中。所以——**ping 不"写"缓存,写是早上第一条真实消息干的;ping 只是之后一路读着保温**。

- 金瓜瓜默认配成 **1h TTL**(6.11 改),所以和 OR 一样吃这套保活;若回到 5m 档则**不该 ping**(55 分钟救不回 5 分钟缓存,连续聊自然命中即可)。
- 服务端走 Deno `fetch`,**不是 pg_net**:pg_net(libcurl)对金瓜瓜有 HTTP/2 framing 不兼容(`Stream error in the HTTP/2 framing layer`),用它测会全挂——但那是测试工具的锅,生产路径(Edge Function→Deno fetch)实测满命中 `cache_read=65931 / cache_create=0 / output≈17`。

---

## 10. FAQ / 踩坑

- **`temperature and top_p cannot both be specified`**:金瓜瓜/风铃草上游只允许其一。Nimbus 已改为原生路径两者并存时只留 `temperature`。临时绕过:设置里只留一个采样参数。
- **思考链选了却不出来**:多半是中转格式为 OpenAI 兼容(请求没走原生 `/v1/messages`),或模型非 Claude 且没开全局「高触发 Thinking」。切「Anthropic 兼容」即可。
- **控制台写"风铃草无缓存"**:指不做 OAI 模拟缓存;原生 `cache_control` 照样命中(已被实测 99% 验证)。
- **空回**:多见于便宜的号池/逆向渠道上游吐空;也可能是非原生格式没解析出内容。求稳上官方直连档(金色铃兰 / OR)。

---

## 附:Nimbus 的成本优化实现(从 README 移入)

- **Anthropic Prompt Caching**:1 小时 TTL(写贵 2x,读 0.1x)。**OR 启用显式断点缓存(BP1+BP4+HEAD 三锚点)**,中转站需用 Anthropic 兼容格式才挂(原生 `/v1/messages`)。Claude on OR 自动路由到 OR 原生 `/api/v1/messages` 端点(OR 的 `/chat/completions` 翻译层会丢 `cache_control` marker,踩过 0% 命中工具迭代的坑后切的)
- **Cache marker 策略**(三个 breakpoint,Anthropic 上限 4 个):
  - **BP1**:打在系统提示词的 text block 上 —— 几乎永不变的基础上下文,任何上层 miss 都能 walk-up 到这里兜底
  - **BP4**:倒数第二条 user message —— 上一轮的 HEAD,新一轮请求过来 walk-up 命中
  - **HEAD**:最新一条 user message —— 写入新缓存
  - **工具迭代特例(2026-06 修正)**:请求里最后一条 user message 之后有 `tool_use`/`tool_result` 时,标 **BP1 + 最后一条 user message**(=本轮 HEAD,缓存前缀止于它、在 tool 块之前)。**不标 tool_result 块本身**。
    - 旧行为(已废):只标 BP1。当时担心标 HEAD/BP4 会写入含 tool 块的 ~77k 新缓存。**但那是误判**——标"最后一条 user"的前缀**不含**其后的 tool 块,且它正是上一轮 HEAD 已写过的缓存,这次是读命中不是写。旧行为的真实代价:BP1↔最后一条 user 之间的几万 token 历史每次工具调用全价重读(`search_memory` 几乎每轮触发 → 长会话烧钱主因)。
    - 依据:Anthropic 文档明确 `cache_control` 可放 `tool_result`,walk-up 回溯窗口 **20 个内容块**;Nimbus 每轮工具调用只 1~2 块,稳定命中。
- **`metadata.user_id` 后端粘性**:`anthropic.ts` 把用户 ID 塞到 Anthropic 原生 `metadata.user_id`,Anthropic 用它做后端节点路由 —— 同用户的请求落到同一节点,缓存读写在同一处
- **聊天接力刷新**:命中 cache 自动续 TTL 不要钱(Anthropic 官方:"refreshed at no additional cost")。只要 1h 内继续聊,缓存一直热着。这是主要的省钱机制
- **`tool_choice` 翻译完整**:`anthropic.ts` 把 OpenAI 的 `tool_choice: 'none'/'auto'/'any'/'required'/{type:'function',function:{name}}` 统一翻成 Anthropic 的 `{type:...}` 形式。**之前没翻译这字段**,导致 MAX_TOOL_ITERATIONS 的收尾调用为了阻止模型继续调工具只能 `delete body.tools`,而 `tools` 是 cache key 的一部分,每次工具循环爆顶都触发 ~50k 全量冷写 ($0.15)。修完之后:保留 tools 用 tool_choice='none' 阻止调用,cache 完整命中
- **Keepalive ping(已重启 + 修对,2026-06-17)**:客户端 timer + 进页面 pre-warm + 服务端 pg_cron 每 5min 三层,覆盖长 gap 后的早晨第一条冷写。本次修了**三个**叠加的坑:
  - ① **触发门**:`App.tsx` 写死只给 OpenRouter 存请求体 → 金瓜瓜用户服务端表为空、无数据可 ping。改成 `isClaudeModel && (provider==='openrouter' || format==='anthropic')`。
  - ② **ping 同形**(最关键):旧 ping 删掉 `thinking` + `max_tokens:1`,结果**刷的是另一条缓存链**——带 thinking 的真实聊天缓存在 `cache_read=65931`,不带 thinking 的 ping 在 `65909`,两者**互不相通**。所谓"满命中 65909"是 ping 读自己上一条 ping 的**假阳性**;真实聊天该冷写还是冷写(实测:warm 聊天后 13min,旧 ping 仍冷写 65909)。修法:**保留 thinking + 原样 budget**,`max_tokens=budget+1`(模型实际只吐 ~17 token,ping 仍 ~¥0.07)。验证:生产 ping 现读 `cache_read=65931 / cache_create=0`,和真实聊天同一条链。详见 §9。
  - ③ **stream 路由旧说法证伪**:非流 ping 实测能读流式聊天的 65931,stream 不影响缓存键。(另:pg_net/libcurl 对金瓜瓜有 HTTP/2 framing bug,只是测试工具的锅,生产 Deno `fetch` 无此问题。)
  - 现状:`pg_cron` job(jobid=3,`*/5 * * * *`)已 `cron.alter_job(active:=true)`;活跃窗口 24h→90min(只跟随真实聊天);加了 00:00–08:00(北京)安静时段。停掉用 `cron.alter_job(3, active:=false)`。
- **对话压缩**:历史超阈值时自动用 summarizer 模型摘要,节省 token。**工具迭代特例**:模型支持工具时阈值自动收紧到 35%(=Claude 上下文 7万 token,默认 65%=13万),提前压缩成 ~20k 上下文减小绝对体量。
  - ⚠️ 这条收紧的原始理由是"walk-up 在带 tool 的请求里不命中、~62k 历史每次全价重读";**2026-06 缓存修正后该前提已部分失效**(工具迭代现在能命中历史缓存)。压缩仍有价值(缩小绝对 token、降冷写成本),但 35% 这个激进阈值可能已偏保守,后续可重测放宽。代码本身未随本次修正改动。
- 默认 summarizer = **DeepSeek-V3.1**(`deepseek/deepseek-chat-v3.1`),比 GPT-4o-mini 中文摘要质量更稳,OR 自带 prompt cache 后实际成本更低。设置可单独选 summarizer 的 provider 和 model
