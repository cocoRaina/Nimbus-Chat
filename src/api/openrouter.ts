import { getProviderConfig, PROVIDER_MISSING_KEY_MESSAGE } from '../storage/apiProvider'
import { OPENROUTER_MISSING_KEY_MESSAGE } from '../storage/openrouterKey'

type FetchOptions = {
  body?: Record<string, unknown>
  signal?: AbortSignal
}

// Kept the name fetchOpenRouter for blast-radius reasons — it now routes
// to whichever provider the user has selected (OpenRouter or msuicode).
// Both expose OpenAI-compatible /v1/chat/completions + /v1/models.
export const fetchOpenRouter = async (
  path: string,
  { body, signal }: FetchOptions = {},
): Promise<Response> => {
  const { baseUrl, apiKey, label, id } = getProviderConfig()
  if (!apiKey) {
    // Preserve the old, more specific message when on OpenRouter so existing
    // error-handling UX doesn't regress.
    throw new Error(
      id === 'openrouter' ? OPENROUTER_MISSING_KEY_MESSAGE : PROVIDER_MISSING_KEY_MESSAGE(label),
    )
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
  const response = await fetchOpenRouter('/models')
  if (!response.ok) {
    throw new Error(await response.text())
  }
  const payload = (await response.json()) as { data?: Array<{ id: string; name?: string; context_length?: number | null }> }
  return Array.isArray(payload.data)
    ? payload.data.map((model) => ({
        id: model.id,
        name: model.name,
        context_length: model.context_length ?? null,
      }))
    : []
}
