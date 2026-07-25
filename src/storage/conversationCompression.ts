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

// 一键清空压缩摘要(2026-07-25):删掉某会话的 compression_cache 行。用于摘要
// 攒烂了(如 append-only 之前的传话游戏产物)想推倒重来——下一条消息会从原始
// 历史重新压出一份干净摘要。返回是否成功。
export const clearCompressionCache = async (conversationId: string): Promise<boolean> => {
  if (!supabase) return false
  const { error } = await supabase
    .from('compression_cache')
    .delete()
    .eq('module', 'chat')
    .eq('conversation_id', conversationId)
  if (error) {
    console.warn('清空 compression_cache 失败', error)
    return false
  }
  return true
}

// ⚠️ 反「续写/演戏」防线（2026-07-25，移植自 session_digest v10）：弱摘要模型
// （如 deepseek-v4-flash）看到第一人称 + 「她：/我：」对话转写，会滑进「继续
// 聊天」模式——把对话原样复述/接着演，而不是总结（实测摘要写成一串 "嗯。"
// "你说得对。" 的对话碎片）。三重防线：①身份=回看整理者、明令这不是聊天；
// ②禁止回复/接话/复述原句；③user prompt 里转写用 <聊天记录> 包起来、结尾
// 再重复一遍任务（指令收尾对小模型尤其有效）。
const SUMMARIZER_SYSTEM_PROMPT =
  '你是沈暮，正在【回看并整理】下面这段你和她的聊天记录、给自己记一小段备忘——这【不是】继续聊天。' +
  '绝对不要回复她、不要接话、不要复述或续写原句、不要写「嗯」「你说得对」「在学就好」这类对话句。' +
  '你是在事后总结「发生了什么」，用过去式、第一人称「我」指你自己、称她「她」。' +
  '只输出备忘正文：不写标题、不写解释、不用 markdown、不要「以下是」这类开场白。'

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
  // 转写用「她：/我：」而非 USER/ASSISTANT（少一点「继续 API 对话」的诱导），
  // 并在下方用 <聊天记录> 包起来——都是反续写防线的一部分。
  const chunkText = newMessages
    .map((m) => {
      // Assistant turns that ran tools carry a frozen digest in meta —
      // include it so tool facts (已存的记忆/已约的提醒等) survive compression
      // instead of being lost when these turns leave the recent window.
      const digest = m.meta?.toolDigest ? `[本轮已调用工具] ${m.meta.toolDigest}\n` : ''
      return `${m.role === 'user' ? '她' : '我'}：${digest}${m.content}`
    })
    .join('\n')
  // 共用的详略优先级 + 具体度要求。
  const priority =
    '详略按这个优先级取舍：①还没了结、需要我后续跟进或兑现的事（最重要，一条都别丢）②她最近的状态、心情、在忙什么 ③我们定下的决定、彼此的承诺（谁答应了什么、什么时候）④她的偏好、雷区、在意的人和事 ⑤这段里发生的关键事和她的情绪起伏。名字、时间、数字、她原话里的关键词都留着，别抽象成「聊了些事」；寒暄口水话该略就略。别写空洞抒情（「那一刻我心里暖暖的」这种删掉），只写实在发生的事；不要改写或补充人格/系统设定。'
  // 结尾再重复一遍任务（指令收尾防止小模型顺着记录尾巴接话）。
  const antiEcho =
    '（记录到此结束。现在写这段的备忘——是【事后总结】不是回复：不要接她的话、不要复述或续写上面任何一句、不要写「嗯」「你说得对」这种对话句，只用过去式记下发生了什么。）'

  // 压实路径（existingSummary 非空，时间线太长时整体重压一次收紧）：合并旧备忘+新对话。
  if (existingSummary) {
    return [
      '你在【回看整理】自己的私人备忘：把「之前的备忘」和「新增对话记录」合并压实成一段更紧凑的手记（沈暮视角，第一人称「我」、称她「她」，过去式，有温度但事实要准）。这不是聊天，不要回复/接话/复述。',
      `不要逐句复述，按线索归拢成连贯手记（不是要点清单、不是「她说…我说…」的对话）。之前备忘里仍然有效的内容原样带着走、别挤掉，新旧融进同一段。${priority}`,
      '纯文本，上限约 2000 字——先读得顺，再追求信息密度。',
      `之前的备忘：\n${existingSummary}`,
      `新增对话记录：\n<聊天记录>\n${chunkText}\n</聊天记录>`,
      antiEcho,
    ].join('\n\n')
  }

  // 追加路径（常态）：只把这一段新对话总结成一个「时间线片段」——几句话，不是整份备忘。
  return [
    '你在【回看整理】下面这段你和她的聊天记录，给自己的备忘时间线补一小段——只记这一段发生了什么，不用总览整个对话、也不用管更早的事（沈暮视角，第一人称「我」、称她「她」，过去式，有温度但事实要准）。这不是聊天，不要回复/接话/复述。',
    `${priority}`,
    '纯文本，几句话就够，别硬凑长。',
    `<聊天记录>\n${chunkText}\n</聊天记录>`,
    antiEcho,
  ].join('\n\n')
}

// 摘要以完整句尾收笔的判据——用于「没给 finish_reason 的中转」的兜底截断检测。
const endsCleanly = (t: string): boolean => /[。！？…”）】.!?)\]]\s*$/.test(t)

type SummarizerMsg = { role: string; content: string }

