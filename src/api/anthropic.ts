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

const flattenContent = (content: OpenAiMessage['content']): string | AnthropicContentBlock[] => {
  if (typeof content === 'string') return content
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
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
      blocks.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return blocks
}

export const convertOpenAiRequestToAnthropic = (body: OpenAiRequest): AnthropicRequest => {
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
      const last = messages[messages.length - 1]
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      }
      // Anthropic requires tool_result to be in a user message. Coalesce
      // consecutive tool results into one user message.
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
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: flattenContent(msg.content),
    })
  }

  const tools = body.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }))

  // Thinking: if OpenAI request has reasoning.effort, translate to Anthropic
  // extended thinking with a token budget.
  let thinking: AnthropicRequest['thinking']
  const effort = (body.reasoning as { effort?: string } | undefined)?.effort
  if (effort === 'high') {
    thinking = { type: 'enabled', budget_tokens: 8000 }
  } else if (effort === 'medium' || effort === 'low') {
    thinking = { type: 'enabled', budget_tokens: 2000 }
  }

  return {
    model: body.model,
    messages,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    max_tokens: typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 4096,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
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

// Wraps an Anthropic /v1/messages call so it returns a Response that
// streams OpenAI-shaped SSE chunks. Caller can keep its existing parser.
export const fetchAnthropicAsOpenAi = async (
  baseUrl: string,
  apiKey: string,
  body: OpenAiRequest,
  signal?: AbortSignal,
): Promise<Response> => {
  const anthropicBody = convertOpenAiRequestToAnthropic({ ...body, stream: true })
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
    // Pass non-streaming error responses through as-is so caller sees the text.
    return upstream
  }
  return translateAnthropicStream(upstream)
}
