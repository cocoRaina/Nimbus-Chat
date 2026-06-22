import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

// TTS config. Two providers, fields stored separately so switching between
// them doesn't clobber either's settings. Keys live only on-device (like the
// other API keys) — never committed, only sent to our own `tts` edge function.
//
// Storage layering (and why it's not just localStorage):
//   1. `mem` — a module-level in-memory cache, the SYNCHRONOUS source of truth.
//      getTtsConfig()/isTtsReady() read this, so they never depend on
//      localStorage succeeding.
//   2. Capacitor Preferences (native SharedPreferences) — the DURABLE store on
//      Android. Survives background kills, unlike a not-yet-flushed localStorage
//      write (same hazard handled in supabase/authStorage.ts).
//   3. localStorage — a best-effort web mirror, written in a try/catch.
//
// The localStorage layer is deliberately fault-tolerant: the WebView's
// localStorage can be FULL (QuotaExceededError) from chat caches etc., and a
// raw setItem there throws. Earlier that thrown quota error aborted the whole
// save before the durable Preferences write ran — which is exactly why typed
// keys silently refused to persist. Now localStorage failures are swallowed and
// Preferences + mem still get the value.
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

// Synchronous in-memory source of truth (see header).
const mem: Record<string, string> = {}

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

// Best-effort localStorage write; never throws (it may be full / disabled).
const safeLocalSet = (k: string, v: string) => {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(k, v)
  } catch { /* quota exceeded / private mode — mem + Preferences still hold it */ }
}

const safeLocalGet = (k: string): string | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(k) : null
  } catch { return null }
}

// Read prefers the in-memory cache; falls back to localStorage (pre-hydrate /
// web). Empty string in mem is a real "cleared" value and is honoured.
const read = (k: string): string => {
  const v = k in mem ? mem[k] : (safeLocalGet(k) ?? '')
  return v.trim()
}

// Write one key everywhere: mem (sync), localStorage (best-effort), and — on
// native — durable Preferences (fire-and-forget for autosave).
const writeKey = (k: string, v: string) => {
  mem[k] = v
  safeLocalSet(k, v)
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

// Explicit, AWAITED save used by the Save button. Resolves only after every
// value is committed to native Preferences (durable) — so when "已保存" shows,
// the data is guaranteed on disk even if the app is killed the moment after.
// localStorage failures (full quota) are swallowed; they don't block the save.
export const commitTtsConfig = async (c: TtsConfig): Promise<void> => {
  for (const [k, v] of toPairs(c)) {
    mem[k] = v
    safeLocalSet(k, v)
  }
  if (isNative) await Promise.all(toPairs(c).map(([k, v]) => Preferences.set({ key: k, value: v })))
}

// Load the durable copy into the in-memory cache on every app / WebView load,
// BEFORE anything reads TTS config. No-op semantics on web (reads localStorage
// into mem). Also migrates any pre-existing localStorage-only value into the
// durable store so shipping this doesn't lose what was already entered.
export const hydrateTtsConfig = async (): Promise<void> => {
  if (typeof window === 'undefined') return
  if (!isNative) {
    for (const k of ALL_KEYS) {
      const v = safeLocalGet(k)
      if (v !== null) mem[k] = v
    }
    return
  }
  await Promise.all(
    ALL_KEYS.map(async (k) => {
      const { value } = await Preferences.get({ key: k })
      if (value !== null) {
        mem[k] = value
        safeLocalSet(k, value)
        return
      }
      // Nothing durable yet — adopt any legacy localStorage value.
      const legacy = safeLocalGet(k)
      if (legacy !== null) {
        mem[k] = legacy
        await Preferences.set({ key: k, value: legacy })
      }
    }),
  )
}

// Diagnostic: read the active provider's voice id + api key back from the
// DURABLE store (Preferences on native, localStorage on web) and report their
// lengths, so the settings UI can prove whether a save actually landed.
export const readbackTtsActive = async (): Promise<{
  native: boolean; provider: TtsProvider; voiceLen: number; keyLen: number
}> => {
  const getDurable = async (k: string): Promise<string> => {
    if (isNative) return ((await Preferences.get({ key: k })).value ?? '').trim()
    return (safeLocalGet(k) ?? '').trim()
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
