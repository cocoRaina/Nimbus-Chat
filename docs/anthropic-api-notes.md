# Anthropic API 踩坑笔记

> 给下一个 session / 自己查阅：Anthropic API 里那些**文档写了但容易漏看、或者只有踩过才知道**的坑。
> 有新发现随时追加。

---

## 1. Extended Thinking + Tool Use：thinking block 必须原样回传

**官方要求**（来自 anthropic-cookbook `extended_thinking_with_tool_use.ipynb`）：

> "Include all blocks from the response when submitting subsequent requests."
> "messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`. When `thinking` is enabled, a final `assistant` message must start with a thinking block."

**规则**：当 iter1 的 assistant 回复里有 thinking block + tool_use block 时，iter2 的 messages 里的那条 assistant 历史**必须按原顺序包含**：

```
thinking block（含 signature）
↓
text block（如有）
↓
tool_use block
```

缺 thinking block → API 直接 400 拒绝（或走不同缓存路径冷写）。

**thinking block 的结构**：

```json
{
  "type": "thinking",
  "thinking": "...模型的推理文字...",
  "signature": "...Anthropic 签发的不透明 token..."
}
```

`signature` 是服务端对这段推理内容的加密签名，作用是防止客户端篡改 thinking 内容再发回。**不能伪造、不能省略、必须原样**。

**redacted_thinking block** 也必须回传（模型有时会把部分推理加密隐藏，这时 `type=redacted_thinking`，只有 `data` 字段没有可读文字）。**流式里 redacted_thinking 和普通 thinking 的差别**：普通 thinking 通过 `thinking_delta` + `signature_delta` 逐步到达；redacted_thinking **没有 delta 事件**，完整的 `data` 字段直接在 `content_block_start` 事件的 `content_block` 对象里，到 `content_block_stop` 时直接用即可。

---

## 2. Streaming 里的 thinking block：SSE 事件顺序

**普通 thinking block**（可读）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `content_block_start` | `content_block.type = "thinking"` | 宣告这个 block 是 thinking |
| `content_block_delta` (多次) | `delta.type = "thinking_delta"`, `delta.thinking` | 逐块推理文字，需累积 |
| `content_block_delta` (一次) | `delta.type = "signature_delta"`, `delta.signature` | 签名，单独一个事件，在所有 `thinking_delta` 之后，**直接赋值不是追加** |
| `content_block_stop` | `index` | block 结束，此时拼出完整块 |

**redacted_thinking block**（加密）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `content_block_start` | `content_block.type = "redacted_thinking"`, `content_block.data = "..."` | **完整 data 就在这里**，没有后续 delta |
| `content_block_stop` | `index` | block 结束，直接取 start 时存的 data |

**关键**：`signature` 不是随 `thinking_delta` 一起来的，而是在最后一个单独的 `signature_delta` 事件里。很多自己写流式解析的代码只处理了 `thinking_delta` 而忘了 `signature_delta`，导致 signature 丢失。redacted_thinking 同理——只有一个 start 事件，没有 delta，很容易漏掉。

**正确的流式捕获逻辑**（伪代码）：

```javascript
// 按 block index 累积
const thinkingContent = new Map()  // index → 累积文字
const thinkingSignature = new Map()  // index → signature

// content_block_delta 处理
if (delta.type === 'thinking_delta') {
  thinkingContent.set(idx, (thinkingContent.get(idx) ?? '') + delta.thinking)
} else if (delta.type === 'signature_delta') {
  thinkingSignature.set(idx, delta.signature)
}

// content_block_stop 处理
if (blockTypes.get(idx) === 'thinking') {
  const complete = {
    thinking: thinkingContent.get(idx) ?? '',
    signature: thinkingSignature.get(idx) ?? '',
  }
  // 存起来留给下一轮 baseMessages 用
}
```

---

## 3. Prompt Caching：cache key 包含 thinking 参数

**实测（2026-06-17）**：`thinking: {type:'enabled', budget_tokens:2000}` vs 不带 thinking，两者的 cache key **完全不同**，差 22 个 token，形成**两条互不命中的缓存链**。

推论：Anthropic 把 thinking 参数（包括 `budget_tokens` 的具体值）计入 cache key。

**后果**：
- iter1 开了 thinking → 写了一条 65931 token 的缓存
- iter2 没开 thinking → cache key 变了，命中不了 iter1 的缓存，冷写 ~¥1.5
- iter1 thinking budget=2000，ping budget=1024 → 同样分裂成两条链

