// Adapter that lets the app talk to Anthropic's /v1/messages endpoint
// while keeping the existing OpenAI-shaped request/response code intact.
// Translates OpenAI request body → Anthropic body, then back-translates
// the Anthropic SSE stream → OpenAI-shaped SSE chunks on the fly.

import { nativeStreamFetchOrThrow, nativeStreamFetch, isNativeStreamAvailable } from '../native/streamHttp'

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content:
    | string
    | null
    | Array<{
        type: string
        text?: string
        image_url?: { url: string }
        cache_control?: { type: 'ephemeral'; ttl?: string }
      }>
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  // Anthropic thinking blocks from a prior assistant turn. Must be preserved
  // verbatim across multi-turn tool-use conversations. Two variants:
  //   thinking       → human-readable, has thinking+signature
  //   redacted_thinking → Anthropic-encrypted, only has data; must also be
  //                       sent back verbatim or the API 400s / cold-writes.
  thinking_blocks?: Array<
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
  >
}

type OpenAiTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

type OpenAiRequest = {
  model: string
  messages: OpenAiMessage[]
  tools?: OpenAiTool[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  reasoning?: { effort?: string } | Record<string, unknown>
  // OpenAI-style end-user identifier. We hand it through to Anthropic's
  // `metadata.user_id` for sticky-routing on the upstream side — same
  // backend node gets the same user's prefix, which is what makes prompt
  // cache reads actually land (writes and reads must hit the same node).
  user?: string
  tool_choice?: string | { type?: string; function?: { name?: string } }
  [key: string]: unknown
}

type CacheControl = { type: 'ephemeral'; ttl?: string }

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: CacheControl }

type AnthropicContentBlock =
  | AnthropicTextBlock
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: CacheControl }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: CacheControl }
  | { type: 'image'; source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string }; cache_control?: CacheControl }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicRequest = {
  model: string
  messages: AnthropicMessage[]
  // Anthropic accepts either a plain string or an array of text blocks.
  // Array form is needed when we want to attach cache_control to the
  // system prompt (BP1 — the foundational character + tool schema layer
  // that virtually never changes between turns).
  system?: string | AnthropicTextBlock[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: Array<{
    name: string
    description?: string
    input_schema: Record<string, unknown>
    cache_control?: CacheControl
  }>
  // Opus 4.6 and earlier accept manual extended thinking (budget_tokens).
  // Opus 4.7+ removed it and 400 on that shape — those use adaptive
  // thinking + the `effort` knob in output_config instead.
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' }
  output_config?: { effort: 'low' | 'medium' | 'high' }
  metadata?: { user_id?: string }
  // OpenRouter-specific routing hint, passed through on requests to OR's
  // /messages endpoint. Ignored by direct Anthropic and most relays.
  provider?: { order?: string[]; allow_fallbacks?: boolean; [k: string]: unknown }
}

const fetchImageAsBase64 = async (
  url: string,
): Promise<{ mediaType: string; data: string } | null> => {
  try {
    // CapacitorHttp patches window.fetch on Android for CORS bypass, but its
    // synthetic Response doesn't properly support arrayBuffer() on binary
    // payloads — the bytes come back garbled, producing an invalid base64
    // string that the API silently drops. nativeStreamFetch bypasses
    // CapacitorHttp entirely (raw OkHttp) and returns a real ReadableStream
    // whose arrayBuffer() works correctly.
    const resp = isNativeStreamAvailable()
      ? await nativeStreamFetch(url, { method: 'GET' })
      : await fetch(url)
    if (!resp.ok) return null
    const mediaType = (resp.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim()
    const buf = await resp.arrayBuffer()
    const bytes = new Uint8Array(buf)
    // Chunked btoa to avoid stack overflow on large images.
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return { mediaType, data: btoa(binary) }
  } catch {
    return null
  }
}

const flattenContent = async (
  content: OpenAiMessage['content'],
): Promise<string | AnthropicContentBlock[]> => {
  if (content === null) return ''
  if (typeof content === 'string') return content
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      // Skip empty text blocks — Anthropic 400s on
      // `{type: 'text', text: ''}` ("text content blocks must
      // contain non-empty text"). Whitespace-only is also rejected.
      if (part.text.trim().length === 0) continue
      const block: AnthropicTextBlock = { type: 'text', text: part.text }
      // Preserve cache_control if the caller attached one (App.tsx's
      // applyClaudeCaching marks the last two user messages this way).
      // Stripping it here was the bug that meant our msuicode requests
      // had to lean entirely on the relay's server-side auto-cache —
      // explicit markers should layer on top now.
      if (part.cache_control) {
        block.cache_control = part.cache_control
      }
      blocks.push(block)
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url
      if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/)
        if (match) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          })
          continue
        }
      }
      // For http(s) URLs: fetch + base64 instead of source.type='url'.
      // The 'url' source variant is a newer Anthropic feature that many
      // relay gateways don't accept yet — base64 is the universally
      // supported encoding.
      const fetched = await fetchImageAsBase64(url)
      if (fetched) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: fetched.mediaType, data: fetched.data },
        })
      } else {
        // Fall back to url source if fetch failed — at least surfaces an
        // upstream error instead of silently dropping the image.
        blocks.push({ type: 'image', source: { type: 'url', url } })
      }
    }
  }
  return blocks
}

