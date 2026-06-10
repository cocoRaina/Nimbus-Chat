import type { UserSettings } from '../types'
import { supabase } from '../supabase/client'
import {
  DEFAULT_SNACK_SYSTEM_OVERLAY,
  DEFAULT_SYZYGY_POST_PROMPT,
  DEFAULT_SYZYGY_REPLY_PROMPT,
  resolveSnackSystemOverlay,
  resolveSyzygyPostPrompt,
  resolveSyzygyReplyPrompt,
} from '../constants/aiOverlays'

type UserSettingsRow = {
  user_id: string
  enabled_models: string[] | null
  default_model: string | null
  compression_enabled: boolean | null
  compression_trigger_ratio: number | null
  compression_keep_recent_messages: number | null
  summarizer_model: string | null
  temperature: number | null
  top_p: number | null
  max_tokens: number | null
  system_prompt: string | null
  user_home_system_prompt: string | null
  assistant_post_system_prompt: string | null
  assistant_reply_system_prompt: string | null
  enable_reasoning: boolean | null
  chat_reasoning_enabled: boolean | null
  auto_memory_extract_enabled: boolean | null
  memory_extract_model: string | null
  memory_extract_interval_hours: number | null
  last_memory_extract_at: string | null
  updated_at: string
}

type LocalPrefs = {
  chatHighReasoningEnabled: boolean
  summarizerProvider: 'openrouter' | 'msuicode'
  memoryExtractProvider: 'openrouter' | 'msuicode'
}

const HIGH_REASONING_STORAGE_KEY = 'nibble_high_reasoning_prefs_v1'

