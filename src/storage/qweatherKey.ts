const STORAGE_KEY = 'nimbus_qweather_key_v1'

export const getQWeatherKey = (): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(STORAGE_KEY)?.trim() ?? ''
}

export const saveQWeatherKey = (key: string) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, key.trim())
}

export const clearQWeatherKey = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_KEY)
}

export const hasQWeatherKey = () => getQWeatherKey().length > 0
