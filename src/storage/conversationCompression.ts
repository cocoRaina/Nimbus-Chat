import type { ChatMessage } from '../types'
import { fetchOpenRouter } from '../api/openrouter'
import { supabase } from '../supabase/client'

const DEFAULT_SUMMARIZER_MODEL = 'deepseek/deepseek-chat-v3.1'
const DEFAULT_CONTEXT_LIMIT = 128_000
const MIN_KEEP_RECENT = 4
const MIN_EXTRA_OLD_FOR_COMPRESSION = 4
const MIN_NEW_MESSAGES_BEFORE_RESUMMARIZE = 8
// Hard cap on the anchored recent window — a safety fuse so a wedged
// compression cursor can't let the window grow without bound. Normal
// steady-state never reaches this (compression re-fires well before it).
const RECENT_WINDOW_HARD_CAP = 120

// Token estimate, CJK-aware. Claude's tokenizer is very inefficient for CJK:
// a Chinese/Japanese/Korean character is ~1.5–2 tokens, whereas Latin text is
// ~4 chars/token. A flat chars/3 therefore badly UNDER-counts Chinese-heavy
// chats — e.g. a 72k-char / 62%-CJK conversation reads as ~24k here while
// Anthropic actually sees ~100k. That made the compression trigger (0.35 ×
// 200k = 70k) never fire, so the entire history rode every request: invisible
// while the prompt cache hit, but a brutal full-price cold write the moment the
// relay rotated upstream keys and the cache missed (every turn re-writing
// ~108k instead of a compressed ~20k). Count CJK at ~1.5 tokens and the rest at
// ~1/4, erring high so we compress in time.
export const estimateTokens = (text: string): number => {
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (
      (c >= 0x3000 && c <= 0x9fff) || // CJK punctuation, kana, Unified Ideographs
      (c >= 0xac00 && c <= 0xd7af) || // Hangul syllables
      (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
      (c >= 0xff00 && c <= 0xffef)    // full-width forms
    ) cjk++
  }
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4)
}

// A full-size image is roughly 1.6k tokens; err high (like estimateTokens)
// so image-heavy chats trigger compression early rather than blowing past
// the context limit / paying a big cold request first.
const IMAGE_TOKEN_FALLBACK = 1600

const estimateImageTokens = (att: { width?: number; height?: number }): number => {
  if (att.width && att.height) {
    // Anthropic's vision cost ≈ (width × height) / 750 tokens, clamped to a
    // sane ceiling so a bogus dimension can't dominate the estimate.
    return Math.min(Math.ceil((att.width * att.height) / 750), 4800)
  }
  return IMAGE_TOKEN_FALLBACK
}

const estimateMessagesTokens = (messages: ChatMessage[]): number => {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content)
    // Image attachments cost real tokens but carry no text — count them so
    // the trigger fires on time for chats with lots of images.
    for (const att of msg.meta?.attachments ?? []) {
      if (att.type === 'image') total += estimateImageTokens(att)
    }
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

// Summarizer models occasionally refuse ("你好，我无法给到相关内容。") and
// that refusal used to be saved as the summary — from then on every send
// injected the refusal instead of the real history, and the next incremental
// pass folded new messages into it, permanently losing the old summary.
// Detect refusal/garbage output so it is never trusted: not saved, and an
// already-poisoned cache row is ignored (self-heals on the next re-summarize).
const looksLikeRefusalOrGarbage = (text: string): boolean => {
  const t = text.trim()
  // ≥8 messages can't legitimately compress to under 30 chars.
  if (t.length < 30) return true
  const refusalPattern =
    /无法(提供|给到|协助|帮助|处理|生成|继续)|不能(提供|协助|帮助|生成)|抱歉|对不起|很遗憾|拒绝(回答|提供)|(i\s*)?(can\s*not|can't|cannot|unable to)\s|(i'?m\s*)?sorry/i
  // A real summary can mention "她说抱歉" mid-text; refusals are short and
  // lead with the refusal — only treat a match as fatal on short output.
  return t.length < 150 && refusalPattern.test(t)
}

