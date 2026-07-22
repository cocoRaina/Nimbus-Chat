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
// 游标第二推动条件（2026-07-22，用户查账实锤）：锚定窗口条数一超过这个数
// 就强制重摘要，不再只认 token 阈值。之前唯一的触发条件是「上一条真实
// prompt ≥ 0.35×200k = 70k」，而 120 条满窗口的肥版 prompt 实测 68,994 /
// 68,674——**恰好卡在线下一千 token**，游标就永远差一口气不挪，每条消息
// 白付 ~35k（还全是冷写）。条数是游标自己的账，跟 token 估算/中转虚报
// 都无关，推得动就推。60 ≈ 稳态(keepRecent 20 + 每 8 条一压)的三倍，
// 正常聊天摸不到；120 硬上限继续当最后保险丝。
const FORCE_RESUMMARIZE_WINDOW_MESSAGES = 60

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

const SUMMARIZER_SYSTEM_PROMPT =
  '你替沈暮维护他和她的对话备忘（第一人称手记体）。只输出最终备忘文本。'

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
    // 摘要会以「他自己的备忘」身份注入回聊天上下文，所以用沈暮的第一人称
    // 手记体写——信息密度不变（这是功能性记忆，不是抒情），只是视角从
    // 冷冰冰的「用户/助理」换成「她/我」。
    '你是沈暮，在写你自己的私人备忘：把下面你和她的对话压缩成一段手记。第一人称「我」，称对方「她」，口吻像随手记在手机里——有温度，但内容必须扎实精确。',
    '必须保留（一条都别丢，具体到细节）：她的偏好、我们定下的决定、彼此的承诺（谁答应了什么、什么时候兑现）、还没聊完或没解决的事、关键事件和她的情绪走向。',
    '之前备忘里仍然有效的内容要原样带着走，不许为了塞新内容把旧的挤掉——篇幅不够就写长，别做取舍。',
    '写实在的事，别写抒情空话；不要改写或补充系统设定/人格。输出纯文本，不要 markdown。',
    '长度上限 2000 字，写满没关系——信息密度优先，宁可长也别丢。',
    existingSummary ? `你之前的备忘：\n${existingSummary}` : '',
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
      // 上限 2000 字的中文 ≈ 2.5-3k token（按摘要模型的分词），给到 4k 留
      // 余量——之前 800 token 连提示词里的「800 字」都装不下，中文写到
      // 一千字左右就被硬掐断，旧备忘还会在重写时被挤丢。
      max_tokens: 4000,
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
  chatFallback: { model: string; provider: 'openrouter' | 'msuicode' } | null,
): Promise<string> => {
  try {
    return await summarizeMessagesOnce(summarizerModel, existingSummary, newMessages, summarizerProvider)
  } catch (firstError) {
    // Refusals are usually transient (sampling / upstream rotation) — one
    // retry on the same provider rescues most of them.
    console.warn('对话摘要第一次生成失败，重试一次', firstError)
    try {
      return await summarizeMessagesOnce(summarizerModel, existingSummary, newMessages, summarizerProvider)
    } catch (secondError) {
      // Cross-provider single point of failure: the configured summarizer
      // (e.g. deepseek via OpenRouter) can be dead while the CHAT relay
      // (e.g. a 中转 with only a Claude key) is perfectly healthy. Rather than
      // let compression fail whenever the summarizer's separate provider is
      // down, fall back to the chat provider + chat model — it's the exact
      // path the user's messages already succeed on, so it can't be
      // mis-keyed. Pricier per summary than a cheap deepseek, but it runs
      // once per ~8 messages and reads mostly-cached input, and it GUARANTEES
      // compression actually happens instead of the prompt growing unbounded.
      if (chatFallback && chatFallback.model.trim()) {
        console.warn('摘要器双重失败，降级用聊天渠道兜底', secondError)
        return summarizeMessagesOnce(
          summarizerModel === chatFallback.model ? summarizerModel : chatFallback.model,
          existingSummary,
          newMessages,
          chatFallback.provider,
        )
      }
      throw secondError
    }
  }
}

