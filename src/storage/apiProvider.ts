import { getOpenRouterApiKey } from './openrouterKey'

export type ProviderId = 'openrouter' | 'msuicode'
export type ApiFormat = 'openai' | 'anthropic'

const STORAGE_ACTIVE = 'nimbus_active_api_provider'
const STORAGE_MSUI_KEY = 'nimbus_msuicode_api_key'
const STORAGE_MSUI_BASE = 'nimbus_msuicode_base_url'
const STORAGE_OR_FORMAT = 'nimbus_or_format'
const STORAGE_MSUI_FORMAT = 'nimbus_msui_format'

export const DEFAULT_MSUICODE_BASE = 'https://www.msuicode.com'

// Pull a friendly label out of a base URL. "https://www.msuicode.com" → "msuicode",
// "https://api.deepseek.com" → "deepseek", etc. Falls back to "自定义" if parse fails.
export const deriveProviderDisplayName = (baseUrl: string): string => {
  try {
    const host = new URL(baseUrl).hostname.replace(/^(www\.|api\.|gateway\.)/, '')
    const parts = host.split('.')
    return parts.length >= 2 ? parts[0] : host
  } catch {
    return '自定义'
  }
}

export const getCustomProviderDisplayName = (): string =>
  deriveProviderDisplayName(getMsuicodeBaseUrl())

const trimSlash = (s: string) => s.replace(/\/+$/, '')

export const getActiveProvider = (): ProviderId => {
  if (typeof window === 'undefined') return 'openrouter'
  const v = window.localStorage.getItem(STORAGE_ACTIVE)
  return v === 'msuicode' ? 'msuicode' : 'openrouter'
}

export const setActiveProvider = (id: ProviderId) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_ACTIVE, id)
}

export const getMsuicodeApiKey = (): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(STORAGE_MSUI_KEY)?.trim() ?? ''
}

export const saveMsuicodeApiKey = (key: string) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_MSUI_KEY, key.trim())
}

export const clearMsuicodeApiKey = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_MSUI_KEY)
}

export const getMsuicodeBaseUrl = (): string => {
  if (typeof window === 'undefined') return DEFAULT_MSUICODE_BASE
  const stored = window.localStorage.getItem(STORAGE_MSUI_BASE)?.trim()
  return stored && stored.length > 0 ? stored : DEFAULT_MSUICODE_BASE
}

export const saveMsuicodeBaseUrl = (url: string) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_MSUI_BASE, url.trim())
}

const readFormat = (key: string): ApiFormat => {
  if (typeof window === 'undefined') return 'openai'
  const v = window.localStorage.getItem(key)
  return v === 'anthropic' ? 'anthropic' : 'openai'
}

const writeFormat = (key: string, format: ApiFormat) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, format)
}

export const getOpenRouterFormat = (): ApiFormat => readFormat(STORAGE_OR_FORMAT)
export const setOpenRouterFormat = (format: ApiFormat) => writeFormat(STORAGE_OR_FORMAT, format)
export const getMsuicodeFormat = (): ApiFormat => readFormat(STORAGE_MSUI_FORMAT)
export const setMsuicodeFormat = (format: ApiFormat) => writeFormat(STORAGE_MSUI_FORMAT, format)

export type ProviderConfig = {
  id: ProviderId
  baseUrl: string
  apiKey: string
  label: string
  format: ApiFormat
}

export const getProviderConfig = (id?: ProviderId): ProviderConfig => {
  const provider = id ?? getActiveProvider()
  if (provider === 'msuicode') {
    return {
      id: 'msuicode',
      baseUrl: `${trimSlash(getMsuicodeBaseUrl())}/v1`,
      apiKey: getMsuicodeApiKey(),
      label: 'msuicode',
      format: getMsuicodeFormat(),
    }
  }
  return {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: getOpenRouterApiKey(),
    label: 'OpenRouter',
    format: getOpenRouterFormat(),
  }
}

export const PROVIDER_MISSING_KEY_MESSAGE = (label: string) =>
  `未设置 ${label} API Key，请前往 设置 页面配置后再试。`

// ── Relay presets ──────────────────────────────────────────────────────
// Save several custom relays (base url + key + format) and switch between
// them with one tap. Deliberately NOT a new provider type: applying a
// preset just loads its values into the single custom ("msuicode") slot
// and makes that active, so all the routing / cache / keepalive logic that
// branches on 'openrouter' vs 'msuicode' keeps working untouched.
export type RelayPreset = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  format: ApiFormat
}

const STORAGE_PRESETS = 'nimbus_relay_presets_v1'

export const getRelayPresets = (): RelayPreset[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_PRESETS)
    const arr = raw ? (JSON.parse(raw) as RelayPreset[]) : []
    return Array.isArray(arr) ? arr.filter((p) => p && p.id && p.baseUrl) : []
  } catch {
    return []
  }
}

const writeRelayPresets = (presets: RelayPreset[]) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_PRESETS, JSON.stringify(presets))
}

// Add or update (matched by id) a relay preset.
export const saveRelayPreset = (preset: RelayPreset) => {
  const presets = getRelayPresets()
  const idx = presets.findIndex((p) => p.id === preset.id)
  if (idx >= 0) presets[idx] = preset
  else presets.push(preset)
  writeRelayPresets(presets)
}

export const deleteRelayPreset = (id: string) => {
  writeRelayPresets(getRelayPresets().filter((p) => p.id !== id))
}

// Load a preset into the custom slot and make it active. Returns false if
// the id no longer exists.
export const applyRelayPreset = (id: string): boolean => {
  const preset = getRelayPresets().find((p) => p.id === id)
  if (!preset) return false
  saveMsuicodeBaseUrl(preset.baseUrl)
  saveMsuicodeApiKey(preset.apiKey)
  setMsuicodeFormat(preset.format)
  setActiveProvider('msuicode')
  return true
}
