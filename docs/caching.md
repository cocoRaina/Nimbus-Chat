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
| 金瓜瓜·风铃草 | 2.0 | ✅ 原生(**5m TTL**) | 官转级别;控制台标"无缓存"指不做 OAI 模拟缓存,原生 `cache_control` 照样命中 |
| 金瓜瓜·金色铃兰 | 7.5 | ✅ | Anthropic 官方直连,最稳但≈OR 价 |
| OpenRouter | ~7.8 | ✅ 原生(**1h TTL**) | 最稳/最全,国内可能要梯子 |
| 某些便宜号池/逆向中转 | 0.5~0.9 | 看渠道 | 便宜但易"空回",新模型滞后看渠道 |

**TTL 很关键**:
- OpenRouter **1h**:配 55 分钟"续命 ping"保活(见 §9)。
- 金瓜瓜 **5m**:连续聊天才命中;**停超过 5 分钟缓存就掉**,下一条重建一次(冷写)。**不需要也不该 ping**(55 分钟救不回 5 分钟的缓存)。

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
- **工具迭代**:若最后一条 user 之后还有 tool 块,只挂 BP1(避免给"永不会被读"的工具前缀写一份大缓存)。

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

## 9. 续命 ping(只在 OpenRouter)

OR 的 1h TTL 缓存,在静默时会过期。Nimbus 在一次成功的 Claude-on-OR 对话后约 **55 分钟**发一条保活 ping(`max_tokens` 极小、去掉动态段、不写历史),刷新缓存防过期——冷写一次 ~$0.10,保活一次 ~$0.013,差近 10 倍所以值得。

- **只在 `activeProvider === 'openrouter'` 触发**(`App.tsx`)。
- 金瓜瓜(5m TTL)**不 ping**:55 分钟救不回 5 分钟缓存,连续聊自然命中即可。

---

## 10. FAQ / 踩坑

- **`temperature and top_p cannot both be specified`**:金瓜瓜/风铃草上游只允许其一。Nimbus 已改为原生路径两者并存时只留 `temperature`。临时绕过:设置里只留一个采样参数。
- **思考链选了却不出来**:多半是中转格式为 OpenAI 兼容(请求没走原生 `/v1/messages`),或模型非 Claude 且没开全局「高触发 Thinking」。切「Anthropic 兼容」即可。
- **控制台写"风铃草无缓存"**:指不做 OAI 模拟缓存;原生 `cache_control` 照样命中(已被实测 99% 验证)。
- **空回**:多见于便宜的号池/逆向渠道上游吐空;也可能是非原生格式没解析出内容。求稳上官方直连档(金色铃兰 / OR)。