**结论**：同一会话的所有请求，`thinking` 参数必须**完全一致**（type + budget_tokens 都要一样）。

---

## 4. Prompt Caching：两个必要条件

1. **`cache_control: { type: 'ephemeral' }`** 挂在内容块上
2. **`metadata.user_id`（固定值）** — 中转的负载均衡会随机派到不同后端节点，`user_id` 让同一用户粘在同一节点，否则"只写不读、命中永远 0%"

缺任何一个都是静默失败（0% 命中，没有报错）。

---

## 5. Tool Use：assistant 消息 content 不能是空字符串

当模型只输出 tool_calls 没有文字时，assistant 消息的 `content` 必须是 **`null`**，不能是 `""`（空字符串）。

Anthropic 原生路径会 400 拒绝空字符串 content：`"text content blocks must contain non-empty text"`。

OpenAI spec 定义 `content: null` 是合法的，用 null 即可。

---

## 6. Tool Use：tool_result 的 tool_use_id 必须匹配

`tool_result` 里的 `tool_use_id` 必须和对应的 `tool_use` block 的 `id` 完全一致。

有些中转站/OpenRouter 路由的上游在流式传输的**第一个 chunk 里不带 id**（或永远不带），如果直接用 `""` 作为 tool_call_id 发下一轮请求，会导致 400。

处理方式：给 id 设一个备用默认值（如 `call_${index}`），一旦真实 id 到达就覆盖。

---

## 7. Extended Thinking 的 max_tokens 要求

`max_tokens` 必须**严格大于** `budget_tokens`，否则 400：

```
max_tokens must be greater than budget_tokens
```

工具迭代里如果为了省钱给 max_tokens 设很小的 cap（如 512），但 thinking budget 是 2000，就会 400。要么 cap 设成 `budget_tokens + N`，要么思考关掉。

另一个坑：有些中转/OR 在 `max_tokens < budget_tokens` 时不 400，而是**静默把 thinking 删掉**，导致 cache key 变成 thinking-OFF，又触发冷写。

---

## 8. 只有原生 /v1/messages 路径有缓存

OpenAI 兼容的 `/chat/completions` 不认 `cache_control`（中转一般直接丢掉这个字段）。

中转站要享受缓存，**格式必须选「Anthropic 兼容」**，走原生 `/v1/messages`。同时这也是 extended thinking 能不能出来的开关。

---

## 9. Keepalive ping 必须和聊天请求完全一致

Anthropic 缓存键 = 消息序列 + 模型参数（含 thinking）的完整 hash。

Ping 请求如果和聊天请求有任何不同（thinking 参数、budget_tokens、路由参数……），就命中不了聊天的缓存，会另开一条新缓存链白白冷写。

实测确认**不影响** cache key 的字段：`stream`（流 vs 非流不影响，非流 ping 能读流式聊天的缓存）。

---

## 10. Nimbus 的工具迭代冷写修复记录（2026-06）

按时间顺序，方便以后 debug 时回溯：

| 时间 | 修了什么 | 根因 |
|---|---|---|
| 2026-06-early | keepalive 存的是 `lastSentBody`（iter2 body，thinking-OFF）→ ping 命中不了 iter1 缓存 | 应存 `firstIterBody`（iter1 body） |
| 2026-06-mid | iter2+ 没有开 thinking → 22 token cache key 分裂 | 所有迭代统一设 `reasoning: {max_tokens: 2000}` |
| 2026-06-mid | 工具迭代 max_tokens cap=512，thinking budget=2000 → 中转静默删 thinking | cap 改为 `budget_tokens + 512` |
| 2026-06-18 | iter2 的 assistant 历史缺 thinking block + signature → Anthropic 认为不同序列、冷写 | 流里捕获 `signature_delta`，`content_block_stop` 时打包，`baseMessages.push` 带上，`convertOpenAiRequestToAnthropic` 转成 `{type:'thinking', thinking, signature}` 放 tool_use 之前 |
| 2026-06-19 | redacted_thinking block 完全漏掉（content_block_start 的 data 没捕获，content_block_stop 只判断 type==='thinking'）→ 触发时 400 或冷写 | content_block_start 捕获 data；content_block_stop 对 redacted_thinking 也发合成 chunk；App.tsx 和转换层同步处理 union 类型 |

