import { getOpenRouterApiKey } from './openrouterKey'

export type ProviderId = 'openrouter' | 'msuicode'

const STORAGE_ACTIVE = 'nimbus_active_api_provider'
const STORAGE_MSUI_KEY = 'nimbus_msuicode_api_key'
const STORAGE_MSUI_BASE = 'nimbus_msuicode_base_url'

export const DEFAULT_MSUICODE_BASE = 'https://www.msuicode.com'

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

export type ProviderConfig = {
  id: ProviderId
  baseUrl: string
  apiKey: string
  label: string
}

export const getProviderConfig = (id?: ProviderId): ProviderConfig => {
  const provider = id ?? getActiveProvider()
  if (provider === 'msuicode') {
    return {
      id: 'msuicode',
      baseUrl: `${trimSlash(getMsuicodeBaseUrl())}/v1`,
      apiKey: getMsuicodeApiKey(),
      label: 'msuicode',
    }
  }
  return {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: getOpenRouterApiKey(),
    label: 'OpenRouter',
  }
}

export const PROVIDER_MISSING_KEY_MESSAGE = (label: string) =>
  `未设置 ${label} API Key，请前往 设置 页面配置后再试。`