export const convertOpenAiRequestToAnthropic = async (
  body: OpenAiRequest,
  options: { keepModelSlug?: boolean } = {},
): Promise<AnthropicRequest> => {
  // Pull system messages out. Each system message becomes one or more
  // Anthropic text blocks. We keep the array form (instead of joining
  // into a single string) so that any cache_control attached to a
  // specific block — BP1 marker on the foundational system prompt —
  // survives the conversion. Anthropic accepts either shape; the array
  // form is what's required for cache_control to actually take effect.
  const systemBlocks: AnthropicTextBlock[] = []
  const rest: OpenAiMessage[] = []
  for (const msg of body.messages) {
    if (msg.role !== 'system') {
      rest.push(msg)
      continue
    }
    if (typeof msg.content === 'string') {
      const trimmed = msg.content.trim()
      if (trimmed.length > 0) systemBlocks.push({ type: 'text', text: msg.content })
      continue
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'text' || typeof part.text !== 'string') continue
        if (part.text.trim().length === 0) continue
        const block: AnthropicTextBlock = { type: 'text', text: part.text }
        if (part.cache_control) block.cache_control = part.cache_control
        systemBlocks.push(block)
      }
    }
  }
  // If no block carries cache_control we can fold back to plain-string
  // form — it's marginally cheaper bytes on the wire and matches what
  // the relay used to expect before this change.
  const anySystemCacheControl = systemBlocks.some((b) => b.cache_control)
  const systemForRequest: AnthropicRequest['system'] | undefined =
    systemBlocks.length === 0
      ? undefined
      : anySystemCacheControl
        ? systemBlocks
        : systemBlocks.map((b) => b.text).join('\n\n')

  // Convert each message. OpenAI 'tool' role → Anthropic user message with
  // tool_result block. Assistant with tool_calls → assistant with tool_use blocks.
  const messages: AnthropicMessage[] = []
  for (const msg of rest) {
    if (msg.role === 'tool') {
      // Skip tool results without a tool_call_id — Anthropic 400s on
      // tool_result with empty tool_use_id ("tool_use_id is required").
      // This happens when an upstream provider emits a tool delta
      // without an id, or when history reconstruction loses the link.
      if (!msg.tool_call_id || msg.tool_call_id.length === 0) {
        continue
      }
      const last = messages[messages.length - 1]
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      }
      // Anthropic requires tool_result to be in a user message. Coalesce
      // consecutive tool results into one user message — but only when
      // the prior message is actually a user with array content; never
      // bolt a tool_result onto an assistant message.
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block)
      } else {
        messages.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = []
      // Anthropic requires thinking blocks to appear before text/tool_use and
      // be preserved verbatim to keep the cache key stable across multi-turn
      // tool-use conversations. Both thinking and redacted_thinking must be
      // included — omitting either causes a 400 or cold write.
      if (msg.thinking_blocks) {
        for (const tb of msg.thinking_blocks) {
          if (tb.type === 'thinking') {
            blocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature })
          } else if (tb.type === 'redacted_thinking') {
            blocks.push({ type: 'redacted_thinking', data: tb.data })
          }
        }
      }
      const text = typeof msg.content === 'string' ? msg.content : ''
      if (text.trim()) blocks.push({ type: 'text', text })
      for (const tc of msg.tool_calls) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}')
        } catch {
          parsedArgs = {}
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedArgs,
        })
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }
    // Plain assistant turn carrying replayed thinking blocks (cross-turn
    // thinking回传): thinking must be the FIRST content blocks, verbatim with
    // signature. Opus 4.5+/Sonnet 4.6+ keep prior-turn thinking in context so
    // the model sees its own past raw reasoning; older models strip it
    // server-side. Empty-text guard matches the fallthrough path below.
    if (msg.role === 'assistant' && msg.thinking_blocks && msg.thinking_blocks.length > 0) {
      const blocks: AnthropicContentBlock[] = []
      for (const tb of msg.thinking_blocks) {
        if (tb.type === 'thinking') {
          blocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature })
        } else if (tb.type === 'redacted_thinking') {
          blocks.push({ type: 'redacted_thinking', data: tb.data })
        }
      }
      const text = typeof msg.content === 'string' ? msg.content : ''
      if (text.trim()) blocks.push({ type: 'text', text })
      if (blocks.length > 0) {
        messages.push({ role: 'assistant', content: blocks })
      }
      continue
    }
    const flattened = await flattenContent(msg.content)
    // Anthropic rejects empty content (string '' OR empty array). This
    // happens with historical assistant messages from tool-only
    // iterations (no emitted text) and the rare empty user echo.
    // For assistants, drop the message — it's a no-op turn. For
    // users, swap in a single-character placeholder so the history
    // shape (alternating user/assistant) isn't broken by the drop.
    const isEmpty =
      (typeof flattened === 'string' && flattened.trim().length === 0) ||
      (Array.isArray(flattened) && flattened.length === 0)
    if (isEmpty) {
      if (msg.role === 'assistant') continue
      messages.push({ role: 'user', content: '(empty)' })
      continue
    }
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: flattened,
    })
  }

  // Anthropic requires the conversation to end on a user-role message
  // (or the message_start probe will 400). If the last reconstructed
  // message is assistant — usually because the most recent iteration
  // was assistant-only with no follow-up — drop it so the request body
  // is structurally valid.
  while (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
    messages.pop()
  }

  const tools: AnthropicRequest['tools'] = body.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }))

  // BP0: mark the LAST tool definition. Anthropic's cache invalidation is
  // three-tiered (tools → system → messages): editing the system prompt
  // (persona tweak, memory lock/unlock, new APK changing injected sections)
  // only invalidates the system+messages tiers — the tools tier survives,
  // BUT only if a breakpoint exists at the tools boundary to anchor a cache
  // entry there. Without this marker a persona edit re-writes the tool
  // schemas at 2x along with everything else; with it they read at 0.1x.
  // Uses the 4th breakpoint slot (BP1/BP4/HEAD use three; tool-iteration
  // requests use two). Only attached when the request is already cache-
  // marked, so non-cached bodies through this converter stay untouched.
  if (tools && tools.length > 0) {
    const requestHasCacheMarkers =
      systemBlocks.some((b) => b.cache_control) ||
      messages.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as Array<{ cache_control?: unknown }>).some((b) => b.cache_control),
      )
    if (requestHasCacheMarkers) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }
    }
  }

  // Translate OpenAI's tool_choice → Anthropic's. Without this the field
  // got silently dropped during conversion, so the finalizer (which sets
  // tool_choice='none' to force a text-only answer) had no way to stop
  // the model from calling tools — its workaround was to delete the
  // entire `tools` array, which broke prompt-cache match (tools array
  // is part of the cache key, so removing it forced a full ~$0.15 cold
  // write every MAX_TOOL_ITERATIONS hit). Keep tools, translate choice.
  let toolChoice: Record<string, unknown> | undefined
  const rawChoice = body.tool_choice
  if (typeof rawChoice === 'string') {
    if (rawChoice === 'none' || rawChoice === 'auto' || rawChoice === 'any') {
      toolChoice = { type: rawChoice }
    } else if (rawChoice === 'required') {
      toolChoice = { type: 'any' }
    }
  } else if (rawChoice && typeof rawChoice === 'object') {
    const choice = rawChoice as { type?: string; function?: { name?: string } }
    if (choice.type === 'function' && choice.function?.name) {
      toolChoice = { type: 'tool', name: choice.function.name }
    } else if (choice.type === 'none' || choice.type === 'auto' || choice.type === 'any') {
      toolChoice = { type: choice.type }
    }
  }

  // Thinking: if OpenAI request has reasoning.effort OR reasoning.max_tokens,
  // translate to Anthropic extended thinking with a token budget. Only
  // applies on models that actually support extended thinking (Claude 4
  // family + Claude 3.7) — older Claudes 400 when thinking is included in
  // the body.
  //
  // Two field shapes to handle:
  //   - `reasoning.effort: 'high'|'medium'|'low'`  (legacy / non-Claude)
  //   - `reasoning.max_tokens: <number>`           (Claude-on-OR fix from
  //                                                today — gives an explicit
  //                                                Anthropic thinking budget)
  // Without the max_tokens branch, the Claude path in App.tsx (which now
  // sends max_tokens:8000 with no effort) would silently miss thinking when
  // the request flows through this relay adapter — the symptom the user is
  // calling "msuicode 笨笨的".
  let thinking: AnthropicRequest['thinking']
  const reasoningCfg = body.reasoning as
    | { effort?: string; max_tokens?: number }
    | undefined
  const effort = reasoningCfg?.effort
  const explicitBudget = typeof reasoningCfg?.max_tokens === 'number' ? reasoningCfg.max_tokens : 0
  // Thinking is supported on Claude 4.x and Claude 3.7. Match both naming
  // conventions Anthropic uses across vendors:
  //   - "claude-opus-4" / "claude-sonnet-4-5" / "claude-haiku-4-5"
  //     (tier-then-version, used on direct Anthropic + most OR slugs)
  //   - "claude-4.6-opus" / "claude-4.7-sonnet"
  //     (version-then-tier, used in dated variants like
  //      "anthropic/claude-4.6-opus-20260205")
  //   - "claude-3-7-sonnet" / "claude-3.7-sonnet"
  // Older Claudes 400 when thinking is included so we still gate.
  const supportsThinking =
    /claude-(opus|sonnet|haiku)-(3-7|3\.7|4)/i.test(body.model) ||
    /claude-(3-7|3\.7|4)(?:[-.]\d+)?-(opus|sonnet|haiku)/i.test(body.model)

  // Parse the Claude major.minor (e.g. "4.7" → 407) from either naming
  // convention. Opus 4.7 and later REMOVED manual extended thinking
  // (budget_tokens) and the sampling params (temperature/top_p/top_k) —
  // sending either returns a 400. Those models use adaptive thinking with
  // the effort knob instead. Treat any Claude >= 4.7 as adaptive-only;
  // 4.6 and earlier keep the budget_tokens path that works today.
  const versionMatch =
    body.model.match(/claude-(?:opus|sonnet|haiku)-(\d+)[-.](\d+)/i) ||
    body.model.match(/claude-(\d+)[-.](\d+)[-.]?(?:opus|sonnet|haiku)/i)
  const claudeVersion = versionMatch
    ? Number(versionMatch[1]) * 100 + Number(versionMatch[2])
    : 0
  const adaptiveOnly = claudeVersion >= 407

  let effortLevel: 'low' | 'medium' | 'high' | undefined
  if (supportsThinking) {
    if (adaptiveOnly) {
      // budget_tokens is rejected; map the requested budget/effort onto
      // adaptive thinking's effort knob. A sizeable explicit budget reads
      // as "high"; otherwise honor the effort string if one was given.
      if (explicitBudget >= 1024) {
        thinking = { type: 'adaptive' }
        effortLevel = 'high'
      } else if (effort === 'high' || effort === 'medium' || effort === 'low') {
        thinking = { type: 'adaptive' }
        effortLevel = effort
      }
    } else if (explicitBudget >= 1024) {
      // Honor whatever the caller asked for, but clamp to Anthropic's
      // 1024 floor (smaller silently disables thinking server-side).
      thinking = { type: 'enabled', budget_tokens: explicitBudget }
    } else if (effort === 'high') {
      thinking = { type: 'enabled', budget_tokens: 8000 }
    } else if (effort === 'medium' || effort === 'low') {
      thinking = { type: 'enabled', budget_tokens: 2000 }
    }
  }

  // Anthropic's extended thinking imposes three hard constraints — any of
  // them trigger a 400. The user's default max_tokens is 1024 and most
  // request configs set temperature/top_p, so reasoning=on requests would
  // 400 every time without these fixes:
  //   1. max_tokens must be strictly greater than budget_tokens (we keep
  //      ≥1024 headroom for the actual reply on top of the budget).
  //   2. temperature must be exactly 1 or unset.
  //   3. top_p must be unset (or also exactly 1, easier to just drop).
  const userMaxTokens =
    typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 4096
  const finalMaxTokens =
    thinking && 'budget_tokens' in thinking
      ? Math.max(userMaxTokens, thinking.budget_tokens + 1024)
      : thinking // adaptive: no explicit budget, just give the reply headroom
        ? Math.max(userMaxTokens, 9216)
        : userMaxTokens
  // Sampling params must be dropped when thinking is on (any model) and
  // ALWAYS on Opus 4.7+ (they 400 there regardless of thinking).
  const dropSampling = thinking != null || adaptiveOnly
  const finalTemperature = dropSampling
    ? undefined
    : typeof body.temperature === 'number'
      ? body.temperature
      : undefined
  // Some upstreams (notably 金瓜瓜/风铃草) reject a request that carries
  // BOTH temperature and top_p ("cannot both be specified for this model").
  // Anthropic itself recommends using only one, so send just top_p when no
  // temperature is present — otherwise drop it and keep temperature.
  const finalTopP =
    dropSampling || finalTemperature !== undefined
      ? undefined
      : typeof body.top_p === 'number'
        ? body.top_p
        : undefined

  // Pass the OpenAI-style `user` field through as Anthropic's
  // metadata.user_id. Per Anthropic + the prompt-cache stickiness
  // analysis in the NyraSeithhh/cache repo, this is the field that
  // pins a user's requests to the same upstream backend node — which
  // is what makes a previous turn's cache write actually be readable
  // on the next turn. Without it, even byte-identical prefixes can
  // miss because the read landed on a different node.
  const metadata = typeof body.user === 'string' && body.user.length > 0
    ? { user_id: body.user }
    : undefined

  // Pass through OpenRouter's provider routing hint when present (it's
  // ignored by direct Anthropic and benign on relays that don't know
  // about it). This is how we keep "use Anthropic upstream, no Bedrock
  // / Vertex fallback" pinning when sending Claude requests through
  // OR's /messages endpoint.
  const providerHint = (body as { provider?: unknown }).provider
  const provider =
    providerHint && typeof providerHint === 'object'
      ? (providerHint as AnthropicRequest['provider'])
      : undefined

  return {
    // For direct Anthropic + Anthropic-compat relays (msuicode etc.) we
    // strip the `anthropic/` provider prefix because they expect the
    // bare Anthropic model name. For OpenRouter's /messages endpoint,
    // the full OR slug (`anthropic/claude-opus-4.6`) is what's required —
    // OR uses the prefix to disambiguate which upstream provider to
    // route to. `keepModelSlug` flips that behavior.
    model: options.keepModelSlug ? body.model : body.model.replace(/^anthropic\//, ''),
    messages,
    system: systemForRequest,
    max_tokens: finalMaxTokens,
    temperature: finalTemperature,
    top_p: finalTopP,
    stream: body.stream ?? false,
    tools,
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(metadata ? { metadata } : {}),
    ...(provider ? { provider } : {}),
    ...(effortLevel ? { output_config: { effort: effortLevel } } : {}),
    thinking,
  }
}