经过上述五个修复，工具调用触发的冷写从 ~¥1.5/次 降到 ~¥0.01（缓存命中）。redacted_thinking 属于低频边缘情况，但不修是定时炸弹。

---

## 11. Prompt Caching：渲染顺序决定 cache key 结构

Anthropic 的渲染顺序固定为：**`tools → system → messages`**

这意味着：
- 改了 tools（工具定义）→ 整个 cache 全失效（tools 在最前面）
- 改了 system → messages 的 cache 失效，但不影响 tools 的 cache
- 改了 message content → 只影响该 breakpoint 之后的内容

实践意义：**不要在对话中途改工具定义或切换模型**，会让整条缓存链崩掉。

---

## 12. Prompt Caching：5分钟 vs 1小时 TTL 的成本差异

```json
{"type": "ephemeral"}           // 5分钟 TTL，写入成本 1.25×
{"type": "ephemeral", "ttl": "1h"}  // 1小时 TTL，写入成本 2×
```

| TTL | 写入成本 | 读取成本 | 回本所需请求数 |
|---|---|---|---|
| 5分钟 | 1.25× | 0.1× | 2次 |
| 1小时 | 2× | 0.1× | 3次 |

Nimbus 用的是 1小时 TTL（对话间隔一般超过 5 分钟），写入贵但更值。

---

## 13. Prompt Caching：各模型最小可缓存 token 数

低于这个阈值不会写缓存（静默跳过，没有报错）：

| 模型 | 最小 token 数 |
|---|---|
| Opus 4.8 / 4.7 / 4.6 / 4.5，Haiku 4.5 | **4096** |
| Fable 5，Sonnet 4.6，Haiku 3.5 / 3 | **2048** |
| Sonnet 4.5 / 4.1 / 4，Sonnet 3.7 | **1024** |

Nimbus 的前缀（人设 + 工具 schema）远超 4096，没问题。但如果有人想在短对话或简单 system prompt 上用缓存，要注意这个阈值。

---

## 14. Prompt Caching：20块回溯窗口

每个 `cache_control` breakpoint 最多向前查 **20 个 content block**，超过就查不到。

Nimbus 每轮工具调用只产生 1~2 个块，完全在窗口内。但如果一次性用很多工具、或者历史消息块数很多，可能踩到这个限制。

---

## 15. Prompt Caching：并发请求的陷阱

**同时发出的两个完全相同的请求，都会付全价。**

原因：cache entry 只有在第一个请求的响应**开始流式返回**之后才可被读取。两个并发请求都在对方的 cache 写好之前就发出去了，所以各自独立冷写。

---

## 16. Prompt Caching：Silent Invalidators（常见静默失效原因）

| 模式 | 问题 |
|---|---|
| system prompt 里插入 `Date.now()` / 时间戳 | 每次请求 prefix 都不同 |
| 早期内容里用随机 UUID | 每次请求都是新的 prefix |
| JSON 序列化没有固定 key 顺序 | 非确定性序列化，prefix 随机变 |
| 把 session/user ID 插值进 system | 每个用户都是独立 prefix，互不命中 |
| 按条件拼接 system 段落 | 每种 flag 组合都是不同 prefix |
| 工具定义按用户不同而变 | tools 在渲染顺序最前，影响一切 |

Nimbus 的时间戳是烙在每条 user 消息里（`message.meta`），不在 system prompt 里，所以没踩这个坑。

---

## 17. Prompt Caching：max_tokens=0 预热技巧

发一条 `max_tokens: 0` 的请求可以**只写缓存不付输出费**：

```python
client.messages.create(
    model="claude-opus-4-8",
    max_tokens=0,
    system=[{"type": "text", "text": SYSTEM_PROMPT,
             "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
    messages=[{"role": "user", "content": "warmup"}],
)
```

适合：用户打开 app 时预热、服务启动时预热大型 system prompt。
不适合：流量连续（缓存本来就热着）、prefix 很小、或 prefix 每次都变。

Nimbus 现在用 keepalive ping 续命，不用这个技巧，但以后如果想做「打开 app 立即预热」可以用。

---

## 18. 模型版本破坏性变更（重要！升级前必看）

来源：`skills/claude-api/shared/model-migration.md`

### temperature / top_p / top_k：Opus 4.7+ 直接 400

这三个参数在 **Opus 4.7 及以上版本**被完全移除，发了会直接 400，没有降级处理：

