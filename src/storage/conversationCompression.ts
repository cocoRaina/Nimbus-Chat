import type { ChatMessage } from '../types'
import { fetchOpenRouter } from '../api/openrouter'
import { supabase } from '../supabase/client'

const DEFAULT_SUMMARIZER_MODEL = 'deepseek/deepseek-chat-v3.1'
const DEFAULT_CONTEXT_LIMIT = 128_000
const MIN_KEEP_RECENT = 4
const MIN_EXTRA_OLD_FOR_COMPRESSION = 4
const MIN_NEW_MESSAGES_BEFORE_RESUMMARIZE = 8

// Conservative token estimate: ~3 chars per token for Chinese-heavy text,
// ~4 for English. Use 3 to err on the high side so we trigger early enough.
export const estimateTokens = (text: string): number => {
  if (!text) return 0
  return Math.ceil(text.length / 3)
}

const estimateMessagesTokens = (messages: Array<{ content: string }>): number => {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content)
  }
  // overhead per message for role + formatting
  total += messages.length * 4
  return total
}

const MODEL_CONTEXT_LIMITS: Array<[RegExp, number]> = [
  [/gpt-5|gpt-4\.1|gpt-4o/i, 128_000],
  [/claude.*(4\.[6-9]|opus|sonnet|haiku)/i, 200_000],
  [/claude/i, 200_000],
  [/gemini.*2\.5/i, 1_000_000],
  [/gemini/i, 1_000_000],
  [/grok/i, 128_000],
  [/deepseek/i, 128_000],
]

export const estimateModelContextLimit = (modelId: string): number => {
  for (const [pattern, limit] of MODEL_CONTEXT_LIMITS) {
    if (pattern.test(modelId)) return limit
  }
  return DEFAULT_CONTEXT_LIMIT
}

type CompressionCacheRow = {
  conversation_id: string
  compressed_up_to_message_id: string | null
  summary_text: string
  updated_at: string
}

const loadCompressionCache = async (
  conversationId: string,
): Promise<CompressionCacheRow | null> => {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('compression_cache')
    .select('conversation_id,compressed_up_to_message_id,summary_text,updated_at')
    .eq('module', 'chat')
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.warn('读取 compression_cache 失败', error)
    return null
  }
  return data as CompressionCacheRow | null
}

const saveCompressionCache = async (
  conversationId: string,
  summary: string,
  lastMessageId: string,
): Promise<void> => {
  if (!supabase) return
  const { error } = await supabase.from('compression_cache').upsert(
    {
      module: 'chat',
      conversation_id: conversationId,
      compressed_up_to_message_id: lastMessageId,
      summary_text: summary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'module,conversation_id' },
  )
  if (error) {
    console.warn('写入 compression_cache 失败', error)
  }
}

const SUMMARIZER_SYSTEM_PROMPT = '你负责维护对话运行时摘要。只输出最终摘要文本。'

