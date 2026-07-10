import { supabase } from '../supabase/client'

// Client for the `relay-channel-info` Edge Function. Fetches balance /
// spend, models + real price, and online status for one relay station.
// Everything is best-effort: a relay that doesn't expose a given endpoint
// simply yields null for that section, and the UI degrades gracefully.

export type ChannelKind = 'newapi' | 'openrouter'

export type ChannelBalance = {
  currency: string
  granted: number | null
  used: number | null
  remaining: number | null
}

export type ChannelModelPrice = {
  name: string
  inputPerM: number | null
  outputPerM: number | null
  perRequest: number | null
  cached: boolean
}

export type ChannelPricingMeta = {
  groups: string[]
  appliedGroup: string
  groupRatio: number
}

export type ChannelInfo = {
  kind: ChannelKind
  status: 'online' | 'offline'
  balance: ChannelBalance | null
  models: ChannelModelPrice[]
  pricing: ChannelPricingMeta | null
  fetchedAt: string
}

export type ChannelInfoRequest = {
  baseUrl: string
  apiKey: string
  kind?: ChannelKind
  group?: string
}

export const fetchChannelInfo = async (req: ChannelInfoRequest): Promise<ChannelInfo> => {
  if (!supabase) throw new Error('未连接 Supabase，无法查询中转站信息')
  const { data, error } = await supabase.functions.invoke('relay-channel-info', {
    body: {
      baseUrl: req.baseUrl,
      apiKey: req.apiKey,
      kind: req.kind,
      group: req.group,
    },
  })
  if (error) throw new Error(error.message || '查询失败')
  if (data?.error) throw new Error(String(data.error))
  return data as ChannelInfo
}

// ── Local cache ───────────────────────────────────────────────────
// Cache the last successful result per relay (keyed by base URL) so the
// panel shows numbers instantly on open and can label stale balances for
// an offline station. Balances move slowly; a refresh button forces a
// fresh fetch. Keyed by base URL, NOT the key (keys never touch storage
// here beyond what the preset already holds).

const CACHE_PREFIX = 'nimbus_channel_info_v1:'

const cacheKey = (baseUrl: string) => `${CACHE_PREFIX}${baseUrl.replace(/\/+$/, '')}`

export const readCachedChannelInfo = (baseUrl: string): ChannelInfo | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(cacheKey(baseUrl))
    return raw ? (JSON.parse(raw) as ChannelInfo) : null
  } catch {
    return null
  }
}

export const writeCachedChannelInfo = (baseUrl: string, info: ChannelInfo) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(cacheKey(baseUrl), JSON.stringify(info))
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}

// Pretty-print a money amount in the relay's currency. USD → "$12.34",
// anything else falls back to "12.34 <CUR>".
export const formatMoney = (amount: number | null, currency: string): string => {
  if (amount == null) return '—'
  const abs = Math.abs(amount)
  const digits = abs > 0 && abs < 1 ? 4 : 2
  const n = amount.toFixed(digits)
  if (currency === 'USD') return `$${n}`
  if (currency === 'CNY') return `¥${n}`
  return `${n} ${currency}`
}

// Relative "x 前" label for a fetchedAt timestamp.
export const formatFetchedAgo = (iso: string): string => {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return '刚刚'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  return `${days} 天前`
}
