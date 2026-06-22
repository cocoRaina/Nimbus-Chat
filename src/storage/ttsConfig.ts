import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

// TTS config. Two providers, fields stored separately so switching between
// them doesn't clobber either's settings. Keys live only on-device (like the
// other API keys) — never committed, only sent to our own `tts` edge function
// which relays to the chosen provider.
//
// Storage: on native (Capacitor Android) the WebView's localStorage does NOT
// reliably flush a *recent* write to disk before the app is backgrounded /
// killed / the WebView is reclaimed — the same hazard documented in
// supabase/authStorage.ts. A TTS key the user just typed would survive in
// memory for the current session but vanish on the next cold start / reload.
// So we write through to Capacitor Preferences (native SharedPreferences, which
// commits durably) AND keep a synchronous localStorage mirror for fast reads.
// `hydrateTtsConfig()` pulls Preferences → localStorage on app/WebView load so
// the durable value is always in the sync cache before anything reads it.
const K = {
  provider: 'nimbus_tts_provider',
  enabled: 'nimbus_tts_enabled',
  // MiniMax
  apiKey: 'nimbus_tts_api_key',
  groupId: 'nimbus_tts_group_id',
  voiceId: 'nimbus_tts_voice_id',
  baseUrl: 'nimbus_tts_base_url',
  model: 'nimbus_tts_model',
  // ElevenLabs
  elApiKey: 'nimbus_tts_el_api_key',
  elVoiceId: 'nimbus_tts_el_voice_id',
  elModel: 'nimbus_tts_el_model',
  elStability: 'nimbus_tts_el_stability',
}

const ALL_KEYS = Object.values(K)
const isNative = Capacitor.isNativePlatform()

export type TtsProvider = 'minimax' | 'elevenlabs'

export const DEFAULT_TTS_BASE = 'https://api.minimaxi.com'
export const DEFAULT_TTS_MODEL = 'speech-2.8-turbo'
export const DEFAULT_EL_MODEL = 'eleven_v3'
// v3 stability is one of three discrete values: 0 = Creative (most expressive),
// 0.5 = Natural, 1 = Robust. Default Natural — expressive but not unhinged.
export const DEFAULT_EL_STABILITY = 0.5

export type TtsConfig = {
  provider: TtsProvider
  enabled: boolean
  // MiniMax
  apiKey: string
  groupId: string
  voiceId: string
  baseUrl: string
  model: string
  // ElevenLabs
  elApiKey: string
  elVoiceId: string
  elModel: string
  elStability: number
}

const read = (k: string): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(k)?.trim() ?? ''
}

// Write one key to the synchronous localStorage mirror AND, on native, to the
// durable Preferences store (fire-and-forget; the mirror is what reads hit).
const writeKey = (k: string, v: string) => {
  if (typeof window !== 'undefined') window.localStorage.setItem(k, v)
  if (isNative) void Preferences.set({ key: k, value: v })
}

export const getTtsConfig = (): TtsConfig => ({
  provider: read(K.provider) === 'elevenlabs' ? 'elevenlabs' : 'minimax',
  enabled: read(K.enabled) === '1',
  apiKey: read(K.apiKey),
  groupId: read(K.groupId),
  voiceId: read(K.voiceId),
  baseUrl: read(K.baseUrl) || DEFAULT_TTS_BASE,
  model: read(K.model) || DEFAULT_TTS_MODEL,
  elApiKey: read(K.elApiKey),
  elVoiceId: read(K.elVoiceId),
  elModel: read(K.elModel) || DEFAULT_EL_MODEL,
  elStability: (() => {
    const v = Number(read(K.elStability))
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_EL_STABILITY
  })(),
})

export const saveTtsConfig = (c: Partial<TtsConfig>) => {
  if (c.provider !== undefined) writeKey(K.provider, c.provider)
  if (c.enabled !== undefined) writeKey(K.enabled, c.enabled ? '1' : '0')
  if (c.apiKey !== undefined) writeKey(K.apiKey, c.apiKey.trim())
  if (c.groupId !== undefined) writeKey(K.groupId, c.groupId.trim())
  if (c.voiceId !== undefined) writeKey(K.voiceId, c.voiceId.trim())
  if (c.baseUrl !== undefined) writeKey(K.baseUrl, c.baseUrl.trim())
  if (c.model !== undefined) writeKey(K.model, c.model.trim())
  if (c.elApiKey !== undefined) writeKey(K.elApiKey, c.elApiKey.trim())
  if (c.elVoiceId !== undefined) writeKey(K.elVoiceId, c.elVoiceId.trim())
  if (c.elModel !== undefined) writeKey(K.elModel, c.elModel.trim())
  if (c.elStability !== undefined) writeKey(K.elStability, String(c.elStability))
}

