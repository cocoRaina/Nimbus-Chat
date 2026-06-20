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

const refreshSupabaseClient = () => {
  currentResolved = resolveConfig()
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
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(SUPABASE_CONFIG_CHANGED_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}
