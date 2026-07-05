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
    // Frozen auto-recall line for this user turn: top memory-search hits for
    // this message, injected into the payload prefix like weather. Kept
    // per-message so replay is byte-stable for the rolling prompt cache.
    memoryRecall?: string
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
  memoryExtractIntervalHours: number
  lastMemoryExtractAt: string | null
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

