// MiniMax TTS config. Keys live only in localStorage (like the other API
// keys) — never committed, never sent anywhere except our own `tts` edge
// function which relays to MiniMax.
const K = {
  enabled: 'nimbus_tts_enabled',
  apiKey: 'nimbus_tts_api_key',
  groupId: 'nimbus_tts_group_id',
  voiceId: 'nimbus_tts_voice_id',
  baseUrl: 'nimbus_tts_base_url',
  model: 'nimbus_tts_model',
}

export const DEFAULT_TTS_BASE = 'https://api.minimax.io'
export const DEFAULT_TTS_MODEL = 'speech-02-turbo'

export type TtsConfig = {
  enabled: boolean
  apiKey: string
  groupId: string
  voiceId: string
  baseUrl: string
  model: string
}

const read = (k: string): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(k)?.trim() ?? ''
}

export const getTtsConfig = (): TtsConfig => ({
  enabled: read(K.enabled) === '1',
  apiKey: read(K.apiKey),
  groupId: read(K.groupId),
  voiceId: read(K.voiceId),
  baseUrl: read(K.baseUrl) || DEFAULT_TTS_BASE,
  model: read(K.model) || DEFAULT_TTS_MODEL,
})

export const saveTtsConfig = (c: Partial<TtsConfig>) => {
  if (typeof window === 'undefined') return
  if (c.enabled !== undefined) window.localStorage.setItem(K.enabled, c.enabled ? '1' : '0')
  if (c.apiKey !== undefined) window.localStorage.setItem(K.apiKey, c.apiKey.trim())
  if (c.groupId !== undefined) window.localStorage.setItem(K.groupId, c.groupId.trim())
  if (c.voiceId !== undefined) window.localStorage.setItem(K.voiceId, c.voiceId.trim())
  if (c.baseUrl !== undefined) window.localStorage.setItem(K.baseUrl, c.baseUrl.trim())
  if (c.model !== undefined) window.localStorage.setItem(K.model, c.model.trim())
}

// Ready = turned on AND has the minimum to call MiniMax.
export const isTtsReady = (c: TtsConfig = getTtsConfig()): boolean =>
  c.enabled && c.apiKey.length > 0 && c.voiceId.length > 0