```
// 这三个在 4.7+ 必须删掉
delete requestBody.temperature
delete requestBody.top_p
delete requestBody.top_k
```

**Nimbus 现状**：thinking 开启时已经 `delete temperature / top_p`，但如果用户**关闭 thinking 同时使用 4.7+ 模型**，这两个参数还是会被发出去 → 400。需要按模型版本判断是否删除，而不是只在 thinking 开启时删。

### extended thinking：budget_tokens 格式在新模型已废弃

| 模型 | thinking 格式 |
|---|---|
| Opus 4.5 及以下 | `{type:'enabled', budget_tokens: N}` |
| Opus 4.6 / Sonnet 4.6 | 迁移期，推荐改用 adaptive |
| Opus 4.7+ | 只接受 `{type:'adaptive'}` + `output_config:{effort:'...'}`，发 budget_tokens 会 400 |
| **Fable 5** | **thinking 永远开着，不能发任何 thinking 配置**，发了会 400 |

### Fable 5：新分词器，token 数多约 30%

Fable 5 用了全新 tokenizer，同样的文字比之前的模型多 ~30% token。成本估算、阈值判断要重新校准。

### assistant prefill 在 Opus 4.6 / Sonnet 4.6 上不支持

发带 prefill 的 assistant 消息会返回 400。Nimbus 目前没用这个功能，暂时不影响。

---

## 19. 错误码速查

来源：`skills/claude-api/shared/error-codes.md`

| 状态码 | 类型 | 可重试 | 常见原因 |
|---|---|---|---|
| 400 | Invalid request | 否 | 参数格式错误、roles 没有交替、发了被移除的参数（temperature on 4.7+）|
| 401 | Authentication | 否 | API key 缺失或格式错误 |
| 403 | Permission | 否 | 权限不足 |
| 404 | Not found | 否 | 端点或模型 ID 错误 |
| 413 | Too large | 否 | 请求体超过大小限制 |
| 429 | Rate limited | **是** | 请求频率超限，看 `retry-after` header |
| 500 | Server error | **是** | 服务端问题 |
| 529 | Overloaded | **是** | 临时容量问题 |

400 的常见「roles 交替」报错：`messages: roles must alternate between "user" and "assistant"`——Nimbus 遇到过，是空 assistant 消息没被过滤掉导致的。

---

## 20. Token 计数：不要用 tiktoken

来源：`skills/claude-api/shared/token-counting.md`

`tiktoken` 等 OpenAI 工具会**低估 Claude 的 token 数 15–20%**，代码和非英文内容误差更大。

正确做法是调官方接口：`POST /v1/messages/count_tokens`。

Nimbus 目前用 OpenRouter 返回的 `usage` 字段来记账，那是实际计费数，没有这个问题。但如果以后想做「预估上下文大小」的功能，记得用官方接口而不是 tiktoken。

---

## 21. Agent 设计：对缓存友好的模式

来源：`skills/claude-api/shared/agent-design.md`

- **往 messages 里追加 system 块**（而不是修改 system prompt）可以保住已有的缓存前缀——这就是文档里提到的 `MidConversationSystemBlockParam`（需要 beta header）
- **tool search 模式**：按需加载工具 schema 而不是一次性全塞进去，避免 tools 变化导致缓存失效
- **programmatic tool calling**：让模型一次写好脚本批量调用工具，减少来回 round-trip，中间结果在沙盒里过滤后再进上下文

---

## 参考来源

- Anthropic Skills repo `skills/claude-api/shared/`：`prompt-caching.md`、`model-migration.md`、`models.md`、`error-codes.md`、`token-counting.md`、`agent-design.md`
- Anthropic Cookbook：`extended_thinking/extended_thinking_with_tool_use.ipynb`
- Anthropic Python SDK types：`SignatureDelta`、`ThinkingDelta`、`RedactedThinkingBlock`、`RedactedThinkingBlockParam`、`ThinkingBlockParam`、`RawContentBlockDelta`（union：TextDelta / InputJSONDelta / CitationsDelta / ThinkingDelta / SignatureDelta）
- Anthropic Python SDK streaming：`_messages.py` `accumulate_event()` — signature 是直接赋值（`content.signature = delta.signature`），不是累积
- Nimbus 实测日志（2026-06-17，对比流 65931 / 非流 65909 差 22 token）
- 本仓库 `docs/caching.md`（详细缓存配置）、`docs/changelog.md`（改动历史）
