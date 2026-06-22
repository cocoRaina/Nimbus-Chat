// TTS config. Two providers, fields stored separately so switching between
// them doesn't clobber either's settings. Keys live only in localStorage
// (like the other API keys) — never committed, only sent to our own `tts`
// edge function which relays to the chosen provider.
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
  if (typeof window === 'undefined') return
  if (c.provider !== undefined) window.localStorage.setItem(K.provider, c.provider)
  if (c.enabled !== undefined) window.localStorage.setItem(K.enabled, c.enabled ? '1' : '0')
  if (c.apiKey !== undefined) window.localStorage.setItem(K.apiKey, c.apiKey.trim())
  if (c.groupId !== undefined) window.localStorage.setItem(K.groupId, c.groupId.trim())
  if (c.voiceId !== undefined) window.localStorage.setItem(K.voiceId, c.voiceId.trim())
  if (c.baseUrl !== undefined) window.localStorage.setItem(K.baseUrl, c.baseUrl.trim())
  if (c.model !== undefined) window.localStorage.setItem(K.model, c.model.trim())
  if (c.elApiKey !== undefined) window.localStorage.setItem(K.elApiKey, c.elApiKey.trim())
  if (c.elVoiceId !== undefined) window.localStorage.setItem(K.elVoiceId, c.elVoiceId.trim())
  if (c.elModel !== undefined) window.localStorage.setItem(K.elModel, c.elModel.trim())
  if (c.elStability !== undefined) window.localStorage.setItem(K.elStability, String(c.elStability))
}

// Ready = turned on AND the active provider has the minimum to make a call.
export const isTtsReady = (c: TtsConfig = getTtsConfig()): boolean => {
  if (!c.enabled) return false
  return c.provider === 'elevenlabs'
    ? c.elApiKey.length > 0 && c.elVoiceId.length > 0
    : c.apiKey.length > 0 && c.voiceId.length > 0
}
