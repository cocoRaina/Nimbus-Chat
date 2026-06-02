import { getProviderConfig, PROVIDER_MISSING_KEY_MESSAGE, type ProviderId } from '../storage/apiProvider'
import { OPENROUTER_MISSING_KEY_MESSAGE } from '../storage/openrouterKey'
import { fetchAnthropicAsOpenAi } from './anthropic'

type FetchOptions = {
  body?: Record<string, unknown>
  signal?: AbortSignal
  /** Force a specific provider regardless of user's active selection. Used
   *  by background tasks like conversation compression that should always
   *  run on OpenRouter (cheap/free summarizer models). */
  provider?: ProviderId
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
  // /messages endpoint regardless of stored format setting. Background:
  // OR's OpenAI-compat layer for Claude (/chat/completions) silently
  // strips/relocates cache_control during translation, which is exactly
  // what breaks prompt caching on tool-iteration rounds — our hours of
  // chasing cached_tokens=0 on round 2/3 all reduce to "OR's translation
  // layer doesn't carry the markers correctly when there are tool blocks
  // present". The native /messages endpoint on OR is a thin passthrough
  // to Anthropic (per OR docs: "Anthropic Skin behaves exactly like the
  // Anthropic API"), so cache_control, thinking, metadata.user_id all
  // land as intended. Same trick the msuicode relay uses to achieve
  // 100% cache hit rate including tool iterations.
  const looksLikeClaude =
    body != null &&
    typeof body === 'object' &&
    typeof (body as { model?: unknown }).model === 'string' &&
    /claude|anthropic/i.test((body as { model: string }).model)
  const useAnthropicNative =
    format === 'anthropic' || (id === 'openrouter' && looksLikeClaude)

  if (useAnthropicNative && path === '/chat/completions' && body) {
    return fetchAnthropicAsOpenAi(baseUrl, apiKey, body as Parameters<typeof fetchAnthropicAsOpenAi>[2], signal)
  }

  return fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
}

export const fetchOpenRouterModels = async () => {
  const { id: providerId } = getProviderConfig()
  const cacheKey = `nimbus_models_cache_v1:${providerId}`
  const cacheTtlMs = 24 * 60 * 60 * 1000

  const readCache = (): Array<{ id: string; name?: string; context_length: number | null }> | null => {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem(cacheKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { savedAt: number; models: Array<{ id: string; name?: string; context_length: number | null }> }
      if (Date.now() - parsed.savedAt > cacheTtlMs) {
        return parsed.models
      }
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

  try {
    const response = await fetchOpenRouter('/models')
    if (!response.ok) {
      const cached = readCache()
      if (cached && cached.length > 0) return cached
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
    const cached = readCache()
    if (cached && cached.length > 0) {
      console.warn('[模型库] 网络获取失败，使用本地缓存', error)
      return cached
    }
    throw error
  }
}