// Full config → the [key, value] pairs we persist.
const toPairs = (c: TtsConfig): [string, string][] => [
  [K.provider, c.provider],
  [K.enabled, c.enabled ? '1' : '0'],
  [K.apiKey, c.apiKey.trim()],
  [K.groupId, c.groupId.trim()],
  [K.voiceId, c.voiceId.trim()],
  [K.baseUrl, c.baseUrl.trim()],
  [K.model, c.model.trim()],
  [K.elApiKey, c.elApiKey.trim()],
  [K.elVoiceId, c.elVoiceId.trim()],
  [K.elModel, c.elModel.trim()],
  [K.elStability, String(c.elStability)],
]

// Explicit, AWAITED save used by the Save button. Unlike saveTtsConfig's
// fire-and-forget native write, this resolves only after every value has been
// committed to native Preferences (durable on Android) — so when the "已保存"
// confirmation shows, the data is guaranteed on disk, even if the app is killed
// the moment after.
export const commitTtsConfig = async (c: TtsConfig): Promise<void> => {
  const pairs = toPairs(c)
  if (typeof window !== 'undefined') {
    for (const [k, v] of pairs) window.localStorage.setItem(k, v)
  }
  if (isNative) await Promise.all(pairs.map(([k, v]) => Preferences.set({ key: k, value: v })))
}

// Pull the durable Preferences copy into the synchronous localStorage mirror.
// Call once on every app / WebView load BEFORE reading TTS config, so a value
// that localStorage dropped (unflushed write lost to a background kill) is
// restored from native storage. No-op on web (localStorage persists fine there).
// Also migrates any pre-existing localStorage-only value INTO Preferences so the
// first run after shipping this doesn't lose what was already entered.
export const hydrateTtsConfig = async (): Promise<void> => {
  if (!isNative || typeof window === 'undefined') return
  await Promise.all(
    ALL_KEYS.map(async (k) => {
      const { value } = await Preferences.get({ key: k })
      if (value !== null) {
        window.localStorage.setItem(k, value)
        return
      }
      // Nothing durable yet — adopt any legacy localStorage value.
      const legacy = window.localStorage.getItem(k)
      if (legacy !== null) await Preferences.set({ key: k, value: legacy })
    }),
  )
}

// Diagnostic: read the active provider's voice id + api key back from the
// DURABLE store (Preferences on native, localStorage on web) and report their
// lengths. Lets the settings UI prove whether a save actually landed on disk —
// 0/0 means the write failed; non-zero means storage is fine and any remaining
// problem is elsewhere (display / [voice] tags / enable toggle).
export const readbackTtsActive = async (): Promise<{
  native: boolean; provider: TtsProvider; voiceLen: number; keyLen: number
}> => {
  const getDurable = async (k: string): Promise<string> => {
    if (isNative) return ((await Preferences.get({ key: k })).value ?? '').trim()
    return (typeof window !== 'undefined' ? window.localStorage.getItem(k) ?? '' : '').trim()
  }
  const provider = (await getDurable(K.provider)) === 'elevenlabs' ? 'elevenlabs' : 'minimax'
  const voice = provider === 'elevenlabs' ? await getDurable(K.elVoiceId) : await getDurable(K.voiceId)
  const key = provider === 'elevenlabs' ? await getDurable(K.elApiKey) : await getDurable(K.apiKey)
  return { native: isNative, provider, voiceLen: voice.length, keyLen: key.length }
}

// Ready = turned on AND the active provider has the minimum to make a call.
export const isTtsReady = (c: TtsConfig = getTtsConfig()): boolean => {
  if (!c.enabled) return false
  return c.provider === 'elevenlabs'
    ? c.elApiKey.length > 0 && c.elVoiceId.length > 0
    : c.apiKey.length > 0 && c.voiceId.length > 0
}
