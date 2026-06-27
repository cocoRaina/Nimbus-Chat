import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

// Persisted on/off state for the cache keepalive ping. Previously this lived
// only in a React useState(true), so every app restart — and on Android, every
// background kill + reopen — reset it back to ON, silently re-enabling the ping
// the user had turned off. Now it's durable: in-memory (sync source of truth) +
// Capacitor Preferences (survives background kill) + localStorage (web mirror),
// same layering as ttsConfig.ts.
const KEY = 'nimbus_keepalive_enabled'
const isNative = Capacitor.isNativePlatform()

// Default ON — matches the historical default before this was persisted.
let mem = true

const safeLocalSet = (v: string) => {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(KEY, v)
  } catch { /* quota / private mode — mem + Preferences still hold it */ }
}

const safeLocalGet = (): string | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(KEY) : null
  } catch { return null }
}

// Synchronous read of the current value (in-memory). Call hydrateKeepalivePref()
// once on startup so this reflects the durable value, not just the default.
export const getKeepaliveEnabled = (): boolean => mem

// Write everywhere: mem (sync), localStorage (best-effort), Preferences (native).
export const setKeepaliveEnabledPref = (enabled: boolean): void => {
  mem = enabled
  const v = enabled ? '1' : '0'
  safeLocalSet(v)
  if (isNative) void Preferences.set({ key: KEY, value: v })
}

// Restore the durable value into the in-memory cache on startup. On native,
// prefer Preferences; fall back to a legacy localStorage value and promote it.
export const hydrateKeepalivePref = async (): Promise<boolean> => {
  if (typeof window === 'undefined') return mem
  if (!isNative) {
    const v = safeLocalGet()
    if (v !== null) mem = v === '1'
    return mem
  }
  const { value } = await Preferences.get({ key: KEY })
  if (value !== null) {
    mem = value === '1'
    safeLocalSet(value)
    return mem
  }
  const legacy = safeLocalGet()
  if (legacy !== null) {
    mem = legacy === '1'
    await Preferences.set({ key: KEY, value: legacy })
  }
  return mem
}
