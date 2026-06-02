// Adapter that lets the app talk to Anthropic's /v1/messages endpoint
// while keeping the existing OpenAI-shaped request/response code intact.
// Translates OpenAI request body → Anthropic body, then back-translates
// the Anthropic SSE stream → OpenAI-shaped SSE chunks on the fly.

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
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
  [key: string]: unknown
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string } }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicRequest = {
  model: string
  messages: AnthropicMessage[]
  system?: string
  max_tokens: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
  thinking?: { type: 'enabled'; budget_tokens: number }
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
      blocks.push({ type: 'text', text: part.text })
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
): Promise<AnthropicRequest> => {
  // Pull system messages out; concat into top-level system string.
  const systemParts: string[] = []
  const rest: OpenAiMessage[] = []
  for (const msg of body.messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : '')
    } else {
      rest.push(msg)
    }
  }

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

  // Thinking: if OpenAI request has reasoning.effort, translate to Anthropic
  // extended thinking with a token budget. Only applies on models that
  // actually support extended thinking (Claude 4 family + Claude 3.7) —
  // older Claudes 400 when thinking is included in the body.
  let thinking: AnthropicRequest['thinking']
  const effort = (body.reasoning as { effort?: string } | undefined)?.effort
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
    if (effort === 'high') {
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

  return {
    model: body.model.replace(/^anthropic\//, ''),
    messages,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    max_tokens: finalMaxTokens,
    temperature: finalTemperature,
    top_p: finalTopP,
    stream: body.stream ?? false,
    tools,
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
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let outputTokens = 0

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
              const msg = parsed.message as
                | { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
                | undefined
              const u = msg?.usage
              if (u) {
                inputTokens = Number(u.input_tokens ?? 0)
                cacheReadTokens = Number(u.cache_read_input_tokens ?? 0)
                cacheCreationTokens = Number(u.cache_creation_input_tokens ?? 0)
                outputTokens = Number(u.output_tokens ?? 0)
              }
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
              const u = parsed.usage as { output_tokens?: number } | undefined
              if (u?.output_tokens != null) {
                outputTokens = Number(u.output_tokens)
              }
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
export const fetchAnthropicAsOpenAi = async (
  baseUrl: string,
  apiKey: string,
  body: OpenAiRequest,
  signal?: AbortSignal,
): Promise<Response> => {
  const wantsStream = body.stream === true
  const anthropicBody = await convertOpenAiRequestToAnthropic({ ...body, stream: true })
  const endpoint = baseUrl.replace(/\/+$/, '') + '/messages'
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json',
    },
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