const buildSummarizerUserPrompt = (
  existingSummary: string,
  newMessages: ChatMessage[],
): string => {
  const chunkText = newMessages
    .map((m) => {
      // Assistant turns that ran tools carry a frozen digest in meta —
      // include it so tool facts (已存的记忆/已约的提醒等) survive compression
      // instead of being lost when these turns leave the recent window.
      const digest = m.meta?.toolDigest ? `[本轮已调用工具] ${m.meta.toolDigest}\n` : ''
      return `${m.role.toUpperCase()}: ${digest}${m.content}`
    })
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

const summarizeMessagesOnce = async (
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
  if (looksLikeRefusalOrGarbage(text)) {
    throw new Error(`summarizer refused / returned garbage: ${text.slice(0, 60)}`)
  }
  return text
}

const summarizeMessages = async (
  summarizerModel: string,
  existingSummary: string,
  newMessages: ChatMessage[],
  summarizerProvider: 'openrouter' | 'msuicode',
): Promise<string> => {
  try {
    return await summarizeMessagesOnce(summarizerModel, existingSummary, newMessages, summarizerProvider)
  } catch (firstError) {
    // Refusals are usually transient (sampling / upstream rotation) — one
    // retry rescues most of them. Still failing → caller sends uncompressed
    // this turn and retries next send; the existing cache stays untouched.
    console.warn('对话摘要第一次生成失败，重试一次', firstError)
    return summarizeMessagesOnce(summarizerModel, existingSummary, newMessages, summarizerProvider)
  }
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
  const keepRecent = Math.max(MIN_KEEP_RECENT, settings.keepRecentMessages)
  if (fullHistory.length <= keepRecent + MIN_EXTRA_OLD_FOR_COMPRESSION) {
    return baseResult
  }

  // The trigger gate only decides whether to do the EXPENSIVE work of
  // generating / refreshing a summary. Reusing a summary that already exists
  // is free, so once the user has compressed a conversation we honour it on
  // every send regardless of this estimate — otherwise a manual "压缩对话" got
  // silently ignored at send time and the full history rode along anyway.
  let overTrigger = settings.force === true
  if (!overTrigger) {
    const contextLimit = estimateModelContextLimit(model)
    const triggerTokens = Math.floor(contextLimit * Math.max(0.1, Math.min(0.95, settings.triggerRatio)))
    overTrigger =
      estimateTokens(systemPromptText) + estimateMessagesTokens(fullHistory) >= triggerTokens
  }

  const oldEndIdx = fullHistory.length - keepRecent - 1
  const oldMessages = fullHistory.slice(0, oldEndIdx + 1)
  const recentMessages = fullHistory.slice(oldEndIdx + 1)
  const boundaryMessageId = fullHistory[oldEndIdx].id

  let cachedSummary = ''
  let newOldMessages = oldMessages
  try {
    const cache = await loadCompressionCache(conversationId)
    // A cache row that is itself a refusal (poisoned before the guard in
    // summarizeMessages existed) is worse than no cache: treat it as absent
    // so the next over-trigger regenerates the summary from the full old
    // history instead of reusing / building on the refusal.
    if (cache?.summary_text && looksLikeRefusalOrGarbage(cache.summary_text)) {
      console.warn('compression cache 内容疑似拒答，忽略并等待重新生成')
      cache.summary_text = ''
    }
    if (cache?.summary_text && cache.compressed_up_to_message_id) {
      const cacheIdx = oldMessages.findIndex(
        (m) => m.id === cache.compressed_up_to_message_id,
      )
      if (cacheIdx >= 0) {
        const messagesSinceCache = oldMessages.length - cacheIdx - 1
        // Use the existing summary as-is when there's little new to fold in,
        // OR whenever we're below the trigger — i.e. don't pay to refine a
        // summary for a small context, but still SEND the one we already have.
        if (messagesSinceCache < MIN_NEW_MESSAGES_BEFORE_RESUMMARIZE || !overTrigger) {
          // Anchor the recent window to the compression cursor instead of a
          // sliding "last N" slice. Two wins:
          //   1) Cache: the window's first message stays put until the cursor
          //      advances (next re-summarize), so the BP4/HEAD prefix is byte-
          //      stable across sends instead of shifting one message per turn.
          //   2) Continuity: the window starts exactly where the summary ends
          //      (cursor + 1), so the messages between the old summary boundary
          //      and a "last N" start can't fall into a gap that's neither
          //      summarised nor shown. Hard cap is a safety fuse only.
          const anchored = fullHistory.slice(cacheIdx + 1)
          const cappedRecent =
            anchored.length > RECENT_WINDOW_HARD_CAP
              ? anchored.slice(-RECENT_WINDOW_HARD_CAP)
              : anchored
          return {
            systemPromptText,
            recentMessages: cappedRecent.length > 0 ? cappedRecent : recentMessages,
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

  // No usable summary yet, and the context is still small (and not forced) —
  // leave history uncompressed rather than paying to summarise prematurely.
  if (!overTrigger) {
    return baseResult
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