// Translate Anthropic SSE stream → OpenAI-shaped SSE chunks.
// Returns a new ReadableStream of bytes that emits "data: {...}\n\n" lines.
const buildOpenAiChunk = (delta: Record<string, unknown>): string => {
  const chunk = {
    choices: [{ index: 0, delta }],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export const translateAnthropicStream = (anthropicResponse: Response): Response => {
  if (!anthropicResponse.body) {
    return new Response('', { status: anthropicResponse.status, headers: anthropicResponse.headers })
  }

  const reader = anthropicResponse.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()

  // Track state across events.
  const blockTypes = new Map<number, string>()  // index → "text" | "thinking" | "tool_use"
  const toolUseMeta = new Map<number, { id: string; name: string }>()
  const toolUseOrder = new Map<number, number>()  // anthropic block index → OpenAI tool_call index
  let toolUseCounter = 0
  // Accumulate thinking block content + signature so we can emit a single
  // synthetic thinking_block chunk when the block closes. The signature
  // arrives in a separate signature_delta event after all thinking_delta events.
  const thinkingContent = new Map<number, string>()
  const thinkingSignature = new Map<number, string>()
  // redacted_thinking blocks arrive fully formed in content_block_start (no
  // deltas); store the data field here so content_block_stop can emit it.
  const redactedThinkingData = new Map<number, string>()
  let buffer = ''
  // Usage accumulators — Anthropic splits input_tokens / cache_read /
  // cache_creation across message_start, then final output_tokens in
  // message_delta. Sum them on message_stop and emit one OpenAI-shaped
  // usage chunk so the chat UI's recordUsage path sees the data.
  //
  // OR's /messages "Anthropic Skin" is mostly Anthropic-compat but
  // empirically doesn't always populate usage on message_start —
  // we've seen requests where input_tokens lands on message_delta or
  // message_stop instead. Be defensive: try to harvest usage from
  // every event that might carry it and take the max (input/cache
  // numbers stay constant per request, output_tokens grow monotonically
  // across message_delta events).
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let outputTokens = 0

  type AnthropicUsage = {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  const absorbUsage = (u: AnthropicUsage | null | undefined) => {
    if (!u) return
    if (typeof u.input_tokens === 'number') {
      inputTokens = Math.max(inputTokens, u.input_tokens)
    }
    if (typeof u.cache_read_input_tokens === 'number') {
      cacheReadTokens = Math.max(cacheReadTokens, u.cache_read_input_tokens)
    }
    if (typeof u.cache_creation_input_tokens === 'number') {
      cacheCreationTokens = Math.max(cacheCreationTokens, u.cache_creation_input_tokens)
    }
    if (typeof u.output_tokens === 'number') {
      outputTokens = Math.max(outputTokens, u.output_tokens)
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let streamDone = false
        while (!streamDone) {
          const { done, value } = await reader.read()
          let events: string[]
          if (done) {
            streamDone = true
            // Flush any trailing event left in the buffer when the stream
            // ends without a final blank-line separator (some relays omit
            // it) — otherwise the last content delta / message_stop / usage
            // envelope would be silently dropped.
            if (!buffer.trim()) break
            events = [buffer]
            buffer = ''
          } else {
            buffer += decoder.decode(value, { stream: true })
            // SSE events are separated by blank lines.
            events = buffer.split('\n\n')
            buffer = events.pop() ?? ''
          }

          for (const rawEvent of events) {
            const lines = rawEvent.split('\n')
            let dataLine = ''
            for (const line of lines) {
              if (line.startsWith('data:')) dataLine += line.slice(5).trim()
            }
            if (!dataLine) continue

            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(dataLine)
            } catch {
              continue
            }

            const eventType = parsed.type as string

            if (eventType === 'message_start') {
              const msg = parsed.message as { usage?: AnthropicUsage } | undefined
              absorbUsage(msg?.usage)
              // Some gateways (OR's Anthropic Skin among them) also
              // surface usage at the top level of message_start.
              absorbUsage(parsed.usage as AnthropicUsage | undefined)
              continue
            }

            if (eventType === 'content_block_start') {
              const idx = parsed.index as number
              const block = parsed.content_block as { type: string; id?: string; name?: string; data?: string }
              blockTypes.set(idx, block.type)
              if (block.type === 'redacted_thinking' && block.data) {
                // redacted_thinking blocks carry their full encrypted payload
                // in the start event itself — there are no delta events for them.
                redactedThinkingData.set(idx, block.data)
              } else if (block.type === 'tool_use') {
                const orderIdx = toolUseCounter++
                toolUseOrder.set(idx, orderIdx)
                toolUseMeta.set(idx, { id: block.id ?? '', name: block.name ?? '' })
                controller.enqueue(
                  encoder.encode(
                    buildOpenAiChunk({
                      tool_calls: [
                        {
                          index: orderIdx,
                          id: block.id ?? '',
                          type: 'function',
                          function: { name: block.name ?? '', arguments: '' },
                        },
                      ],
                    }),
                  ),
                )
              }
            } else if (eventType === 'content_block_delta') {
              const idx = parsed.index as number
              const delta = parsed.delta as { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
              if (delta.type === 'text_delta' && delta.text) {
                controller.enqueue(encoder.encode(buildOpenAiChunk({ content: delta.text })))
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                // Accumulate for the thinking_block synthetic chunk emitted on content_block_stop.
                thinkingContent.set(idx, (thinkingContent.get(idx) ?? '') + delta.thinking)
                controller.enqueue(
                  encoder.encode(
                    buildOpenAiChunk({ reasoning: delta.thinking, reasoning_text: delta.thinking }),
                  ),
                )
              } else if (delta.type === 'signature_delta' && delta.signature) {
                thinkingSignature.set(idx, delta.signature)
              } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
                const orderIdx = toolUseOrder.get(idx) ?? 0
                controller.enqueue(
                  encoder.encode(
                    buildOpenAiChunk({
                      tool_calls: [
                        {
                          index: orderIdx,
                          function: { arguments: delta.partial_json },
                        },
                      ],
                    }),
                  ),
                )
              }
            } else if (eventType === 'content_block_stop') {
              const idx = parsed.index as number
              const bType = blockTypes.get(idx)
              if (bType === 'thinking') {
                // Emit the complete thinking block (content + signature) as a
                // single synthetic chunk so App.tsx can stash it verbatim for
                // the next request's assistant-history message.
                const thinking = thinkingContent.get(idx) ?? ''
                const signature = thinkingSignature.get(idx) ?? ''
                controller.enqueue(
                  encoder.encode(
                    buildOpenAiChunk({ thinking_block: { type: 'thinking', thinking, signature } }),
                  ),
                )
              } else if (bType === 'redacted_thinking') {
                // Redacted blocks must also be sent back verbatim or Anthropic
                // will 400 / cold-write a new cache entry.
                const data = redactedThinkingData.get(idx) ?? ''
                controller.enqueue(
                  encoder.encode(
                    buildOpenAiChunk({ thinking_block: { type: 'redacted_thinking', data } }),
                  ),
                )
              }
            } else if (eventType === 'message_delta') {
              const delta = parsed.delta as { stop_reason?: string }
              absorbUsage(parsed.usage as AnthropicUsage | undefined)
              if (delta.stop_reason) {
                const finishReason =
                  delta.stop_reason === 'tool_use' ? 'tool_calls'
                  : delta.stop_reason === 'end_turn' ? 'stop'
                  : delta.stop_reason === 'max_tokens' ? 'length'
                  : 'stop'
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`,
                  ),
                )
              }
            } else if (eventType === 'message_stop') {
              // Some gateways append a final usage envelope on
              // message_stop; harvest it if present.
              absorbUsage(parsed.usage as AnthropicUsage | undefined)
              const msgStop = parsed.message as { usage?: AnthropicUsage } | undefined
              absorbUsage(msgStop?.usage)
              // Emit a final usage chunk before [DONE] so the OpenAI-shaped
              // parser (see App.tsx flushUsageRecord) picks it up. Total
              // prompt = fresh input + cache write + cache hit.
              const promptTotal = inputTokens + cacheReadTokens + cacheCreationTokens
              const usagePayload = {
                choices: [] as unknown[],
                usage: {
                  prompt_tokens: promptTotal,
                  completion_tokens: outputTokens,
                  total_tokens: promptTotal + outputTokens,
                  prompt_tokens_details: { cached_tokens: cacheReadTokens },
                  cache_creation_input_tokens: cacheCreationTokens,
                  cache_read_input_tokens: cacheReadTokens,
                },
              }
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(usagePayload)}\n\n`),
              )
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            }
          }
        }
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })

  // Force SSE content-type so the existing parser is happy.
  const headers = new Headers(anthropicResponse.headers)
  headers.set('Content-Type', 'text/event-stream')
  return new Response(stream, { status: anthropicResponse.status, headers })
}

// Wraps an Anthropic /v1/messages call. Upstream is *always* invoked
// with stream:true (some relay gateways 502 on non-streaming, see
// 98982fe). What we return back depends on what the caller asked for:
//
// - body.stream === true  → an OpenAI-shaped SSE Response (chat)
// - body.stream === false → an OpenAI-shaped JSON Response built by
//   consuming the upstream stream end-to-end internally (friend-feed
//   generator and other one-shot generators that do response.json()).
//
// Options control upstream protocol quirks instead of having the
// adapter sniff the URL — callers know which provider they're talking
// to via the ProviderConfig and pass the right shape explicitly.
//   - authStyle: 'bearer'    → Authorization: Bearer <key>  (OR's gateway)
//                'x-api-key' → x-api-key: <key>             (direct Anthropic + msuicode relays)
//   - keepModelSlug: true    → leave `anthropic/claude-…` slug as-is (OR routes by slug)
//                    false   → strip `anthropic/` (Anthropic-direct rejects the prefix)
type AnthropicCallOptions = {
  signal?: AbortSignal
  authStyle?: 'bearer' | 'x-api-key'
  keepModelSlug?: boolean
}

// Per-relay-host opt-out for the extended-cache-ttl beta header. Some relay
// upstreams (camel's AWS Bedrock nodes: "ValidationException: invalid beta
// flag") hard-400 on beta flags they don't recognize, while other relays NEED
// the header or they silently downgrade 1h cache TTL to 5min. So: send it by
// default, and on a 400 that mentions "beta" retry once without it and
// remember the host — subsequent requests skip the header immediately.
const CACHE_BETA_OPTOUT_KEY = 'nimbus_cache_beta_optout_v1'
// Same idea for the body-level cache_control ttl:'1h': if a relay's upstream
// rejects the ttl field itself, we drop to the default 5-minute marker for
// that host instead of hard-failing (worse cache, but the chat works).
const CACHE_TTL_OPTOUT_KEY = 'nimbus_cache_ttl_optout_v1'
const readHostOptOuts = (key: string): Record<string, boolean> => {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}
const rememberHostOptOut = (key: string, host: string) => {
  if (typeof window === 'undefined') return
  try {
    const map = readHostOptOuts(key)
    map[host] = true
    window.localStorage.setItem(key, JSON.stringify(map))
  } catch {
    // ignore quota errors
  }
}
const hostOfEndpoint = (endpoint: string): string => {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

// Hosts where replayed thinking blocks proved toxic ("Invalid signature in
// thinking block"). Signatures are only verifiable by the backend family that
// produced them; App.tsx already gates replay on the block's origin host, but
// a heterogeneous relay pool (camel mixes Bedrock and other upstreams) can
// still reject its own relay's blocks when a request lands on a different
// node family. Once a host rejects a signature we stop replaying HISTORICAL
// thinking to it entirely — in-flight tool-loop blocks are untouched (the API
// requires those, and their signatures are seconds old).
const THINKING_REPLAY_OPTOUT_KEY = 'nimbus_thinking_replay_optout_v1'

// Remove REPLAYED (historical) thinking blocks: thinking/redacted_thinking in
// assistant messages that carry no tool_use sibling. Tool-loop messages keep
// theirs — stripping those would 400 differently (thinking must precede
// tool_use when thinking is on).
const stripReplayedThinking = (body: AnthropicRequest): AnthropicRequest => {
  const clone = JSON.parse(JSON.stringify(body)) as AnthropicRequest
  for (const m of clone.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const blocks = m.content as AnthropicContentBlock[]
    if (blocks.some((b) => b.type === 'tool_use')) continue
    const kept = blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
    if (kept.length > 0 && kept.length !== blocks.length) m.content = kept
  }
  return clone
}

// Deep-clone the request with every cache_control's ttl removed (markers stay,
// so caching still works at the upstream's default 5m TTL).
const stripCacheTtl = (body: AnthropicRequest): AnthropicRequest => {
  const clone = JSON.parse(JSON.stringify(body)) as AnthropicRequest
  const strip = (b: { cache_control?: { type: string; ttl?: string } } | undefined) => {
    if (b?.cache_control?.ttl) delete b.cache_control.ttl
  }
  if (Array.isArray(clone.system)) clone.system.forEach(strip)
  clone.tools?.forEach(strip)
  for (const m of clone.messages) {
    if (Array.isArray(m.content)) {
      ;(m.content as Array<{ cache_control?: { type: string; ttl?: string } }>).forEach(strip)
    }
  }
  return clone
}

export const fetchAnthropicAsOpenAi = async (
  baseUrl: string,
  apiKey: string,
  body: OpenAiRequest,
  optionsOrSignal?: AnthropicCallOptions | AbortSignal,
): Promise<Response> => {
  // Backwards-compat: previously this fn took (baseUrl, apiKey, body, signal).
  // Detect a raw AbortSignal and wrap it.
  const options: AnthropicCallOptions =
    optionsOrSignal && 'aborted' in optionsOrSignal
      ? { signal: optionsOrSignal }
      : ((optionsOrSignal as AnthropicCallOptions) ?? {})
  const { signal } = options
  const authStyle = options.authStyle ?? 'x-api-key'
  const keepModelSlug = options.keepModelSlug ?? false
  const wantsStream = body.stream === true
  const anthropicBody = await convertOpenAiRequestToAnthropic(
    { ...body, stream: true },
    { keepModelSlug },
  )
  const endpoint = baseUrl.replace(/\/+$/, '') + '/messages'
  // Build headers per destination protocol. Two shapes:
  //   - bearer style: just Authorization + Content-Type. OR's /messages
  //     gateway allowlists only those on its CORS preflight — including
  //     Anthropic-specific headers (anthropic-version, x-api-key,
  //     anthropic-dangerous-direct-browser-access) trips the browser
  //     preflight and the fetch resolves to "Failed to fetch" before
  //     any upstream call.
  //   - x-api-key style: full Anthropic-direct header set
  //     (anthropic-version + dangerous-direct-browser-access). Required
  //     by direct Anthropic; msuicode and similar relays accept it and
  //     route through.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (authStyle === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
    // Opt in to the 1-hour extended cache TTL. On first-party Anthropic this is
    // GA (the body's cache_control.ttl:'1h' is enough), but relays that proxy to
    // an older upstream still gate 1h behind this beta header — without it they
    // silently downgrade our ttl:'1h' to the default 5-minute cache, so a >5min
    // gap cold-writes and the 55-min keepalive ping guards a cache that's
    // already dead. Only sent on the native (x-api-key) relay path — NOT the
    // OpenRouter bearer path, whose CORS preflight rejects extra anthropic-*
    // headers. NOT harmless everywhere: relays whose upstream is AWS Bedrock
    // (camel) 400 with "ValidationException: invalid beta flag" — those hosts
    // get remembered in the opt-out map below and skip the header.
    if (!readHostOptOuts(CACHE_BETA_OPTOUT_KEY)[hostOfEndpoint(endpoint)]) {
      headers['anthropic-beta'] = 'extended-cache-ttl-2025-04-11'
    }
  }
  const relayHost = hostOfEndpoint(endpoint)
  let effectiveBody = anthropicBody
  if (readHostOptOuts(CACHE_TTL_OPTOUT_KEY)[relayHost]) {
    effectiveBody = stripCacheTtl(effectiveBody)
  }
  if (readHostOptOuts(THINKING_REPLAY_OPTOUT_KEY)[relayHost]) {
    effectiveBody = stripReplayedThinking(effectiveBody)
  }
  let bodyJson = JSON.stringify(effectiveBody)

  const sendOnce = async (hdrs: Record<string, string>): Promise<Response> => {
    // On native, a streaming chat tries the StreamHttp plugin first: CapacitorHttp
    // (kept on for CORS bypass) buffers window.fetch, so plain fetch here arrives
    // as one lump. The plugin bypasses CORS AND streams. But it's unproven on real
    // devices, so nativeStreamFetchOrThrow only commits to it once the first byte
    // is confirmed — if it stalls, we fall through to the buffered fetch below
    // (works, just not live). The chat can never hang on a broken native path.
    if (wantsStream && isNativeStreamAvailable()) {
      try {
        const upstream = await nativeStreamFetchOrThrow(endpoint, {
          method: 'POST',
          headers: hdrs,
          body: bodyJson,
          signal,
        })
        if (!upstream.ok) return upstream
        return translateAnthropicStream(upstream)
      } catch {
        // Native streaming stalled/failed. cancelStream is an async Capacitor
        // call — give it ~500 ms to reach Java and close the TCP connection
        // before we retry on the buffered path. Without this the relay sees two
        // concurrent connections and can 429/concurrency-limit the second one.
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: hdrs,
      body: bodyJson,
      signal,
    })
    if (!upstream.ok) {
      return upstream
    }
    if (wantsStream) {
      return translateAnthropicStream(upstream)
    }
    return collectAnthropicStreamAsJson(upstream)
  }

  let response = await sendOnce(headers)

  // Beta-flag fallback: a 400 mentioning "beta" while we sent the extended-TTL
  // header means this relay's upstream rejects unknown beta flags (camel's AWS
  // Bedrock nodes: "ValidationException: invalid beta flag"). Drop the header,
  // remember the host, retry once. Failed 400s are unbilled, so the extra
  // round-trip costs nothing; every later request skips straight to the
  // header-less shape.
  // camel is a multi-node pool and different upstream nodes phrase the
  // rejection differently ("invalid beta flag" from Bedrock, "The provided
  // Content…" elsewhere), so don't gate the retry on error text: ANY 400
  // while the header was sent gets one header-less retry. The opt-out is
  // only remembered when that retry succeeds (or the error explicitly
  // blamed the beta flag) — unrelated 400s just fail twice, unbilled.
  if (response.status === 400 && headers['anthropic-beta']) {
    let errText = ''
    try {
      errText = await response.clone().text()
    } catch {
      // body unreadable — retry anyway
    }
    const blamedBeta = /beta/i.test(errText)
    delete headers['anthropic-beta']
    const retried = await sendOnce(headers)
    if (retried.ok || blamedBeta) {
      console.warn('中转拒绝 extended-cache-ttl beta header,已按渠道停发', relayHost)
      rememberHostOptOut(CACHE_BETA_OPTOUT_KEY, relayHost)
    }
    response = retried
  }

  // ttl fallback: still 400 and the error mentions ttl/cache_control → this
  // upstream rejects the body-level 1h TTL field. Strip ttl (markers stay at
  // the default 5m), remember the host, retry once.
  if (response.status === 400) {
    let errText = ''
    try {
      errText = await response.clone().text()
    } catch {
      // body unreadable — give up, return the 400 as-is
    }
    if (/ttl|cache_control/i.test(errText)) {
      console.warn('中转拒绝 cache_control ttl:1h,已按渠道降级 5m 并重试', relayHost)
      rememberHostOptOut(CACHE_TTL_OPTOUT_KEY, relayHost)
      effectiveBody = stripCacheTtl(effectiveBody)
      bodyJson = JSON.stringify(effectiveBody)
      response = await sendOnce(headers)
    }
  }

  // Thinking-signature fallback: this upstream can't verify the signatures on
  // replayed thinking blocks ("Invalid signature in thinking block"). Strip
  // the historical blocks, remember the host, retry once.
  if (response.status === 400) {
    let errText = ''
    try {
      errText = await response.clone().text()
    } catch {
      // body unreadable — give up, return the 400 as-is
    }
    if (/signature/i.test(errText)) {
      console.warn('中转拒绝历史 thinking 签名,已按渠道停用思考链回传并重试', relayHost)
      rememberHostOptOut(THINKING_REPLAY_OPTOUT_KEY, relayHost)
      effectiveBody = stripReplayedThinking(effectiveBody)
      bodyJson = JSON.stringify(effectiveBody)
      response = await sendOnce(headers)
    }
  }
  return response
}

// Carry a SAFE allowlist of upstream headers onto our synthesized JSON
// response so callers (e.g. the API-check panel's 渠道指纹) can read who the
// upstream really is. Deliberately skips body-framing headers
// (content-length/encoding, transfer-encoding) — our body is a fresh,
// uncompressed JSON string, so copying those would corrupt parsing.
const FINGERPRINT_HEADER_RE = /^(anthropic-|x-amzn|openai-|cf-ray|cf-cache|via$|server$|request-id$|x-request-id$|x-ratelimit|x-powered-by|x-served-by)/i
const buildJsonHeaders = (upstream: Response): HeadersInit => {
  const out: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    upstream.headers.forEach((v, k) => {
      if (FINGERPRINT_HEADER_RE.test(k)) out[k] = v
    })
  } catch { /* some platforms restrict header iteration */ }
  return out
}

