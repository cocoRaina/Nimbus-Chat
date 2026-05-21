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

// OpenRouter chat completions sometimes return Anthropic's underlying dated
// model id (e.g., "anthropic/claude-4.6-opus-20260205") while the /models
// catalog lists the canonical slug ("anthropic/claude-opus-4.6"). Try fuzzy
// matching so cost estimates don't silently become 0.
const findModelPricing = (model: string, pricing: ModelPricingMap): ModelPricing | undefined => {
  if (pricing[model]) return pricing[model]
  const lower = model.toLowerCase()
  // 1) exact case-insensitive
  for (const [key, val] of Object.entries(pricing)) {
    if (key.toLowerCase() === lower) return val
  }
  // 2) strip trailing date suffix like -YYYYMMDD or :YYYYMMDD
  const noDate = lower.replace(/[-:]\d{6,8}.*$/, '')
  if (pricing[noDate]) return pricing[noDate]
  // 3) token-based fuzzy match: extract [family, version, tier] tokens
  const family = noDate.replace(/^[^/]+\//, '') // drop vendor prefix
  const tokens = family.match(/[a-z]+|\d+(?:\.\d+)?/g) ?? []
  if (tokens.length < 2) return undefined
  let bestMatch: ModelPricing | undefined
  let bestScore = 0
  for (const [key, val] of Object.entries(pricing)) {
    const keyLower = key.toLowerCase()
    const matchedTokens = tokens.filter((t) => keyLower.includes(t)).length
    if (matchedTokens === tokens.length && matchedTokens > bestScore) {
      bestScore = matchedTokens
      bestMatch = val
    }
  }
  return bestMatch
}

export const estimateCostUsd = (
  model: string,
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricingMap,
  cachedTokens = 0,
): number => {
  const entry = findModelPricing(model, pricing)
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
