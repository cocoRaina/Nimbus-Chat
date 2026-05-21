import { fetchOpenRouter } from '../api/openrouter'

export type ModelPricing = {
  promptUsdPerToken: number
  completionUsdPerToken: number
}

type ModelPricingMap = Record<string, ModelPricing>

const STORAGE_KEY = 'nimbus_openrouter_pricing_v1'
const TTL_MS = 24 * 60 * 60 * 1000

type CachedPayload = {
  fetchedAt: number
  pricing: ModelPricingMap
}

const readCache = (): CachedPayload | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as CachedPayload
    if (!parsed.fetchedAt || !parsed.pricing) {
      return null
    }
    if (Date.now() - parsed.fetchedAt > TTL_MS) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const writeCache = (pricing: ModelPricingMap) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), pricing } satisfies CachedPayload),
    )
  } catch {
    // ignore quota / serialization errors
  }
}

export const fetchModelPricing = async (force = false): Promise<ModelPricingMap> => {
  if (!force) {
    const cached = readCache()
    if (cached) {
      return cached.pricing
    }
  }
  const response = await fetchOpenRouter('/models')
  if (!response.ok) {
    throw new Error(await response.text())
  }
  const payload = (await response.json()) as {
    data?: Array<{
      id: string
      pricing?: { prompt?: string | number; completion?: string | number }
    }>
  }
  const pricing: ModelPricingMap = {}
  for (const model of payload.data ?? []) {
    const prompt = Number(model.pricing?.prompt ?? 0)
    const completion = Number(model.pricing?.completion ?? 0)
    if (!model.id || (Number.isNaN(prompt) && Number.isNaN(completion))) {
      continue
    }
    pricing[model.id] = {
      promptUsdPerToken: Number.isFinite(prompt) ? prompt : 0,
      completionUsdPerToken: Number.isFinite(completion) ? completion : 0,
    }
  }
  writeCache(pricing)
  return pricing
}

export const estimateCostUsd = (
  model: string,
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricingMap,
  cachedTokens = 0,
): number => {
  const entry = pricing[model]
  if (!entry) {
    return 0
  }
  // Anthropic / OpenAI prompt caching: cached read is ~10% of full input price.
  // Uncached input is full price. Output unchanged.
  // (Cache write is 1.25x but OpenRouter doesn't report it separately, so we
  //  let that imprecision slide — it averages out across hits.)
  const safeCached = Math.max(0, Math.min(promptTokens, cachedTokens))
  const uncachedPrompt = promptTokens - safeCached
  return (
    uncachedPrompt * entry.promptUsdPerToken +
    safeCached * entry.promptUsdPerToken * 0.1 +
    completionTokens * entry.completionUsdPerToken
  )
}
