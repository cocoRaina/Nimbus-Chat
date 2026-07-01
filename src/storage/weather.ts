import { Capacitor } from '@capacitor/core'
import { Geolocation } from '@capacitor/geolocation'
import { getQWeatherCredential, generateQWeatherJWT, isHexApiKey, type QWeatherCredential } from './qweatherKey'

// Primary: QWeather (和风天气) — accurate for China, JWT auth (Ed25519).
// Fallback: Open-Meteo — no key, global NWP model.
// https://dev.qweather.com/docs/api/weather/weather-now/
// https://open-meteo.com/

const STORAGE_KEY = 'nimbus_weather_cache_v1'
const TTL_MS = 60 * 60 * 1000 // 1 hour

const WEATHER_CODE_LABEL: Record<number, string> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  61: '小雨',
  63: '雨',
  65: '大雨',
  71: '小雪',
  73: '雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '大阵雨',
  85: '阵雪',
  86: '大阵雪',
  95: '雷雨',
  96: '雷雨夹冰雹',
  99: '雷雨夹冰雹',
}

export type WeatherSnapshot = {
  fetchedAt: number
  temperatureC: number
  feelsLikeC: number
  condition: string
  windKmh: number
  city: string | null
  lat: number
  lon: number
  source?: 'qweather' | 'open-meteo'
  qweatherError?: string
}

export const peekCachedWeather = (): WeatherSnapshot | null => readCache()

const readCache = (): WeatherSnapshot | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WeatherSnapshot
    if (Date.now() - parsed.fetchedAt > TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

const writeCache = (snap: WeatherSnapshot) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snap))
  } catch {
    // ignore
  }
}

const getCoords = async (): Promise<{ lat: number; lon: number } | 'denied' | null> => {
  if (Capacitor.getPlatform() !== 'web') {
    try {
      const perm = await Geolocation.checkPermissions()
      if (perm.location !== 'granted') {
        const req = await Geolocation.requestPermissions()
        if (req.location !== 'granted') return 'denied'
      }
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 10 * 60 * 1000,
      })
      return { lat: pos.coords.latitude, lon: pos.coords.longitude }
    } catch (err) {
      console.warn('Geolocation plugin failed', err)
      return null
    }
  }
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10 * 60 * 1000 },
    )
  })
}

// Build fetch options for QWeather API based on credential type:
// - Hex key → X-QW-Api-Key header (per QWeather docs: not ?key= URL param)
// - PEM key → EdDSA JWT Bearer
const buildQWeatherFetchArgs = async (
  cred: QWeatherCredential,
): Promise<{ keyParam: string; headers: Record<string, string> }> => {
  const raw = cred.privateKeyPem.trim()
  if (isHexApiKey(raw)) {
    return { keyParam: '', headers: { 'X-QW-Api-Key': raw } }
  }
  const jwt = await generateQWeatherJWT(cred)
  return { keyParam: '', headers: { Authorization: `Bearer ${jwt}` } }
}

// QWeather GeoAPI reverse-geocode: coords → Chinese city name.
const qweatherReverseGeocode = async (
  lat: number,
  lon: number,
  cred: QWeatherCredential,
): Promise<string | null> => {
  try {
    const { keyParam, headers } = await buildQWeatherFetchArgs(cred)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const url = `https://geoapi.qweather.com/v2/city/lookup?location=${lon},${lat}${keyParam}`
    const r = await fetch(url, { signal: controller.signal, headers })
    clearTimeout(timer)
    if (!r.ok) return null
    const d = (await r.json()) as { location?: Array<{ name?: string; adm2?: string; adm1?: string }> }
    const loc = d.location?.[0]
    if (!loc) return null
    return loc.name?.trim() || loc.adm2?.trim() || loc.adm1?.trim() || null
  } catch {
    return null
  }
}

// Fallback reverse-geocode (no key). BigDataCloud is CORS-safe.
const fallbackReverseGeocode = async (lat: number, lon: number): Promise<string | null> => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const url =
      `https://api.bigdatacloud.net/data/reverse-geocode-client` +
      `?latitude=${lat}&longitude=${lon}&localityLanguage=zh`
    const r = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!r.ok) return null
    const d = (await r.json()) as { city?: string; locality?: string; principalSubdivision?: string }
    const name = d.locality?.trim() || d.city?.trim() || d.principalSubdivision?.trim()
    return name && name.length > 0 ? name : null
  } catch {
    return null
  }
}

