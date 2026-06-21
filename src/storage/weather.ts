import { Capacitor } from '@capacitor/core'
import { Geolocation } from '@capacitor/geolocation'

// Open-Meteo weather fetcher — free, no API key required.
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
  // On Capacitor (APK), use the native Geolocation plugin so the OS
  // permission dialog actually fires + Android manifest permission is
  // respected. On web, fall back to navigator.geolocation.
  if (Capacitor.getPlatform() !== 'web') {
    try {
      const perm = await Geolocation.checkPermissions()
      if (perm.location !== 'granted') {
        const req = await Geolocation.requestPermissions()
        if (req.location !== 'granted') return 'denied'
      }
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 30 * 60 * 1000,
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
      { timeout: 5000, maximumAge: 30 * 60 * 1000 },
    )
  })
}

// Reverse-geocode a coordinate to a human city name. BigDataCloud's
// reverse-geocode-client endpoint is genuinely key-free and CORS-enabled
// (built for browser use), unlike Nominatim which needs a custom User-Agent
// the browser won't let us set. Best-effort: any failure returns null and the
// weather still works without a city. Only called on a cache miss (hourly
// background warm), never on the send path, so it adds no send latency.
const reverseGeocodeCity = async (lat: number, lon: number): Promise<string | null> => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const url =
      `https://api.bigdatacloud.net/data/reverse-geocode-client` +
      `?latitude=${lat}&longitude=${lon}&localityLanguage=zh`
    const r = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!r.ok) return null
    const d = (await r.json()) as {
      city?: string
      locality?: string
      principalSubdivision?: string
    }
    const name = d.city?.trim() || d.locality?.trim() || d.principalSubdivision?.trim()
    return name && name.length > 0 ? name : null
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

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`
    const r = await fetch(url)
    if (!r.ok) return cached ?? null
    const data = await r.json() as {
      current?: {
        temperature_2m?: number
        apparent_temperature?: number
        weather_code?: number
        wind_speed_10m?: number
      }
    }
    const c = data.current
    if (!c) return cached ?? null
    // For GPS readings, resolve the city name too. cityOverride already
    // carries its own label, so only reverse-geocode the GPS path.
    const city = cityOverride
      ? ('city' in cityOverride ? (cityOverride.city ?? null) : null)
      : await reverseGeocodeCity(coords.lat, coords.lon)
    const snap: WeatherSnapshot = {
      fetchedAt: Date.now(),
      temperatureC: Math.round(c.temperature_2m ?? 0),
      feelsLikeC: Math.round(c.apparent_temperature ?? 0),
      condition: WEATHER_CODE_LABEL[c.weather_code ?? -1] ?? '未知天气',
      windKmh: Math.round(c.wind_speed_10m ?? 0),
      city,
      lat: coords.lat,
      lon: coords.lon,
    }
    // Only cache GPS-based readings. A cityOverride result must not land in
    // the shared cache key, or a later no-override (GPS) call within the TTL
    // would return the override city's weather.
    if (!cityOverride) writeCache(snap)
    return snap
  } catch (err) {
    console.warn('weather fetch failed', err)
    return cached ?? null
  }
}

export const formatWeatherInline = (snap: WeatherSnapshot): string => {
  const feel = Math.abs(snap.temperatureC - snap.feelsLikeC) >= 3
    ? `（体感 ${snap.feelsLikeC}°C）`
    : ''
  return `${snap.temperatureC}°C ${snap.condition}${feel}`
}
