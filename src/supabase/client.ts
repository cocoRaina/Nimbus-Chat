import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  clearLocalSupabaseConfig,
  readLocalSupabaseConfig,
  saveLocalSupabaseConfig,
  type SupabaseLocalConfig,
} from '../storage/supabaseConfig'

type SupabaseConfigSource = 'local' | 'env' | 'none'

const SUPABASE_CONFIG_CHANGED_EVENT = 'nibble:supabase-config-changed'

const resolveConfig = (): { config: SupabaseLocalConfig | null; source: SupabaseConfigSource } => {
  const localConfig = readLocalSupabaseConfig()
  if (localConfig) {
    return { config: localConfig, source: 'local' }
  }
  const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const envAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (envUrl?.trim() && envAnonKey?.trim()) {
    return {
      config: { url: envUrl.trim(), anonKey: envAnonKey.trim() },
      source: 'env',
    }
  }
  return { config: null, source: 'none' }
}

const createSupabaseFromConfig = (config: SupabaseLocalConfig | null): SupabaseClient | null => {
  if (!config) {
    return null
  }
  return createClient(config.url, config.anonKey, {
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
    },
  })
}

let currentResolved = resolveConfig()
export let supabase = createSupabaseFromConfig(currentResolved.config)

const emitConfigChange = () => {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent(SUPABASE_CONFIG_CHANGED_EVENT))
}

const sameConfig = (
  a: SupabaseLocalConfig | null,
  b: SupabaseLocalConfig | null,
): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.url === b.url && a.anonKey === b.anonKey
}

// Recreate the client ONLY when the resolved URL/anonKey actually changed.
// Recreating it is destructive: the old instance keeps its onAuthStateChange
// subscription and its autoRefresh timer alive, so a second instance sharing
// the same localStorage token races the first on Supabase's single-use refresh
// token. The loser gets "Invalid Refresh Token: Already Used" and emits
// SIGNED_OUT → the app drops to the login page. Making this a no-op when the
// config is unchanged means a spurious trigger (stray event, double call)
// can never orphan the live client or start a refresh race.
const refreshSupabaseClient = () => {
  const next = resolveConfig()
  if (supabase && sameConfig(next.config, currentResolved.config)) {
    currentResolved = next
    return
  }
  currentResolved = next
  supabase = createSupabaseFromConfig(currentResolved.config)
}

export const hasSupabaseConfig = () => currentResolved.source !== 'none'

// Resolved URL + anon key (local override or env), for native plugins that
// need to talk to Supabase directly (e.g. the ProactivePoll WorkManager job).
export const getSupabaseConfig = (): SupabaseLocalConfig | null => currentResolved.config

export const getSupabaseConfigSource = () => currentResolved.source

export const setLocalSupabaseConfig = (config: SupabaseLocalConfig) => {
  saveLocalSupabaseConfig(config)
  refreshSupabaseClient()
  emitConfigChange()
}

export const removeLocalSupabaseConfig = () => {
  clearLocalSupabaseConfig()
  refreshSupabaseClient()
  emitConfigChange()
}

export const subscribeSupabaseConfigChange = (listener: () => void) => {
  if (typeof window === 'undefined') {
    return () => undefined
  }
  const handler = () => {
    refreshSupabaseClient()
    listener()
  }
  window.addEventListener(SUPABASE_CONFIG_CHANGED_EVENT, handler)
  // Do NOT listen to 'storage' events: in Capacitor there is only one WebView
  // window, so storage events should never fire from another document. On some
  // Android WebView versions localStorage.setItem() (e.g. Supabase token
  // refresh) incorrectly fires 'storage' in the same window. That causes
  // refreshSupabaseClient() to create a second competing Supabase client whose
  // token refresh race invalidates the first client's refresh token → the
  // first client (which owns onAuthStateChange) emits SIGNED_OUT → login page.
  return () => {
    window.removeEventListener(SUPABASE_CONFIG_CHANGED_EVENT, handler)
  }
}
