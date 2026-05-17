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
  temperature: number
  topP: number
  maxTokens: number
  systemPrompt: string
  snackSystemOverlay: string
  syzygyPostSystemPrompt: string
  syzygyReplySystemPrompt: string
  chatReasoningEnabled: boolean
  chatHighReasoningEnabled: boolean
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
  createdAt: string
}

export type CheckinEntry = {
  id: string
  userId: string
  checkinDate: string
  createdAt: string
}

