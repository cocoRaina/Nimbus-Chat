const STORAGE_VPS_URL = 'nimbus_vps_url'
const STORAGE_VPS_KEY = 'nimbus_vps_api_key'

export const getVpsUrl = (): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(STORAGE_VPS_URL)?.trim() ?? ''
}

export const saveVpsUrl = (url: string) => {
  if (typeof window === 'undefined') return
  const trimmed = url.trim().replace(/\/+$/, '')
  if (trimmed) window.localStorage.setItem(STORAGE_VPS_URL, trimmed)
  else window.localStorage.removeItem(STORAGE_VPS_URL)
}

export const getVpsApiKey = (): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(STORAGE_VPS_KEY)?.trim() ?? ''
}

export const saveVpsApiKey = (key: string) => {
  if (typeof window === 'undefined') return
  const trimmed = key.trim()
  if (trimmed) window.localStorage.setItem(STORAGE_VPS_KEY, trimmed)
  else window.localStorage.removeItem(STORAGE_VPS_KEY)
}

export const isVpsConfigured = (): boolean => {
  return Boolean(getVpsUrl()) && Boolean(getVpsApiKey())
}

export const vfetch = async (path: string, opts: RequestInit = {}): Promise<Response> => {
  const base = getVpsUrl()
  if (!base) throw new Error('VPS 未配置')
  const key = getVpsApiKey()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(key ? { 'x-api-key': key } : {}),
    ...(opts.headers as Record<string, string> ?? {})
  }
  return fetch(`${base}${path}`, { ...opts, headers })
}