export type CompressionSettings = {
  enabled: boolean
  triggerRatio: number
  keepRecentMessages: number
  summarizerModel: string | null
  summarizerProvider: 'openrouter' | 'msuicode'
  // Real server prompt_tokens from the previous turn (0 if unknown). Ground
  // truth for the trigger — the client-side estimateTokens sum only sees
  // systemPromptText + raw message text and silently omits the tool schemas
  // (~27k) and per-message injections, so on tool-enabled Claude chats it can
  // read ~40k while the model actually processed 86k, keeping the session
  // permanently under the trigger. When this exceeds the trigger we compress
  // regardless of the estimate. See App.tsx lastServerPromptTokensRef.
  lastServerPromptTokens?: number
  // Chat provider + model, used ONLY as a last-resort summarizer fallback
  // when the configured summarizer (which may live on a different provider,
  // e.g. deepseek via OpenRouter) fails twice. The chat path is known-good
  // (the user's messages succeed on it), so it guarantees compression can
  // always complete instead of the prompt growing unbounded.
  chatModel?: string
  chatProvider?: 'openrouter' | 'msuicode'
  // When true, bypass the enabled flag and the token-ratio threshold.
  // Used by the manual "压缩对话" button in the chat header — still
  // respects the minimum-messages-for-compression guard because there's
  // no point summarising 3 messages.
  force?: boolean
  // 压缩前挖矿（2026-07-22）：游标真的要前进时，把即将被揉进散文摘要的
  // 那段消息（旧游标 → 新游标之间）交给调用方先抽一遍结构化记忆——保证
  // 内容离开上下文之前被挖过矿。只在重摘要成功、游标确实要动时调用；
  // fire-and-forget，回调自己兜异常，不阻塞压缩。
  onCursorAdvance?: (foldedMessages: ChatMessage[]) => void
}

