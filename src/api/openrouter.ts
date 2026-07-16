import { getProviderConfig, PROVIDER_MISSING_KEY_MESSAGE, type ProviderId } from '../storage/apiProvider'
import { OPENROUTER_MISSING_KEY_MESSAGE } from '../storage/openrouterKey'
import { fetchAnthropicAsOpenAi } from './anthropic'
import { nativeStreamFetchOrThrow, isNativeStreamAvailable } from '../native/streamHttp'

type FetchOptions = {
  body?: Record<string, unknown>
  signal?: AbortSignal
  /** Force a specific provider regardless of user's active selection. Used
   *  by background tasks like conversation compression that should always
   *  run on OpenRouter (cheap/free summarizer models). */
  provider?: ProviderId
}

// Tool messages may carry array content (text + image_url parts — the
// generate_image tool feeds the drawn image back this way). The native
// Anthropic path converts those into real tool_result image blocks, but the
// OpenAI-compat wire only allows string/text content on the tool role —
// image parts there 400 on most relays. Flatten to text before sending.
const flattenToolImageParts = (body: Record<string, unknown>): Record<string, unknown> => {
  const messages = body.messages
  if (!Array.isArray(messages)) return body
  let changed = false
  const out = messages.map((m) => {
    const msg = m as { role?: string; content?: unknown }
    if (msg?.role !== 'tool' || !Array.isArray(msg.content)) return m
    changed = true
    const text = (msg.content as Array<{ type?: string; text?: string }>)
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
    return { ...msg, content: text || '(工具返回了图片，当前协议下无法回看图片内容)' }
  })
  return changed ? { ...body, messages: out } : body
}

// Kept the name fetchOpenRouter for blast-radius reasons — it now routes
// to whichever provider the user has selected (OpenRouter or custom).
// Both expose OpenAI-compatible /v1/chat/completions + /v1/models.
export const fetchOpenRouter = async (
  path: string,
  { body, signal, provider }: FetchOptions = {},
): Promise<Response> => {
  const { baseUrl, apiKey, label, id, format } = getProviderConfig(provider)
  if (!apiKey) {
    throw new Error(
      id === 'openrouter' ? OPENROUTER_MISSING_KEY_MESSAGE : PROVIDER_MISSING_KEY_MESSAGE(label),
    )
  }

  // Anthropic-format provider: only chat completions get translated to
  // /v1/messages. /models still uses OpenAI-compatible path since both
  // OR and 中转 expose model lists in OpenAI shape regardless of format.
  //
  // Auto-route Claude requests on OpenRouter through Anthropic's native
  // /messages endpoint — UNLESS the user has explicitly opted into
  // OpenAI-compat for OR via the settings toggle. Background: OR's
  // OpenAI-compat layer for Claude (/chat/completions) silently strips
  // /relocates cache_control during translation, which breaks prompt
  // caching on tool-iteration rounds. The native /messages endpoint on
  // OR is a thin passthrough to Anthropic (per OR docs: "Anthropic Skin
  // behaves exactly like the Anthropic API"), so cache_control,
  // thinking, metadata.user_id all land as intended. Same trick the
  // msuicode relay uses to achieve 100% cache hit rate including tool
  // iterations. The user-explicit-openai escape hatch exists so the
  // settings toggle stays meaningful for debugging — without it, the
  // toggle was silently a no-op for Claude models.
  const looksLikeClaude =
    body != null &&
    typeof body === 'object' &&
    typeof (body as { model?: unknown }).model === 'string' &&
    /claude|anthropic/i.test((body as { model: string }).model)
  const userPickedOpenAi = id === 'openrouter' && format === 'openai'
  const useAnthropicNative =
    !userPickedOpenAi && (format === 'anthropic' || (id === 'openrouter' && looksLikeClaude))

  if (useAnthropicNative && path === '/chat/completions' && body) {
    // Per-provider protocol quirks. OpenRouter's /messages gateway wants
    // Bearer auth + the OR-style `anthropic/<model>` slug intact (it uses
    // the prefix to route to its Anthropic upstream). Anthropic-direct
    // and msuicode-style relays want x-api-key + the bare Anthropic
    // model name.
    const isOpenRouterProvider = id === 'openrouter'
    return fetchAnthropicAsOpenAi(
      baseUrl,
      apiKey,
      body as Parameters<typeof fetchAnthropicAsOpenAi>[2],
      {
        signal,
        authStyle: isOpenRouterProvider ? 'bearer' : 'x-api-key',
        keepModelSlug: isOpenRouterProvider,
      },
    )
  }

  // OpenAI-compat wire from here on — image parts on tool messages must go.
  const wireBody = body && path === '/chat/completions' ? flattenToolImageParts(body) : body

  // OpenAI-compat streaming on native: try the StreamHttp plugin for the same
  // reason as the Anthropic path — CapacitorHttp (kept on for CORS) buffers
  // window.fetch, killing the stream. Falls back to plain fetch if the native
  // path stalls, so it can never hang. Non-stream / web go straight to fetch.
  const wantsStream = body != null && (body as { stream?: unknown }).stream === true
  const reqHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  if (wantsStream && path === '/chat/completions' && isNativeStreamAvailable()) {
    try {
      return await nativeStreamFetchOrThrow(`${baseUrl}${path}`, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(wireBody),
        signal,
      })
    } catch {
      // Native streaming stalled/failed. Give cancelStream ~500 ms to close
      // the TCP connection before retrying on the buffered path, otherwise
      // the relay sees two concurrent connections and can concurrency-limit us.
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  return fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: reqHeaders,
    body: wireBody ? JSON.stringify(wireBody) : undefined,
    signal,
  })
}

export const fetchOpenRouterModels = async ({ forceRefresh = false } = {}) => {
  const { id: providerId, baseUrl } = getProviderConfig()
  // Include base URL so different relay presets get isolated caches.
  const cacheKey = `nimbus_models_cache_v2:${providerId}:${baseUrl}`
  const cacheTtlMs = 24 * 60 * 60 * 1000

  const readCache = (allowStale = false): Array<{ id: string; name?: string; context_length: number | null }> | null => {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem(cacheKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { savedAt: number; models: Array<{ id: string; name?: string; context_length: number | null }> }
      const expired = Date.now() - parsed.savedAt > cacheTtlMs
      if (expired && !allowStale) return null
      return parsed.models
    } catch {
      return null
    }
  }

  const writeCache = (models: Array<{ id: string; name?: string; context_length: number | null }>) => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), models }))
    } catch {
      // ignore quota errors
    }
  }

  // Serve fresh cache immediately — unless caller explicitly wants a network refresh.
  if (!forceRefresh) {
    const fresh = readCache()
    if (fresh) return fresh
  }

  try {
    const response = await fetchOpenRouter('/models')
    if (!response.ok) {
      const stale = readCache(true)
      if (stale && stale.length > 0) return stale
      throw new Error(await response.text())
    }
    const payload = (await response.json()) as { data?: Array<{ id: string; name?: string; context_length?: number | null }> }
    const models = Array.isArray(payload.data)
      ? payload.data.map((model) => ({
          id: model.id,
          name: model.name,
          context_length: model.context_length ?? null,
        }))
      : []
    if (models.length > 0) writeCache(models)
    return models
  } catch (error) {
    const stale = readCache(true)
    if (stale && stale.length > 0) {
      console.warn('[模型库] 网络获取失败，使用本地缓存', error)
      return stale
    }
    throw error
  }
}