const loadLocalPrefsMap = (): Record<string, Partial<LocalPrefs>> => {
  if (typeof window === 'undefined') {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(HIGH_REASONING_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, Partial<LocalPrefs>>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const saveLocalPrefs = (userId: string, prefs: LocalPrefs) => {
  if (typeof window === 'undefined') {
    return
  }
  const current = loadLocalPrefsMap()
  current[userId] = prefs
  window.localStorage.setItem(HIGH_REASONING_STORAGE_KEY, JSON.stringify(current))
}

const resolveLocalPrefs = (userId: string): LocalPrefs => {
  const stored = loadLocalPrefsMap()[userId]
  return {
    chatHighReasoningEnabled: stored?.chatHighReasoningEnabled ?? false,
    summarizerProvider: stored?.summarizerProvider === 'msuicode' ? 'msuicode' : 'openrouter',
    memoryExtractProvider: stored?.memoryExtractProvider === 'msuicode' ? 'msuicode' : 'openrouter',
  }
}

const applyLocalPrefs = (settings: UserSettings): UserSettings => {
  const prefs = resolveLocalPrefs(settings.userId)
  return {
    ...settings,
    chatHighReasoningEnabled: prefs.chatHighReasoningEnabled,
    summarizerProvider: prefs.summarizerProvider,
    memoryExtractProvider: prefs.memoryExtractProvider,
  }
}

const defaultModel = 'openrouter/auto'

export const createDefaultSettings = (userId: string): UserSettings => ({
  userId,
  enabledModels: [defaultModel],
  defaultModel,
  compressionEnabled: true,
  compressionTriggerRatio: 0.65,
  compressionKeepRecentMessages: 20,
  summarizerModel: 'deepseek/deepseek-chat-v3.1',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 1024,
  systemPrompt: '',
  snackSystemOverlay: DEFAULT_SNACK_SYSTEM_OVERLAY,
  syzygyPostSystemPrompt: DEFAULT_SYZYGY_POST_PROMPT,
  syzygyReplySystemPrompt: DEFAULT_SYZYGY_REPLY_PROMPT,
  chatReasoningEnabled: true,
  chatHighReasoningEnabled: false,
  summarizerProvider: 'openrouter',
  autoMemoryExtractEnabled: true,
  memoryExtractModel: 'anthropic/claude-haiku-4-5',
  memoryExtractProvider: 'openrouter',
  memoryExtractIntervalHours: 6,
  lastMemoryExtractAt: null,
  updatedAt: new Date().toISOString(),
})

const mapSettingsRow = (row: UserSettingsRow): UserSettings => {
  const highReasoningPrefs = resolveLocalPrefs(row.user_id)
  return {
    userId: row.user_id,
    enabledModels: row.enabled_models ?? [defaultModel],
    defaultModel: row.default_model ?? defaultModel,
    compressionEnabled: row.compression_enabled ?? true,
    compressionTriggerRatio: row.compression_trigger_ratio ?? 0.65,
    compressionKeepRecentMessages: row.compression_keep_recent_messages ?? 20,
    summarizerModel: row.summarizer_model?.trim() ? row.summarizer_model : null,
    temperature: row.temperature ?? 0.7,
    topP: row.top_p ?? 0.9,
    maxTokens: row.max_tokens ?? 1024,
    systemPrompt: row.system_prompt ?? '',
    snackSystemOverlay: resolveSnackSystemOverlay(row.user_home_system_prompt),
    syzygyPostSystemPrompt: resolveSyzygyPostPrompt(row.assistant_post_system_prompt),
    syzygyReplySystemPrompt: resolveSyzygyReplyPrompt(row.assistant_reply_system_prompt),
    chatReasoningEnabled: row.chat_reasoning_enabled ?? row.enable_reasoning ?? true,
    chatHighReasoningEnabled: highReasoningPrefs.chatHighReasoningEnabled,
    summarizerProvider: highReasoningPrefs.summarizerProvider,
    autoMemoryExtractEnabled: row.auto_memory_extract_enabled ?? true,
    memoryExtractModel: row.memory_extract_model?.trim() || 'anthropic/claude-haiku-4-5',
    memoryExtractProvider: highReasoningPrefs.memoryExtractProvider,
    memoryExtractIntervalHours: row.memory_extract_interval_hours ?? 6,
    lastMemoryExtractAt: row.last_memory_extract_at ?? null,
    updatedAt: row.updated_at,
  }
}

export const ensureUserSettings = async (userId: string): Promise<UserSettings> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { data, error } = await supabase
    .from('user_settings')
    .select(
      'user_id,enabled_models,default_model,compression_enabled,compression_trigger_ratio,compression_keep_recent_messages,summarizer_model,temperature,top_p,max_tokens,system_prompt,user_home_system_prompt,assistant_post_system_prompt,assistant_reply_system_prompt,enable_reasoning,chat_reasoning_enabled,auto_memory_extract_enabled,memory_extract_model,memory_extract_interval_hours,last_memory_extract_at,updated_at',
    )
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    throw error
  }
  if (!data) {
    const defaults = createDefaultSettings(userId)
    const now = defaults.updatedAt
    // upsert (not insert) so two concurrent first-login calls don't collide
    // on the user_id primary key (23505) and fail settings load. On conflict
    // it just re-writes the same defaults — harmless, since this only runs
    // before any settings UI is shown.
    const { data: inserted, error: insertError } = await supabase
      .from('user_settings')
      .upsert({
        user_id: defaults.userId,
        enabled_models: defaults.enabledModels,
        default_model: defaults.defaultModel,
        compression_enabled: defaults.compressionEnabled,
        compression_trigger_ratio: defaults.compressionTriggerRatio,
        compression_keep_recent_messages: defaults.compressionKeepRecentMessages,
        summarizer_model: defaults.summarizerModel,
        temperature: defaults.temperature,
        top_p: defaults.topP,
        max_tokens: defaults.maxTokens,
        system_prompt: defaults.systemPrompt,
        user_home_system_prompt: defaults.snackSystemOverlay,
        assistant_post_system_prompt: defaults.syzygyPostSystemPrompt,
        assistant_reply_system_prompt: defaults.syzygyReplySystemPrompt,
        enable_reasoning: defaults.chatReasoningEnabled,
        chat_reasoning_enabled: defaults.chatReasoningEnabled,
        auto_memory_extract_enabled: defaults.autoMemoryExtractEnabled,
        memory_extract_model: defaults.memoryExtractModel,
        memory_extract_interval_hours: defaults.memoryExtractIntervalHours,
        updated_at: now,
      }, { onConflict: 'user_id' })
      .select(
        'user_id,enabled_models,default_model,compression_enabled,compression_trigger_ratio,compression_keep_recent_messages,summarizer_model,temperature,top_p,max_tokens,system_prompt,user_home_system_prompt,assistant_post_system_prompt,assistant_reply_system_prompt,enable_reasoning,chat_reasoning_enabled,updated_at',
      )
      .single()
    if (insertError || !inserted) {
      throw insertError ?? new Error('初始化设置失败')
    }
    return applyLocalPrefs(mapSettingsRow(inserted as UserSettingsRow))
  }
  return applyLocalPrefs(mapSettingsRow(data as UserSettingsRow))
}

export const updateUserSettings = async (settings: UserSettings): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('user_settings')
    .update({
      enabled_models: settings.enabledModels,
      default_model: settings.defaultModel,
      compression_enabled: settings.compressionEnabled,
      compression_trigger_ratio: settings.compressionTriggerRatio,
      compression_keep_recent_messages: settings.compressionKeepRecentMessages,
      summarizer_model: settings.summarizerModel,
      temperature: settings.temperature,
      top_p: settings.topP,
      max_tokens: settings.maxTokens,
      system_prompt: settings.systemPrompt,
      user_home_system_prompt: settings.snackSystemOverlay,
      assistant_post_system_prompt: settings.syzygyPostSystemPrompt,
      assistant_reply_system_prompt: settings.syzygyReplySystemPrompt,
      enable_reasoning: settings.chatReasoningEnabled,
      chat_reasoning_enabled: settings.chatReasoningEnabled,
      auto_memory_extract_enabled: settings.autoMemoryExtractEnabled,
      memory_extract_model: settings.memoryExtractModel,
      memory_extract_interval_hours: settings.memoryExtractIntervalHours,
      last_memory_extract_at: settings.lastMemoryExtractAt,
      updated_at: now,
    })
    .eq('user_id', settings.userId)
  if (error) {
    throw error
  }
  saveLocalPrefs(settings.userId, {
    chatHighReasoningEnabled: settings.chatHighReasoningEnabled,
    summarizerProvider: settings.summarizerProvider,
    memoryExtractProvider: settings.memoryExtractProvider,
  })
}

export const saveSnackSystemPrompt = async (userId: string, value: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('user_settings')
    .update({
      user_home_system_prompt: value,
      updated_at: now,
    })
    .eq('user_id', userId)
  if (error) {
    throw error
  }
}

export const saveSyzygyPostSystemPrompt = async (userId: string, value: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('user_settings')
    .update({
      assistant_post_system_prompt: value,
      updated_at: now,
    })
    .eq('user_id', userId)
  if (error) {
    throw error
  }
}

export const saveSyzygyReplySystemPrompt = async (userId: string, value: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('user_settings')
    .update({
      assistant_reply_system_prompt: value,
      updated_at: now,
    })
    .eq('user_id', userId)
  if (error) {
    throw error
  }
}
