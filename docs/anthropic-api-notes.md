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

一个 thinking block 在流里分三类事件到达：

| 事件 | 字段 | 说明 |
|---|---|---|
| `content_block_start` | `content_block.type = "thinking"` | 宣告这个 block 是 thinking |
| `content_block_delta` (多次) | `delta.type = "thinking_delta"`, `delta.thinking` | 逐块推理文字 |
| `content_block_delta` (一次) | `delta.type = "signature_delta"`, `delta.signature` | 签名，单独一个事件，在所有 `thinking_delta` 之后 |
| `content_block_stop` | `index` | block 结束 |

**关键**：`signature` 不是随 `thinking_delta` 一起来的，而是在最后一个单独的 `signature_delta` 事件里。很多自己写流式解析的代码只处理了 `thinking_delta` 而忘了 `signature_delta`，导致 signature 丢失。

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

经过上述四个修复，工具调用触发的冷写从 ~¥1.5/次 降到 ~¥0.01（缓存命中）。

---

## 参考来源

- Anthropic Cookbook：`extended_thinking/extended_thinking_with_tool_use.ipynb`
- Anthropic Python SDK types：`SignatureDelta`、`ThinkingDelta`、`ContentBlockStopEvent`
- Nimbus 实测日志（2026-06-17，对比流 65931 / 非流 65909 差 22 token）
- 本仓库 `docs/caching.md`（详细缓存配置）、`docs/changelog.md`（改动历史）