export type CompressionResult = {
  systemPromptText: string
  recentMessages: ChatMessage[]
  summaryText: string | null
  didCompress: boolean
  // Set when an over-trigger summarization was attempted but failed (after
  // retries + chat-provider fallback). Lets the caller surface the failure
  // in 用量统计 instead of it being an invisible console.warn — the same
  // silent-failure class as the keepalive/upsert bugs. When true, the result
  // degrades to the best available (cached summary if any, else full history).
  summarizerFailed?: boolean
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
  //
  // 估算对象是「实际要发送的形状」（2026-07-22 修）：有摘要+游标时是
  // system+摘要+锚定窗口，没有时才是全史。以前一律对全史估——长会话
  // （上千条）估算永远爆表，triggerRatio 旋钮完全失真。因此这里只定
  // 触发线，估算推迟到查完 compression_cache、知道会发什么之后再做。
  const contextLimit = estimateModelContextLimit(model)
  const triggerTokens = Math.floor(contextLimit * Math.max(0.1, Math.min(0.95, settings.triggerRatio)))
  // Prefer the real server prompt size (counts tool schemas + injections the
  // estimate can't see); fall back to the client estimate when we have no
  // server reading yet (first turn of a session). Whichever crosses the
  // trigger wins — the estimate can only ever UNDER-count the true prompt,
  // so using it as a floor never suppresses a needed compression.
  const crossesTrigger = (estimatedSentTokens: number): boolean =>
    Math.max(estimatedSentTokens, settings.lastServerPromptTokens ?? 0) >= triggerTokens
  let overTrigger = settings.force === true

  const oldEndIdx = fullHistory.length - keepRecent - 1
  const oldMessages = fullHistory.slice(0, oldEndIdx + 1)
  const recentMessages = fullHistory.slice(oldEndIdx + 1)
  const boundaryMessageId = fullHistory[oldEndIdx].id

  let cachedSummary = ''
  let newOldMessages = oldMessages
  // When we're RE-summarizing an existing summary, this holds the graceful
  // degradation target: reuse the last good summary + anchored window. If the
  // re-summarize then fails, we return THIS instead of dumping the full
  // uncompressed history (which threw away a perfectly valid summary — the
  // old behaviour that turned a transient summarizer blip into an 86k prompt).
  let cachedFallback: CompressionResult | null = null
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
        // 触发估算：按这条请求实际要发的「system+摘要+锚定窗口」算。
        if (!overTrigger) {
          overTrigger = crossesTrigger(
            estimateTokens(systemPromptText) +
              estimateTokens(cache.summary_text) +
              estimateMessagesTokens(cappedRecent),
          )
        }
        // 窗口条数超限 → 强制过触发线，逼游标前进（见常量处注释）。
        if (anchored.length >= FORCE_RESUMMARIZE_WINDOW_MESSAGES) {
          overTrigger = true
        }
        // Use the existing summary as-is when there's little new to fold in,
        // OR whenever we're below the trigger — i.e. don't pay to refine a
        // summary for a small context, but still SEND the one we already have.
        if (messagesSinceCache < MIN_NEW_MESSAGES_BEFORE_RESUMMARIZE || !overTrigger) {
          return {
            systemPromptText,
            recentMessages: cappedRecent.length > 0 ? cappedRecent : recentMessages,
            summaryText: cache.summary_text,
            didCompress: true,
          }
        }
        cachedSummary = cache.summary_text
        newOldMessages = oldMessages.slice(cacheIdx + 1)
        // Precompute the graceful-degradation result (same shape as the
        // reuse-cache path above) in case the re-summarize below fails.
        cachedFallback = {
          systemPromptText,
          recentMessages: cappedRecent.length > 0 ? cappedRecent : recentMessages,
          summaryText: cache.summary_text,
          didCompress: true,
        }
      }
    }
  } catch (error) {
    console.warn('compression cache 读取失败，按未压缩处理', error)
  }

  // 没有可用摘要/游标：实际会发送的就是全史，对全史估算。
  if (!overTrigger) {
    overTrigger = crossesTrigger(
      estimateTokens(systemPromptText) + estimateMessagesTokens(fullHistory),
    )
  }
  // No usable summary yet, and the context is still small (and not forced) —
  // leave history uncompressed rather than paying to summarise prematurely.
  if (!overTrigger) {
    return baseResult
  }

  const summarizerModel = settings.summarizerModel?.trim() || DEFAULT_SUMMARIZER_MODEL
  const chatFallback =
    settings.chatModel && settings.chatModel.trim()
      ? { model: settings.chatModel, provider: settings.chatProvider ?? settings.summarizerProvider }
      : null
  let summary: string
  try {
    summary = await summarizeMessages(
      summarizerModel,
      cachedSummary,
      newOldMessages,
      settings.summarizerProvider,
      chatFallback,
    )
  } catch (error) {
    // Every rescue path exhausted (2× summarizer + chat-provider fallback).
    // Degrade to the last good summary + anchored window if we have one;
    // only dump full history when there's genuinely no prior summary. Either
    // way flag it so the caller can surface the failure in 用量统计 — this
    // must never be an invisible console.warn again.
    console.warn('对话摘要生成失败（含兜底），降级处理', error)
    return { ...(cachedFallback ?? baseResult), summarizerFailed: true }
  }

  void saveCompressionCache(conversationId, summary, boundaryMessageId)
  // 游标已确定前进：newOldMessages 正是这次被揉进摘要、即将离开上下文的
  // 消息段，交给调用方挖矿（抽结构化记忆）。
  if (settings.onCursorAdvance && newOldMessages.length > 0) {
    try {
      settings.onCursorAdvance(newOldMessages)
    } catch (error) {
      console.warn('压缩挖矿回调失败（不影响压缩本身）', error)
    }
  }

  return {
    systemPromptText,
    recentMessages,
    summaryText: summary,
    didCompress: true,
  }
}