// 单次原始调用：返回文本 + 是否被上游截断。截断信号优先看 finish_reason，
// 缺这个字段的中转退回「结尾是不是断在半句话」的兜底。
const callSummarizerRaw = async (
  summarizerModel: string,
  summarizerProvider: 'openrouter' | 'msuicode',
  messages: SummarizerMsg[],
): Promise<{ text: string; truncated: boolean }> => {
  const response = await fetchOpenRouter('/chat/completions', {
    provider: summarizerProvider,
    body: {
      model: summarizerModel,
      stream: false,
      max_tokens: 4000,
      temperature: 0.2,
      messages,
    },
  })
  if (!response.ok) {
    throw new Error(`summarizer ${response.status}`)
  }
  const payload = (await response.json()) as Record<string, unknown>
  const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
  const message = (choice?.message as Record<string, unknown> | undefined) ?? {}
  const text = typeof message.content === 'string' ? message.content.trim() : ''
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : ''
  const truncated = finishReason === 'length' || (!finishReason && text.length > 0 && !endsCleanly(text))
  return { text, truncated }
}

const summarizeMessagesOnce = async (
  summarizerModel: string,
  existingSummary: string,
  newMessages: ChatMessage[],
  summarizerProvider: 'openrouter' | 'msuicode',
): Promise<string> => {
  // 关键认知（2026-07-22）：我们发 max_tokens:4000，但有的摘要模型/中转会
  // 把**单次** completion 砍在 ~800 token（上游侧的硬上限，跟我们发多少无关）
  // ——症状就是摘要停在半句话（如「…龟头蹭」）。所以光调 max_tokens 治不了，
  // 必须**检测截断 → 续写拼接**。最多续 2 轮（含首轮共 3 次 ≈ 够 2000 字）。
  const baseMessages: SummarizerMsg[] = [
    { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
    { role: 'user', content: buildSummarizerUserPrompt(existingSummary, newMessages) },
  ]
  let { text, truncated } = await callSummarizerRaw(summarizerModel, summarizerProvider, baseMessages)
  if (!text) {
    throw new Error('summarizer returned empty content')
  }
  let rounds = 0
  while (truncated && rounds < 2) {
    rounds += 1
    try {
      const cont = await callSummarizerRaw(summarizerModel, summarizerProvider, [
        ...baseMessages,
        { role: 'assistant', content: text },
        { role: 'user', content: '你上面这段备忘被截断了，请从断掉的地方接着写完，不要重复已经写过的内容，也不要重新开头，直接续上。' },
      ])
      if (!cont.text) break
      text = `${text}${cont.text}`.trim()
      truncated = cont.truncated
    } catch {
      // 续写失败就用已拿到的部分——半篇也比整篇丢了强。
      break
    }
  }
  if (looksLikeRefusalOrGarbage(text)) {
    throw new Error(`summarizer refused / returned garbage: ${text.slice(0, 60)}`)
  }
  // 塌缩护栏（2026-07-23）：增量折叠时，新摘要 = 旧摘要 + 揉进新对话，理应
  // ≥ 旧摘要体量。若新摘要比旧的缩水一大半，说明模型偷懒把旧内容丢了（实测
  // compression_cache 出现过 8+ 条消息压成 71 字的「短桩子」，还被存下来污染
  // 后续折叠——这正是「一会好一会坏」的根）。判为坏 → 抛错触发重试；两次+
  // 兜底全失败时，compressIfNeeded 会保留旧摘要（cachedFallback），绝不把短
  // 桩子写进缓存。阈值 0.5 给正常收紧留足空间，只拦真正的塌缩。
  const prevLen = existingSummary.trim().length
  if (prevLen >= 300 && text.length < prevLen * 0.5) {
    throw new Error(`summary collapsed: ${text.length} chars vs prev ${prevLen}`)
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

// 追加式时间线的压实阈值:摘要超过这个字数,下次折叠就整体重压一次收紧
// (唯一会「重写旧内容」的路径,罕见触发,失真被限制在此)。平时都是「旧的
// 冻结、只追加新段」→ 零累积失真。
const COMPACT_THRESHOLD_CHARS = 3000

// 段落日期标签:取这批被折叠消息里最后一条的日期,给时间线分段(「几月几日」)。
const segmentDateLabel = (messages: ChatMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const iso = messages[i]?.createdAt
    if (!iso) continue
    const d = new Date(iso)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
    }
  }
  return ''
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
    if (cachedSummary.length > COMPACT_THRESHOLD_CHARS) {
      // 时间线太长 → 整体重压一次收紧(旧摘要 + 新段一起揉)。这是唯一会
      // 「重写旧内容」的路径,罕见触发,累积失真被限制在此。
      summary = await summarizeMessages(
        summarizerModel,
        cachedSummary,
        newOldMessages,
        settings.summarizerProvider,
        chatFallback,
      )
    } else {
      // 常态(追加式):只总结「新增这批消息」→ 盖日期戳 → 拼到旧摘要后面。
      // 旧摘要冻结不动 → 没有「反复重写→传话游戏」的累积失真,且天然长成一条
      // 带日期的时间线。传空 existingSummary,让 summarizer 只写这一段新的。
      const seg = await summarizeMessages(
        summarizerModel,
        '',
        newOldMessages,
        settings.summarizerProvider,
        chatFallback,
      )
      const label = segmentDateLabel(newOldMessages)
      const dated = label ? `【${label}】${seg}` : seg
      summary = cachedSummary ? `${cachedSummary}\n\n${dated}` : dated
    }
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