// QWeather weather-now API. Supports both hex ?key= param and JWT Bearer auth.
const fetchQWeather = async (
  lat: number,
  lon: number,
  cred: QWeatherCredential,
): Promise<{ data: { temperatureC: number; feelsLikeC: number; condition: string; windKmh: number } | null; error: string | null }> => {
  try {
    const { keyParam, headers } = await buildQWeatherFetchArgs(cred)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const url = `https://devapi.qweather.com/v7/weather/now?location=${lon},${lat}${keyParam}`
    const r = await fetch(url, { signal: controller.signal, headers })
    clearTimeout(timer)
    if (!r.ok) {
      return { data: null, error: `HTTP ${r.status}` }
    }
    const d = (await r.json()) as {
      code?: string
      now?: { temp?: string; feelsLike?: string; text?: string; windSpeed?: string }
    }
    if (d.code !== '200' || !d.now) {
      return { data: null, error: `API code ${d.code ?? '?'}` }
    }
    const now = d.now
    return {
      data: {
        temperatureC: Math.round(Number(now.temp ?? 0)),
        feelsLikeC: Math.round(Number(now.feelsLike ?? 0)),
        condition: now.text ?? '未知天气',
        windKmh: Math.round(Number(now.windSpeed ?? 0)),
      },
      error: null,
    }
  } catch (e) {
    return { data: null, error: String(e) }
  }
}

// Open-Meteo fallback (no key).
const fetchOpenMeteo = async (
  lat: number,
  lon: number,
): Promise<{ temperatureC: number; feelsLikeC: number; condition: string; windKmh: number } | null> => {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`
    const r = await fetch(url)
    if (!r.ok) return null
    const data = (await r.json()) as {
      current?: {
        temperature_2m?: number
        apparent_temperature?: number
        weather_code?: number
        wind_speed_10m?: number
      }
    }
    const c = data.current
    if (!c) return null
    return {
      temperatureC: Math.round(c.temperature_2m ?? 0),
      feelsLikeC: Math.round(c.apparent_temperature ?? 0),
      condition: WEATHER_CODE_LABEL[c.weather_code ?? -1] ?? '未知天气',
      windKmh: Math.round(c.wind_speed_10m ?? 0),
    }
  } catch {
    return null
  }
}

export const fetchCurrentWeather = async (
  cityOverride?: { lat: number; lon: number; city?: string },
): Promise<WeatherSnapshot | null> => {
  const cached = readCache()
  if (cached && !cityOverride) return cached

  const coordsOrDenied = cityOverride ?? (await getCoords())
  if (coordsOrDenied === 'denied') return null
  const coords = coordsOrDenied
  if (!coords) return cached ?? null

  const { lat, lon } = coords
  const cred = getQWeatherCredential()

  let source: 'qweather' | 'open-meteo' = 'open-meteo'
  let qweatherError: string | null = null
  let wx = null

  if (cred) {
    try {
      const result = await fetchQWeather(lat, lon, cred)
      if (result.data) {
        wx = result.data
        source = 'qweather'
      } else {
        qweatherError = result.error
      }
    } catch (e) {
      qweatherError = String(e)
    }
  }
  if (!wx) wx = await fetchOpenMeteo(lat, lon)
  if (!wx) return cached ?? null

  let city: string | null = null
  if (cityOverride) {
    city = ('city' in cityOverride ? (cityOverride.city ?? null) : null)
  } else if (source === 'qweather' && cred) {
    city = await qweatherReverseGeocode(lat, lon, cred)
    if (!city) city = await fallbackReverseGeocode(lat, lon)
  } else {
    city = await fallbackReverseGeocode(lat, lon)
  }

  const snap: WeatherSnapshot = {
    fetchedAt: Date.now(),
    ...wx,
    city,
    lat,
    lon,
    source,
    ...(qweatherError ? { qweatherError } : {}),
  }
  if (!cityOverride) writeCache(snap)
  return snap
}

export const formatWeatherInline = (snap: WeatherSnapshot): string => {
  const feel = Math.abs(snap.temperatureC - snap.feelsLikeC) >= 3
    ? `（体感 ${snap.feelsLikeC}°C）`
    : ''
  return `${snap.temperatureC}°C ${snap.condition}${feel}`
}
