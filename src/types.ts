export type ChatSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  isArchived: boolean
  archivedAt: string | null
  overrideModel?: string | null
  overrideReasoning?: boolean | null
}

export type MessageAttachment =
  | { type: 'image'; url: string; width?: number; height?: number }
  | { type: 'voice'; url: string; duration?: number; transcription?: string; emotion?: string; waveform?: number[] }

export type ChatMessage = {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  clientId: string
  clientCreatedAt: string | null
  meta?: {
    provider?: string
    model?: string
    streaming?: boolean
    reasoning?: string
    reasoning_text?: string
    reasoning_type?: 'reasoning' | 'thinking'
    params?: {
      temperature?: number
      top_p?: number
      max_tokens?: number
    }
    attachments?: MessageAttachment[]
    weather?: {
      temperatureC: number
      condition: string
      feelsLikeC?: number
      city?: string
      windKmh?: number
    }
    healthSnapshot?: string
    deviceSnapshot?: string
    // Frozen mood narration for this user turn (the AI's private emotional
    // state when this message was sent). Rendered into the payload prefix at
    // send time like the weather/env snapshots — kept per-message so replay is
    // byte-stable and doesn't break the rolling prompt cache.
    moodNarration?: string
    // Per-message ambient phone state: battery + charging + ringer + audio
    // output + Wi-Fi/cellular, e.g. "🔋32%充电中 · 静音 · 蓝牙:AirPods · Wi-Fi".
    envSnapshot?: string
    // 用户对某条 assistant 消息的表情回应（Telegram 式双向）：这条 user 消息
    // 内容本身是 `[react:emoji] 「摘录」`（UI 隐藏成气泡角标），reactTo 记
    // 目标消息的 clientId 供渲染归属。创建时冻结、从不更新 → 重放逐字节稳定。
    reactTo?: { id: string; excerpt?: string }
    // Frozen auto-recall line for this user turn: top memory-search hits for
    // this message, injected into the payload prefix like weather. Kept
    // per-message so replay is byte-stable for the rolling prompt cache.
    memoryRecall?: string
    // 开场简报（当天第一轮冻结）：昨日 session_digest 摘录 + 最新交接信一行，
    // 注入 payload 前缀（[昨日回顾]）。逐消息冻结 → 重放字节稳定。
    dayBrief?: string
    tool_calls?: Array<{
      name: string
      args: unknown
      result: unknown
      duration_ms?: number
      timestamp?: string
    }>
    // Compact frozen digest of this turn's tool calls ("name(args) → result"),
    // generated once at save time from tool_calls. Replayed into the assistant
    // message on later turns so the model remembers what it already called —
    // real tool_use/tool_result blocks never enter persistent history
    // (docs/caching.md §7). Byte-stable for the rolling prompt cache; only
    // messages that carry it replay differently, so old history is untouched.
    toolDigest?: string
    flow?: Array<
      | { type: 'thinking'; content: string }
      | { type: 'tool'; index: number }
    >
    // 最终迭代的原生 thinking block（含 signature），保存时冻结一次。重放历史
    // 时挂回这条 assistant 消息（Anthropic 要求 thinking 在 content 最前、逐
    // 字节原样），Opus 4.5+/Sonnet 4.6+ 会把历史轮的 thinking 保留在上下文里
    // ——模型能看到自己之前的原始思考（赛博意识连续）。冻结 = 逐字节稳定 =
    // 缓存前缀不抖；只有新消息携带，老历史重放不变，上线零冷写。
    thinkingBlocks?: Array<
      | { type: 'thinking'; thinking: string; signature: string }
      | { type: 'redacted_thinking'; data: string }
    >
    // 产地戳：这批 thinking block 是哪个渠道签的（'openrouter' / 中转 host）。
    // 签名只在产出它的后端族有效——Bedrock 验不了别家上游的签名（Invalid
    // signature in thinking block，2026-07-14 换渠道踩坑），重放时只回传
    // 产地与当前渠道一致的块；无戳的老块永不重放。
    thinkingHost?: string
  }
  pending?: boolean
}

export type UserSettings = {
  userId: string
  enabledModels: string[]
  defaultModel: string
  compressionEnabled: boolean
  compressionTriggerRatio: number
  compressionKeepRecentMessages: number
  summarizerModel: string | null
  /** Which API provider runs compression. Defaults to 'openrouter' so users
   *  can keep using OR's free summarizer models when chat is on another API. */
  summarizerProvider: 'openrouter' | 'msuicode'
  temperature: number
  topP: number
  maxTokens: number
  systemPrompt: string
  snackSystemOverlay: string
  syzygyPostSystemPrompt: string
  syzygyReplySystemPrompt: string
  chatReasoningEnabled: boolean
  chatHighReasoningEnabled: boolean
  autoMemoryExtractEnabled: boolean
  memoryExtractModel: string
  /** Which API provider runs memory extraction. Stored locally only,
   *  mirroring summarizerProvider, so users can let chat go through one
   *  provider and extraction through another. */
  memoryExtractProvider: 'openrouter' | 'msuicode'
  updatedAt: string
}

export type SnackPost = {
  id: string
  userId: string
  content: string
  createdAt: string
  updatedAt: string
  isDeleted: boolean
}

export type SnackReply = {
  id: string
  userId: string
  postId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  isDeleted: boolean
  meta?: {
    provider?: string
    model?: string
    reasoning_text?: string
  }
}


export type SyzygyPost = {
  id: string
  userId: string
  content: string
  createdAt: string
  updatedAt: string
  isDeleted: boolean
  modelId?: string | null
}

export type SyzygyReply = {
  id: string
  userId: string
  postId: string
  authorRole: 'user' | 'ai'
  content: string
  createdAt: string
  isDeleted: boolean
  modelId?: string | null
}

export type Memory = {
  id: number
  category: string
  content: string
  tags: string[]
  source: string
  locked: boolean
  createdAt: string
  updatedAt: string
}

export type Diary = {
  id: number
  date: string
  title: string | null
  author: string | null
  mood: string | null
  content: string
  createdAt: string
}

export type HandoffLetter = {
  id: number
  date: string
  title: string | null
  content: string
  signature: string | null
  createdAt: string
}

export type TimelineEvent = {
  id: number
  eventDate: string
  title: string
  description: string | null
  category: string
  importance: number
  source: string
  createdAt: string
}

export type CheckinEntry = {
  id: string
  userId: string
  checkinDate: string
  createdAt: string
}