// Drains an Anthropic raw SSE stream end-to-end and returns a single
// OpenAI-shaped JSON Response. Mirrors the same event handling as
// translateAnthropicStream but accumulates instead of emitting.
const collectAnthropicStreamAsJson = async (anthropicResponse: Response): Promise<Response> => {
  if (!anthropicResponse.body) {
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }), {
      status: anthropicResponse.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const reader = anthropicResponse.body.getReader()
  const decoder = new TextDecoder('utf-8')

  let id = ''
  let model = ''
  let text = ''
  let reasoning = ''
  type Acc = { id: string; name: string; argsJson: string }
  const toolUseByIdx = new Map<number, Acc>()
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let outputTokens = 0
  let stopReason = ''
  let buffer = ''

  // Max-merge usage from whichever events carry it. Different gateways put it
  // on message_start (nested or top-level), message_delta, or message_stop —
  // mirror the streaming path so non-streaming calls (finalizer, friend-feed
  // generators) don't record 0 usage on gateways that defer it.
  type AnthropicUsage = {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  const absorbUsage = (u: AnthropicUsage | null | undefined) => {
    if (!u) return
    if (typeof u.input_tokens === 'number') inputTokens = Math.max(inputTokens, u.input_tokens)
    if (typeof u.cache_read_input_tokens === 'number')
      cacheReadTokens = Math.max(cacheReadTokens, u.cache_read_input_tokens)
    if (typeof u.cache_creation_input_tokens === 'number')
      cacheCreationTokens = Math.max(cacheCreationTokens, u.cache_creation_input_tokens)
    if (typeof u.output_tokens === 'number') outputTokens = Math.max(outputTokens, u.output_tokens)
  }

  let streamDone = false
  while (!streamDone) {
    const { done, value } = await reader.read()
    let events: string[]
    if (done) {
      streamDone = true
      // Flush trailing event when the stream ends without a final blank line.
      if (!buffer.trim()) break
      events = [buffer]
      buffer = ''
    } else {
      buffer += decoder.decode(value, { stream: true })
      events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
    }
    for (const rawEvent of events) {
      let dataLine = ''
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) dataLine += line.slice(5).trim()
      }
      if (!dataLine) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(dataLine)
      } catch {
        continue
      }
      const eventType = parsed.type as string
      if (eventType === 'message_start') {
        const msg = parsed.message as { id?: string; model?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } } | undefined
        if (msg?.id) id = msg.id
        if (msg?.model) model = msg.model
        absorbUsage(msg?.usage)
        absorbUsage(parsed.usage as AnthropicUsage | undefined)
      } else if (eventType === 'content_block_start') {
        const idx = parsed.index as number
        const block = parsed.content_block as { type: string; id?: string; name?: string }
        if (block.type === 'tool_use') {
          toolUseByIdx.set(idx, { id: block.id ?? '', name: block.name ?? '', argsJson: '' })
        }
      } else if (eventType === 'content_block_delta') {
        const idx = parsed.index as number
        const delta = parsed.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
        if (delta.type === 'text_delta' && delta.text) {
          text += delta.text
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          reasoning += delta.thinking
        } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const acc = toolUseByIdx.get(idx)
          if (acc) acc.argsJson += delta.partial_json
        }
      } else if (eventType === 'message_delta') {
        const delta = parsed.delta as { stop_reason?: string }
        if (delta.stop_reason) stopReason = delta.stop_reason
        absorbUsage(parsed.usage as AnthropicUsage | undefined)
      } else if (eventType === 'message_stop') {
        absorbUsage(parsed.usage as AnthropicUsage | undefined)
        const msgStop = parsed.message as { usage?: AnthropicUsage } | undefined
        absorbUsage(msgStop?.usage)
      }
    }
  }

  const toolCalls = [...toolUseByIdx.values()].map((acc) => ({
    id: acc.id,
    type: 'function' as const,
    function: { name: acc.name, arguments: acc.argsJson || '{}' },
  }))
  const finishReason =
    stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'end_turn' ? 'stop'
    : stopReason === 'max_tokens' ? 'length'
    : 'stop'
  const promptTotal = inputTokens + cacheReadTokens + cacheCreationTokens
  const openAiPayload = {
    id,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTotal,
      completion_tokens: outputTokens,
      total_tokens: promptTotal + outputTokens,
      prompt_tokens_details: { cached_tokens: cacheReadTokens },
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens,
    },
  }
  return new Response(JSON.stringify(openAiPayload), {
    status: anthropicResponse.status,
    headers: buildJsonHeaders(anthropicResponse),
  })
}
