import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

// Durable storage adapter for the Supabase auth session.
//
// Why this exists: on native (Capacitor) the WebView's localStorage is not a
// reliable place for the auth session. Supabase rotates the refresh token on
// every refresh (each token is single-use). When Android kills the app process
// from the background, the most-recent localStorage write — the freshly
// rotated token — may not have been flushed to disk yet. On the next cold
// start the app then reads a STALE, already-consumed refresh token, the
// refresh fails ("Invalid Refresh Token: Already Used"), and the user is
// silently signed out → forced back through the email-OTP login on every kill.
// (The static Supabase URL/key config survives because it was written once long
// ago and flushed; only the frequently-rewritten session token is at risk.)
//
// Capacitor Preferences writes to native SharedPreferences, which commits
// reliably and survives process death / low-memory kills, so the rotated token
// is always on disk for the next launch. On web we keep localStorage (it
// persists fine in a real browser / installed PWA).

const isNative = Capacitor.isNativePlatform()

export const supabaseAuthStorage = {
  getItem: async (key: string): Promise<string | null> => {
    if (!isNative) {
      return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null
    }
    const { value } = await Preferences.get({ key })
    if (value !== null) {
      return value
    }
    // One-time migration: a session written to WebView localStorage by a
    // previous build. Copy it into Preferences so shipping this fix doesn't
    // itself log the user out once.
    if (typeof window !== 'undefined') {
      const legacy = window.localStorage.getItem(key)
      if (legacy !== null) {
        await Preferences.set({ key, value: legacy })
        return legacy
      }
    }
    return null
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (!isNative) {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, value)
      }
      return
    }
    await Preferences.set({ key, value })
  },
  removeItem: async (key: string): Promise<void> => {
    if (!isNative) {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(key)
      }
      return
    }
    await Preferences.remove({ key })
    // Drop any legacy localStorage copy too, so a stale token can't resurface.
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(key)
    }
  },
}
