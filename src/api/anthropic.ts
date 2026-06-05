// Adapter that lets the app talk to Anthropic's /v1/messages endpoint
// while keeping the existing OpenAI-shaped request/response code intact.
// Translates OpenAI request body → Anthropic body, then back-translates
// the Anthropic SSE stream → OpenAI-shaped SSE chunks on the fly.

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content:
    | string
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
  thinking?: { type: 'enabled'; budget_tokens: number }
  metadata?: { user_id?: string }
  // OpenRouter-specific routing hint, passed through on requests to OR's
  // /messages endpoint. Ignored by direct Anthropic and most relays.
  provider?: { order?: string[]; allow_fallbacks?: boolean; [k: string]: unknown }
}

const fetchImageAsBase64 = async (
  url: string,
): Promise<{ mediaType: string; data: string } | null> => {
  try {
    const resp = await fetch(url)
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

  const tools = body.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }))

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
  if (supportsThinking) {
    if (explicitBudget >= 1024) {
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
  const finalMaxTokens = thinking
    ? Math.max(userMaxTokens, thinking.budget_tokens + 1024)
    : userMaxTokens
  const finalTemperature = thinking
    ? undefined
    : typeof body.temperature === 'number'
      ? body.temperature
      : undefined
  const finalTopP = thinking
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
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // SSE events are separated by blank lines.
          const events = buffer.split('\n\n')
          buffer = events.pop() ?? ''

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
              const block = parsed.content_block as { type: string; id?: string; name?: string }
              blockTypes.set(idx, block.type)
              if (block.type === 'tool_use') {
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
              const delta = parsed.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
              if (delta.type === 'text_delta' && delta.text) {
                controller.enqueue(encoder.encode(buildOpenAiChunk({ content: delta.text })))
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                controller.enqueue(
                  encoder.encode(
                    buildOpenAiChunk({ reasoning: delta.thinking, reasoning_text: delta.thinking }),
                  ),
                )
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
  }
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
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

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
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
        const u = msg?.usage
        if (u) {
          inputTokens = Number(u.input_tokens ?? 0)
          cacheReadTokens = Number(u.cache_read_input_tokens ?? 0)
          cacheCreationTokens = Number(u.cache_creation_input_tokens ?? 0)
          outputTokens = Number(u.output_tokens ?? 0)
        }
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
        const u = parsed.usage as { output_tokens?: number } | undefined
        if (u?.output_tokens != null) outputTokens = Number(u.output_tokens)
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
    headers: { 'Content-Type': 'application/json' },
  })
}