const buildSummarizerUserPrompt = (
  existingSummary: string,
  newMessages: ChatMessage[],
): string => {
  const chunkText = newMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')
  return [
    '你是对话压缩器。请生成简洁中文摘要，保留：用户偏好、已做决定、承诺事项、未决问题、关键事件与情绪走向。',
    '不要改写或补充系统设定/人格。输出纯文本，不要 markdown。',
    '摘要长度控制在 800 字以内。',
    existingSummary ? `已有摘要：\n${existingSummary}` : '',
    `新增对话片段：\n${chunkText}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

const summarizeMessages = async (
  summarizerModel: string,
  existingSummary: string,
  newMessages: ChatMessage[],
  summarizerProvider: 'openrouter' | 'msuicode',
): Promise<string> => {
  const response = await fetchOpenRouter('/chat/completions', {
    provider: summarizerProvider,
    body: {
      model: summarizerModel,
      stream: false,
      max_tokens: 800,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
        { role: 'user', content: buildSummarizerUserPrompt(existingSummary, newMessages) },
      ],
    },
  })
  if (!response.ok) {
    throw new Error(`summarizer ${response.status}`)
  }
  const payload = (await response.json()) as Record<string, unknown>
  const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
  const message = (choice?.message as Record<string, unknown> | undefined) ?? {}
  const text = typeof message.content === 'string' ? message.content.trim() : ''
  if (!text) {
    throw new Error('summarizer returned empty content')
  }
  return text
}

export type CompressionSettings = {
  enabled: boolean
  triggerRatio: number
  keepRecentMessages: number
  summarizerModel: string | null
  summarizerProvider: 'openrouter' | 'msuicode'
  // When true, bypass the enabled flag and the token-ratio threshold.
  // Used by the manual "压缩对话" button in the chat header — still
  // respects the minimum-messages-for-compression guard because there's
  // no point summarising 3 messages.
  force?: boolean
}

export type CompressionResult = {
  systemPromptText: string
  recentMessages: ChatMessage[]
  summaryText: string | null
  didCompress: boolean
}

export const compressIfNeeded = async (
  conversationId: string,
  fullHistory: ChatMessage[],
  systemPromptText: string,
  model: string,
  settings: CompressionSettings,
): Promise<CompressionResult> => {
  const baseResult: CompressionResult = {
    systemPromptText,
    recentMessages: fullHistory,
    summaryText: null,
    didCompress: false,
  }
  if (fullHistory.length === 0) {
    return baseResult
  }
  if (!settings.force && !settings.enabled) {
    return baseResult
  }
  if (!settings.force) {
    const contextLimit = estimateModelContextLimit(model)
    const triggerTokens = Math.floor(contextLimit * Math.max(0.1, Math.min(0.95, settings.triggerRatio)))
    const systemTokens = estimateTokens(systemPromptText)
    const historyTokens = estimateMessagesTokens(fullHistory)
    if (systemTokens + historyTokens < triggerTokens) {
      return baseResult
    }
  }
  const keepRecent = Math.max(MIN_KEEP_RECENT, settings.keepRecentMessages)
  if (fullHistory.length <= keepRecent + MIN_EXTRA_OLD_FOR_COMPRESSION) {
    return baseResult
  }

  const oldEndIdx = fullHistory.length - keepRecent - 1
  const oldMessages = fullHistory.slice(0, oldEndIdx + 1)
  const recentMessages = fullHistory.slice(oldEndIdx + 1)
  const boundaryMessageId = fullHistory[oldEndIdx].id

  let cachedSummary = ''
  let newOldMessages = oldMessages
  try {
    const cache = await loadCompressionCache(conversationId)
    if (cache?.summary_text && cache.compressed_up_to_message_id) {
      const cacheIdx = oldMessages.findIndex(
        (m) => m.id === cache.compressed_up_to_message_id,
      )
      if (cacheIdx >= 0) {
        const messagesSinceCache = oldMessages.length - cacheIdx - 1
        if (messagesSinceCache < MIN_NEW_MESSAGES_BEFORE_RESUMMARIZE) {
          return {
            systemPromptText,
            recentMessages,
            summaryText: cache.summary_text,
            didCompress: true,
          }
        }
        cachedSummary = cache.summary_text
        newOldMessages = oldMessages.slice(cacheIdx + 1)
      }
    }
  } catch (error) {
    console.warn('compression cache 读取失败，按未压缩处理', error)
  }

  const summarizerModel = settings.summarizerModel?.trim() || DEFAULT_SUMMARIZER_MODEL
  let summary: string
  try {
    summary = await summarizeMessages(summarizerModel, cachedSummary, newOldMessages, settings.summarizerProvider)
  } catch (error) {
    console.warn('对话摘要生成失败，按未压缩处理', error)
    return baseResult
  }

  void saveCompressionCache(conversationId, summary, boundaryMessageId)

  return {
    systemPromptText,
    recentMessages,
    summaryText: summary,
    didCompress: true,
  }
}
