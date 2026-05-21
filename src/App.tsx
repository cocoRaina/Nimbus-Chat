import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import ChatPage from './pages/ChatPage'
import AuthPage from './pages/AuthPage'
import SessionsDrawer from './components/SessionsDrawer'
import type { ChatMessage, ChatSession, UserSettings } from './types'
import {
  createSession,
  deleteMessage,
  deleteSession,
  loadSnapshot,
  renameSession,
  setSessionArchiveState,
  setSnapshot,
  updateSessionOverride,
  updateSessionReasoningOverride,
} from './storage/chatStorage'
import {
  createDefaultSettings,
  ensureUserSettings,
  saveSnackSystemPrompt,
  saveSyzygyPostSystemPrompt,
  saveSyzygyReplySystemPrompt,
  updateUserSettings,
} from './storage/userSettings'
import {
  addRemoteMessage,
  createRemoteSession,
  deleteRemoteMessage,
  deleteRemoteSession,
  fetchRemoteMessages,
  fetchRemoteSessions,
  renameRemoteSession,
  updateRemoteSessionArchiveState,
  updateRemoteSessionOverride,
  updateRemoteSessionReasoningOverride,
} from './storage/supabaseSync'
import { hasSupabaseConfig, subscribeSupabaseConfigChange, supabase } from './supabase/client'
import './App.css'
import SettingsPage from './pages/SettingsPage'
import MyHomePage from './pages/MyHomePage'
import AssistantHomePage from './pages/AssistantHomePage'
import MemoryVaultPage from './pages/MemoryVaultPage'
import CheckinPage from './pages/CheckinPage'
import ExportPage from './pages/ExportPage'
import HomePage from './pages/HomePage'
import HomeLayoutSettingsPage from './pages/HomeLayoutSettingsPage'
import UsagePage from './pages/UsagePage'
import {
  resolveSnackSystemOverlay,
  resolveSyzygyPostPrompt,
  resolveSyzygyReplyPrompt,
} from './constants/aiOverlays'
import { resolveModelId } from './utils/modelResolver'
import { fetchOpenRouter } from './api/openrouter'
import { recordUsage } from './storage/usageStats'
import { compressIfNeeded } from './storage/conversationCompression'
import { isGpt5Auto } from './utils/openrouterReasoning'

const sortSessions = (sessions: ChatSession[]) =>
  [...sessions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

const sortMessages = (messages: ChatMessage[]) =>
  [...messages].sort(
    (a, b) =>
      new Date(a.clientCreatedAt ?? a.createdAt).getTime() -
        new Date(b.clientCreatedAt ?? b.createdAt).getTime() ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

const selectMostRecentSession = (sessions: ChatSession[]) => {
  if (sessions.length === 0) {
    return null
  }
  return sessions.reduce<ChatSession>((latest, session) => {
    const latestTime = new Date(latest.updatedAt ?? latest.createdAt).getTime()
    const sessionTime = new Date(session.updatedAt ?? session.createdAt).getTime()
    return sessionTime > latestTime ? session : latest
  }, sessions[0])
}

const mergeMessages = (localMessages: ChatMessage[], remoteMessages: ChatMessage[]) => {
  const merged = [...localMessages]
  remoteMessages.forEach((message) => {
    const index = merged.findIndex(
      (existing) => existing.id === message.id || existing.clientId === message.clientId,
    )
    if (index === -1) {
      merged.push(message)
      return
    }
    const existing = merged[index]
    merged[index] = {
      ...existing,
      ...message,
      clientId: message.clientId ?? existing.clientId,
      clientCreatedAt: message.clientCreatedAt ?? existing.clientCreatedAt,
      pending: message.pending ?? false,
    }
  })
  return sortMessages(merged)
}

const createClientId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`

const defaultOpenRouterModel = 'openrouter/auto'
const updateMessage = (messages: ChatMessage[], next: ChatMessage) =>
  sortMessages(
    messages.map((message) =>
      message.id === next.id || message.clientId === next.clientId
        ? {
            ...message,
            ...next,
            clientId: next.clientId ?? message.clientId,
            clientCreatedAt: next.clientCreatedAt ?? message.clientCreatedAt,
            pending: next.pending ?? false,
          }
        : message,
    ),
  )

const initialSnapshot = loadSnapshot()

type StreamingToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type RequestContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string } }

type ChatRequestMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | RequestContentBlock[] }
  | { role: 'assistant'; content: string | null; tool_calls?: StreamingToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

// For Claude / Anthropic models on OpenRouter, mark up to two cache breakpoints
// so prompt caching can kick in: the system prompt and the prior conversation
// (everything except the new user turn). Cached reads are ~10% of the input
// price and the cache lives 5 minutes — great for active multi-turn chats.
// Non-Claude models are returned untouched.
const applyClaudeCaching = (
  messages: ChatRequestMessage[],
  _model: string,
): unknown[] => {
  // Per-message cache_control breakpoints don't reliably hit on OpenRouter for
  // Anthropic Claude — we tested 1/2/3 marker placements and saw 0% cache reads
  // (only cache writes). OpenRouter recommends top-level `cache_control` in the
  // request body, which they manage with proper rolling markers themselves. So
  // this is now a no-op pass-through; caching is enabled in requestBody below.
  return messages
}

// Tool definitions exposed to the LLM.
const TOOL_SEARCH_MEMORY = {
  type: 'function' as const,
  function: {
    name: 'search_memory',
    description:
      '搜索用户长期记录的内容，跨 4 个来源同时检索：\n' +
      '- memory（结构化记忆条目，含偏好/习惯/关系细节）\n' +
      '- diary（日记，按日期记录的心情与事件）\n' +
      '- letter（交接信，上一窗口的你写给下一窗口的你）\n' +
      '- timeline（时间轴里程碑事件，少而重大）\n' +
      '当用户提到「记得 / 之前 / 我喜欢 / 我们 / 那次」之类需要回忆具体细节，或你需要确认某件已被告知/记录过的事时调用。' +
      '基于向量语义检索，按相似度返回最相关的若干条。返回的每条都带 source 字段标明来自哪个表。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，建议用自然语言描述要找什么（如「用户对食物的偏好」「上次的争吵」「交接信里提到的承诺」）',
        },
        count: {
          type: 'integer',
          description: '返回多少条结果，1-20，默认 5',
        },
        category: {
          type: 'string',
          description: '可选，限定某个分类（仅对 memory 类生效，不填则全部）',
        },
      },
      required: ['query'],
    },
  },
}

const isToolCapableModel = (model: string) =>
  /claude|anthropic|gpt-4|gpt-5|openai\//i.test(model)

const App = () => {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<ChatSession[]>(initialSnapshot.sessions)
  const [messages, setMessages] = useState<ChatMessage[]>(initialSnapshot.messages)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null)
  const [settingsReady, setSettingsReady] = useState(false)
  const [sessionsReady, setSessionsReady] = useState(false)
  const [, setActiveChatSessionId] = useState<string | null>(null)
  const [supabaseConfigured, setSupabaseConfigured] = useState(() => hasSupabaseConfig())
  const sessionsRef = useRef(sessions)
  const messagesRef = useRef(messages)
  const streamingControllerRef = useRef<AbortController | null>(null)
  const settingsRef = useRef<UserSettings | null>(null)
  const fallbackSettings = useMemo(
    () => createDefaultSettings(user?.id ?? 'local'),
    [user?.id],
  )
  const activeSettings = userSettings ?? fallbackSettings
  const defaultModelId =
    activeSettings.defaultModel?.trim().length > 0
      ? activeSettings.defaultModel
      : defaultOpenRouterModel
  const enabledModels = useMemo(() => {
    const unique = new Set<string>()
    activeSettings.enabledModels.forEach((model) => unique.add(model))
    unique.add(defaultModelId)
    return Array.from(unique)
  }, [activeSettings.enabledModels, defaultModelId])

  const latestSession = useMemo(() => selectMostRecentSession(sessions), [sessions])
  const feedAiConfigBase = useMemo(() => ({
    reasoning: latestSession?.overrideReasoning ?? activeSettings.chatReasoningEnabled,
    temperature: activeSettings.temperature,
    topP: activeSettings.topP,
    maxTokens: activeSettings.maxTokens,
    systemPrompt: activeSettings.systemPrompt,
    snackSystemOverlay: resolveSnackSystemOverlay(activeSettings.snackSystemOverlay),
    syzygyPostSystemPrompt: resolveSyzygyPostPrompt(activeSettings.syzygyPostSystemPrompt),
    syzygyReplySystemPrompt: resolveSyzygyReplyPrompt(activeSettings.syzygyReplySystemPrompt),
  }), [activeSettings, latestSession])
  const snackAiConfig = useMemo(() => ({
    ...feedAiConfigBase,
    model: resolveModelId('snack', { defaultModelId }),
  }), [defaultModelId, feedAiConfigBase])
  const syzygyAiConfig = useMemo(() => ({
    ...feedAiConfigBase,
    model: resolveModelId('syzygy', { defaultModelId }),
  }), [defaultModelId, feedAiConfigBase])
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    settingsRef.current = userSettings
  }, [userSettings])

  const applySnapshot = useCallback((nextSessions: ChatSession[], nextMessages: ChatMessage[]) => {
    const orderedSessions = sortSessions(nextSessions)
    const orderedMessages = sortMessages(nextMessages)
    sessionsRef.current = orderedSessions
    messagesRef.current = orderedMessages
    setSessions(orderedSessions)
    setMessages(orderedMessages)
    setSnapshot({ sessions: orderedSessions, messages: orderedMessages })
  }, [])

  const refreshRemoteSessions = useCallback(async () => {
    if (!user || !supabase) {
      return
    }
    setSyncing(true)
    try {
      const remoteSessions = await fetchRemoteSessions(user.id)
      const nextSessions = sortSessions(remoteSessions)
      applySnapshot(nextSessions, messagesRef.current)
    } catch (error) {
      console.warn('无法加载 Supabase 会话数据', error)
    } finally {
      setSyncing(false)
    }
  }, [applySnapshot, user])

  useEffect(() => {
    return subscribeSupabaseConfigChange(() => {
      setSupabaseConfigured(hasSupabaseConfig())
    })
  }, [])

  useEffect(() => {
    if (!supabase) {
      setUser(null)
      setAuthReady(true)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null)
      setAuthReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setAuthReady(true)
    })
    return () => {
      data.subscription.unsubscribe()
    }
  }, [supabaseConfigured])

  useEffect(() => {
    if (!authReady) {
      return
    }
    if (!user) {
      setUserSettings(null)
      setSettingsReady(true)
      return
    }
    let active = true
    setSettingsReady(false)
    const loadSettings = async () => {
      try {
        const settings = await ensureUserSettings(user.id)
        if (!active) {
          return
        }
        setUserSettings(settings)
      } catch (error) {
        console.warn('无法加载用户设置', error)
        if (!active) {
          return
        }
        setUserSettings(createDefaultSettings(user.id))
      } finally {
        if (active) {
          setSettingsReady(true)
        }
      }
    }
    loadSettings()
    return () => {
      active = false
    }
  }, [authReady, user])

  useEffect(() => {
    if (!authReady) {
      return
    }
    if (!user) {
      const fallback = loadSnapshot()
      applySnapshot(fallback.sessions, fallback.messages)
      setSessionsReady(true)
      return
    }
    let active = true
    const loadRemote = async () => {
      setSessionsReady(false)
      setSyncing(true)
      try {
        const [remoteSessions, remoteMessages] = await Promise.all([
          fetchRemoteSessions(user.id),
          fetchRemoteMessages(user.id),
        ])
        if (!active) {
          return
        }
        const nextSessions = sortSessions(remoteSessions)
        const nextMessages = mergeMessages(messagesRef.current, remoteMessages)
        applySnapshot(nextSessions, nextMessages)
      } catch (error) {
        console.warn('无法加载 Supabase 数据', error)
      } finally {
        if (active) {
          setSyncing(false)
          setSessionsReady(true)
        }
      }
    }
    loadRemote()
    return () => {
      active = false
    }
  }, [applySnapshot, authReady, user])

  useEffect(() => {
    if (!drawerOpen) {
      return
    }
    void refreshRemoteSessions()
  }, [drawerOpen, refreshRemoteSessions])

  useEffect(() => {
    if (!user) {
      return
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshRemoteSessions()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [refreshRemoteSessions, user])

  const messageCounts = useMemo(() => {
    return messages.reduce<Record<string, number>>((accumulator, message) => {
      accumulator[message.sessionId] = (accumulator[message.sessionId] ?? 0) + 1
      return accumulator
    }, {})
  }, [messages])

  const resolveSessionModel = useCallback(
    (sessionId: string) => {
      const fallback = createDefaultSettings(user?.id ?? 'local')
      const settings = settingsRef.current ?? fallback
      const baseDefaultModel =
        settings.defaultModel?.trim().length > 0
          ? settings.defaultModel
          : defaultOpenRouterModel
      const selectedModel = sessionsRef.current.find((session) => session.id === sessionId)?.overrideModel ?? null
      return resolveModelId('chitchat', {
        defaultModelId: baseDefaultModel,
        chitchatSelectedModelId: selectedModel,
      })
    },
    [user?.id],
  )

  const resolveSessionReasoning = useCallback((sessionId: string) => {
    const fallback = createDefaultSettings(user?.id ?? 'local')
    const settings = settingsRef.current ?? fallback
    const overrideReasoning = sessionsRef.current.find((session) => session.id === sessionId)
      ?.overrideReasoning
    return overrideReasoning ?? settings.chatReasoningEnabled
  }, [user?.id])

  const createSessionEntry = useCallback(
    async (title?: string) => {
      const sessionTitle = title ?? '新会话'
      if (user && supabase) {
        try {
          const remoteSession = await createRemoteSession(user.id, sessionTitle)
          const nextSessions = sortSessions([...sessionsRef.current, remoteSession])
          applySnapshot(nextSessions, messagesRef.current)
          return remoteSession
        } catch (error) {
          console.warn('创建云端会话失败，已切换本地存储', error)
        }
      }
      const newSession = createSession(sessionTitle)
      setSessions((prev) => sortSessions([...prev, newSession]))
      return newSession
    },
    [applySnapshot, user],
  )

  const renameSessionEntry = useCallback(
    async (sessionId: string, title: string) => {
      if (user && supabase) {
        try {
          const updated = await renameRemoteSession(sessionId, title)
          const nextSessions = sessionsRef.current.map((session) =>
            session.id === sessionId ? updated : session,
          )
          applySnapshot(nextSessions, messagesRef.current)
          return
        } catch (error) {
          console.warn('更新云端会话失败，已切换本地存储', error)
        }
      }
      const updated = renameSession(sessionId, title)
      if (!updated) {
        return
      }
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? updated : session)),
      )
    },
    [applySnapshot, user],
  )

  const handleSessionOverrideChange = useCallback(
    async (sessionId: string, overrideModel: string | null) => {
      const normalized = overrideModel?.trim().length ? overrideModel.trim() : null
      if (user && supabase) {
        try {
          const updated = await updateRemoteSessionOverride(sessionId, normalized)
          const nextSessions = sessionsRef.current.map((session) =>
            session.id === sessionId ? updated : session,
          )
          applySnapshot(nextSessions, messagesRef.current)
          return
        } catch (error) {
          console.warn('更新云端会话模型失败，已切换本地存储', error)
        }
      }
      const updated = updateSessionOverride(sessionId, normalized)
      if (!updated) {
        return
      }
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? updated : session)),
      )
    },
    [applySnapshot, user],
  )

  const handleSessionReasoningOverrideChange = useCallback(
    async (sessionId: string, overrideReasoning: boolean | null) => {
      if (user && supabase) {
        try {
          const updated = await updateRemoteSessionReasoningOverride(
            sessionId,
            overrideReasoning,
          )
          const nextSessions = sessionsRef.current.map((session) =>
            session.id === sessionId ? updated : session,
          )
          applySnapshot(nextSessions, messagesRef.current)
          return
        } catch (error) {
          console.warn('更新云端会话思考链失败，已切换本地存储', error)
        }
      }
      const updated = updateSessionReasoningOverride(sessionId, overrideReasoning)
      if (!updated) {
        return
      }
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? updated : session)),
      )
    },
    [applySnapshot, user],
  )

  const handleSessionArchiveStateChange = useCallback(
    async (sessionId: string, isArchived: boolean) => {
      if (user && supabase) {
        try {
          const updated = await updateRemoteSessionArchiveState(sessionId, isArchived)
          const nextSessions = sessionsRef.current.map((session) =>
            session.id === sessionId ? updated : session,
          )
          applySnapshot(nextSessions, messagesRef.current)
          return
        } catch (error) {
          console.warn('更新云端会话抽屉状态失败，已切换本地存储', error)
        }
      }
      const updated = setSessionArchiveState(sessionId, isArchived)
      if (!updated) {
        return
      }
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? updated : session)),
      )
    },
    [applySnapshot, user],
  )


  const sendMessage = useCallback(
    async (
      sessionId: string,
      content: string,
      options?: {
        skipUser?: boolean
        attachments?: Array<{ type: 'image'; url: string; width?: number; height?: number }>
      },
    ) => {
      const skipUser = options?.skipUser === true
      const userAttachments = options?.attachments ?? []
      const fallbackSettings = createDefaultSettings(user?.id ?? 'local')
      const activeSettings = settingsRef.current ?? fallbackSettings
      const effectiveModel = resolveSessionModel(sessionId)
      const reasoningEnabled = resolveSessionReasoning(sessionId)
      const paramsSnapshot = {
        temperature: activeSettings.temperature,
        top_p: activeSettings.topP,
        max_tokens: activeSettings.maxTokens,
      }
      const systemPrompt = activeSettings.systemPrompt
      const isFirstMessageInSession = !messagesRef.current.some(
        (message) =>
          message.sessionId === sessionId &&
          message.role === 'user' &&
          message.content.trim().length > 0,
      )
      const clientId = createClientId()
      const clientCreatedAt = new Date().toISOString()
      const userMeta: ChatMessage['meta'] =
        userAttachments.length > 0 ? { attachments: userAttachments } : {}
      const optimisticMessage: ChatMessage = {
        id: clientId,
        sessionId,
        role: 'user',
        content,
        createdAt: clientCreatedAt,
        clientId,
        clientCreatedAt,
        meta: userMeta,
        pending: true,
      }
      const assistantClientId = createClientId()
      const assistantClientCreatedAt = new Date(
        new Date(clientCreatedAt).getTime() + 200,
      ).toISOString()
      const optimisticAssistant: ChatMessage = {
        id: assistantClientId,
        sessionId,
        role: 'assistant',
        content: '',
        createdAt: assistantClientCreatedAt,
        clientId: assistantClientId,
        clientCreatedAt: assistantClientCreatedAt,
        meta: {
          model: effectiveModel,
          provider: 'openrouter',
          streaming: true,
          params: paramsSnapshot,
        },
        pending: true,
      }
      const nextMessages = sortMessages([
        ...messagesRef.current,
        ...(skipUser ? [] : [optimisticMessage]),
        optimisticAssistant,
      ])
      const nextSessions = sessionsRef.current.map((session) =>
        session.id === sessionId ? { ...session, updatedAt: clientCreatedAt } : session,
      )
      applySnapshot(nextSessions, nextMessages)

      const persist = async () => {
        if (!user || !supabase) {
          const localMessages = updateMessage(messagesRef.current, {
            ...optimisticMessage,
            pending: false,
          })
          const assistantMessage: ChatMessage = {
            id: assistantClientId,
            sessionId,
            role: 'assistant',
            content: '当前未登录或服务未配置，无法获取回复。',
            createdAt: assistantClientCreatedAt,
            clientId: assistantClientId,
            clientCreatedAt: assistantClientCreatedAt,
            meta: { model: 'offline', provider: 'openrouter' },
            pending: false,
          }
          const localNextMessages = sortMessages([...localMessages, assistantMessage])
          const localNextSessions = sessionsRef.current.map((session) =>
            session.id === sessionId
              ? { ...session, updatedAt: assistantClientCreatedAt }
              : session,
          )
          applySnapshot(localNextSessions, localNextMessages)
          return
        }

        if (!skipUser) {
          try {
            const { message: savedUserMessage, updatedAt } = await addRemoteMessage(
              sessionId,
              user.id,
              'user',
              content,
              clientId,
              clientCreatedAt,
              userMeta,
            )
            const updatedMessages = updateMessage(messagesRef.current, {
              ...savedUserMessage,
              pending: false,
            })
            const updatedSessions = sessionsRef.current.map((session) =>
              session.id === sessionId ? { ...session, updatedAt } : session,
            )
            applySnapshot(updatedSessions, updatedMessages)
          } catch (error) {
            console.warn('写入云端消息失败', error)
            window.alert('发送失败，请稍后重试。')
            return
          }
        }

        let assistantContent = ''
        let reasoningContent = ''
        let reasoningType: 'reasoning' | 'thinking' | null = null
        let actualModel = effectiveModel
        let pendingDelta = ''
        let pendingReasoningDelta = ''
        let flushTimer: number | null = null
        let thinkCarry = ''
        let isInThink = false
        let lastUsage: {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          cache_read_input_tokens?: number
        } | null = null
        let currentRequestDebug: unknown = null

        const flushUsageRecord = () => {
          if (!user || !lastUsage) {
            return
          }
          const cached =
            Number(lastUsage.prompt_tokens_details?.cached_tokens ?? lastUsage.cache_read_input_tokens ?? 0)
          void recordUsage({
            userId: user.id,
            model: actualModel,
            promptTokens: Number(lastUsage.prompt_tokens ?? 0),
            completionTokens: Number(lastUsage.completion_tokens ?? 0),
            totalTokens: Number(lastUsage.total_tokens ?? 0),
            cachedTokens: cached,
            source: 'chat',
            rawUsage: lastUsage,
            requestDebug: currentRequestDebug,
          })
          lastUsage = null
          currentRequestDebug = null
        }

        const openTag = '<think>'
        const closeTag = '</think>'
        const reasoningFields: Array<{
          key: 'reasoning' | 'thinking' | 'reasoning_content' | 'thinking_content'
          type: 'reasoning' | 'thinking'
        }> = [
          { key: 'reasoning', type: 'reasoning' },
          { key: 'thinking', type: 'thinking' },
          { key: 'reasoning_content', type: 'reasoning' },
          { key: 'thinking_content', type: 'thinking' },
        ]

        const collectReasoningFromObject = (
          source: Record<string, unknown> | null | undefined,
        ) => {
          if (!source) {
            return { text: '', type: null as typeof reasoningType }
          }
          let text = ''
          let type: typeof reasoningType = null
          for (const field of reasoningFields) {
            const value = source[field.key]
            if (typeof value === 'string' && value.length > 0) {
              text += value
              if (!type) {
                type = field.type
              }
            }
          }
          return { text, type }
        }

        const findPartialSuffix = (text: string, tag: string) => {
          const maxLength = Math.min(tag.length - 1, text.length)
          for (let length = maxLength; length > 0; length -= 1) {
            const fragment = tag.slice(0, length)
            if (text.endsWith(fragment)) {
              return fragment
            }
          }
          return ''
        }

        const splitReasoningFromContent = (delta: string) => {
          let text = `${thinkCarry}${delta}`
          thinkCarry = ''
          let contentChunk = ''
          let reasoningChunk = ''

          while (text.length > 0) {
            if (isInThink) {
              const closeIndex = text.indexOf(closeTag)
              if (closeIndex === -1) {
                const partial = findPartialSuffix(text, closeTag)
                const cutoff = text.length - partial.length
                reasoningChunk += text.slice(0, cutoff)
                thinkCarry = partial
                text = ''
              } else {
                reasoningChunk += text.slice(0, closeIndex)
                text = text.slice(closeIndex + closeTag.length)
                isInThink = false
              }
            } else {
              const openIndex = text.indexOf(openTag)
              if (openIndex === -1) {
                const partial = findPartialSuffix(text, openTag)
                const cutoff = text.length - partial.length
                contentChunk += text.slice(0, cutoff)
                thinkCarry = partial
                text = ''
              } else {
                contentChunk += text.slice(0, openIndex)
                text = text.slice(openIndex + openTag.length)
                isInThink = true
              }
            }
          }

          return { contentChunk, reasoningChunk }
        }

        const appendReasoningDelta = (
          text: string,
          type: typeof reasoningType,
          target: 'pending' | 'final' = 'pending',
        ) => {
          if (!text) {
            return
          }
          if (target === 'pending') {
            pendingReasoningDelta += text
          } else {
            reasoningContent += text
          }
          if (!reasoningType && type) {
            reasoningType = type
          }
        }

        const buildAssistantMeta = (streaming: boolean): ChatMessage['meta'] => {
          const meta: ChatMessage['meta'] = {
            model: actualModel,
            provider: 'openrouter',
            streaming,
            params: paramsSnapshot,
          }
          if (reasoningContent) {
            meta.reasoning = reasoningContent
            meta.reasoning_text = reasoningContent
          }
          if (reasoningType) {
            meta.reasoning_type = reasoningType
          }
          return meta
        }

        // Transient status line shown only in the streaming bubble (never persisted).
        // Used to surface "AI is searching memory…" while tool calls run between
        // streaming iterations, so the chat doesn't feel like it's silently hung.
        let toolStatusLine = ''

        const buildDisplayContent = () => {
          if (!toolStatusLine) {
            return assistantContent
          }
          return assistantContent ? `${assistantContent}\n\n${toolStatusLine}` : toolStatusLine
        }

        const pushStreamingUpdate = () => {
          const streamingUpdate = updateMessage(messagesRef.current, {
            id: assistantClientId,
            sessionId,
            role: 'assistant',
            clientId: assistantClientId,
            content: buildDisplayContent(),
            createdAt: assistantClientCreatedAt,
            clientCreatedAt: assistantClientCreatedAt,
            meta: buildAssistantMeta(true),
            pending: true,
          })
          applySnapshot(sessionsRef.current, streamingUpdate)
        }

        const flushPending = () => {
          if (!pendingDelta && !pendingReasoningDelta) {
            return
          }
          if (pendingDelta) {
            assistantContent += pendingDelta
            pendingDelta = ''
          }
          if (pendingReasoningDelta) {
            reasoningContent += pendingReasoningDelta
            pendingReasoningDelta = ''
          }
          pushStreamingUpdate()
        }

        const setToolStatus = (line: string) => {
          toolStatusLine = line
          pushStreamingUpdate()
        }

        const scheduleFlush = () => {
          if (flushTimer !== null) {
            return
          }
          flushTimer = window.setTimeout(() => {
            flushTimer = null
            flushPending()
          }, 50)
        }

        try {
          const sessionMessages = messagesRef.current.filter(
            (message) =>
              message.sessionId === sessionId &&
              message.content.trim().length > 0 &&
              !message.meta?.streaming,
          )
          const compressionOutcome = await compressIfNeeded(
            sessionId,
            sessionMessages,
            systemPrompt ?? '',
            effectiveModel,
            {
              enabled: activeSettings.compressionEnabled,
              triggerRatio: activeSettings.compressionTriggerRatio,
              keepRecentMessages: activeSettings.compressionKeepRecentMessages,
              summarizerModel: activeSettings.summarizerModel,
            },
          )
          const baseMessages: ChatRequestMessage[] = []
          if (compressionOutcome.systemPromptText.trim()) {
            baseMessages.push({ role: 'system', content: compressionOutcome.systemPromptText })
          }
          if (compressionOutcome.summaryText) {
            baseMessages.push({
              role: 'system',
              content: `## 前面对话的摘要（用作上下文，不要直接复述）\n${compressionOutcome.summaryText}`,
            })
          }
          for (const message of compressionOutcome.recentMessages) {
            const messageAttachments = message.meta?.attachments ?? []
            const imageAttachments = messageAttachments.filter((a) => a.type === 'image')
            if (message.role === 'user' && imageAttachments.length > 0) {
              const blocks: RequestContentBlock[] = []
              if (message.content.trim().length > 0) {
                blocks.push({ type: 'text', text: message.content })
              }
              for (const att of imageAttachments) {
                blocks.push({ type: 'image_url', image_url: { url: att.url } })
              }
              baseMessages.push({ role: 'user', content: blocks })
            } else {
              baseMessages.push({ role: message.role, content: message.content } as ChatRequestMessage)
            }
          }
          const isClaudeModel = (model: string) => /claude|anthropic/i.test(model)
          const toolsEnabled = isToolCapableModel(effectiveModel) && Boolean(supabase)
          const MAX_TOOL_ITERATIONS = 4

          const controller = new AbortController()
          streamingControllerRef.current?.abort()
          streamingControllerRef.current = controller
          setIsStreaming(true)

          let iteration = 0
          let conversationDone = false

          while (!conversationDone && iteration < MAX_TOOL_ITERATIONS) {
            iteration++
            const cachedMessages = applyClaudeCaching(baseMessages, effectiveModel)
            const debugBreakpoints = cachedMessages.map((msg, mIdx) => {
              const m = msg as { role: string; content: unknown; tool_calls?: unknown[] }
              const hasCacheControl =
                Array.isArray(m.content) &&
                (m.content as Array<{ cache_control?: unknown }>).some((b) => b?.cache_control)
              const contentLen = Array.isArray(m.content)
                ? (m.content as Array<{ text?: string }>).reduce((s, b) => s + (b.text?.length ?? 0), 0)
                : typeof m.content === 'string'
                  ? m.content.length
                  : 0
              return {
                idx: mIdx,
                role: m.role,
                tool_calls: Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
                cache_control: hasCacheControl,
                chars: contentLen,
              }
            })
            const requestBody: Record<string, unknown> = {
              model: effectiveModel,
              modelId: effectiveModel,
              module: 'chitchat',
              conversationId: sessionId,
              messages: cachedMessages,
              temperature: paramsSnapshot.temperature,
              top_p: paramsSnapshot.top_p,
              max_tokens: paramsSnapshot.max_tokens,
              stream: true,
              usage: { include: true },
              isFirstMessage: isFirstMessageInSession,
            }
            // For Claude / Anthropic on OpenRouter, enable automatic prompt
            // caching via top-level cache_control. Force routing to Anthropic
            // direct (skip Bedrock / Vertex) since top-level cache_control
            // only works on the native Anthropic provider.
            if (isClaudeModel(effectiveModel)) {
              requestBody.cache_control = { type: 'ephemeral' }
              requestBody.provider = {
                order: ['Anthropic'],
                allow_fallbacks: false,
              }
            }
            if (toolsEnabled) {
              requestBody.tools = [TOOL_SEARCH_MEMORY]
              requestBody.tool_choice = 'auto'
            }
            if (reasoningEnabled && isClaudeModel(effectiveModel)) {
              requestBody.reasoning = { effort: 'high' }
            }
            if (
              reasoningEnabled &&
              activeSettings.chatHighReasoningEnabled &&
              isGpt5Auto(effectiveModel)
            ) {
              requestBody.reasoning = { effort: 'high' }
            }

            currentRequestDebug = {
              model: effectiveModel,
              iteration,
              total_messages: cachedMessages.length,
              msg_level_markers: debugBreakpoints.filter((b) => b.cache_control).length,
              top_level_cache_control: requestBody.cache_control ?? null,
              provider: requestBody.provider ?? null,
              has_tools: Array.isArray(requestBody.tools) && (requestBody.tools as unknown[]).length > 0,
              breakpoints: debugBreakpoints,
            }

            const response = await fetchOpenRouter('/chat/completions', {
              body: requestBody,
              signal: controller.signal,
            })
            if (!response.ok) {
              const errorText = await response.text()
              throw new Error(errorText || '请求失败')
            }
            const contentType = response.headers.get('content-type') ?? ''
            const isEventStream = contentType.includes('text/event-stream')

            const accumulatedToolCalls = new Map<number, StreamingToolCall>()
            let finishReason: string | null = null

            if (!isEventStream) {
              const payload = (await response.json()) as Record<string, unknown>
              if (typeof payload?.model === 'string') {
                actualModel = payload.model
              }
              if (payload?.usage && typeof payload.usage === 'object') {
                lastUsage = payload.usage as typeof lastUsage
              }
              const choice = (payload as { choices?: unknown[] })?.choices?.[0] as
                | Record<string, unknown>
                | undefined
              const message = (choice?.message as Record<string, unknown>) ?? choice ?? {}
              const content =
                typeof message?.content === 'string'
                  ? (message.content as string)
                  : typeof (choice as { text?: unknown })?.text === 'string'
                    ? ((choice as { text?: unknown }).text as string)
                    : ''
              if (content) {
                const { contentChunk, reasoningChunk } = splitReasoningFromContent(content)
                assistantContent += contentChunk
                if (reasoningChunk) {
                  appendReasoningDelta(reasoningChunk, 'thinking', 'final')
                }
              }
              const messageReasoning = collectReasoningFromObject(message)
              if (messageReasoning.text) {
                appendReasoningDelta(messageReasoning.text, messageReasoning.type, 'final')
              }
              if (choice && choice !== message) {
                const choiceReasoning = collectReasoningFromObject(choice)
                if (choiceReasoning.text) {
                  appendReasoningDelta(choiceReasoning.text, choiceReasoning.type, 'final')
                }
              }
              if (payload && payload !== choice) {
                const payloadReasoning = collectReasoningFromObject(payload)
                if (payloadReasoning.text) {
                  appendReasoningDelta(payloadReasoning.text, payloadReasoning.type, 'final')
                }
              }
              const toolCallsField = (message as { tool_calls?: unknown[] })?.tool_calls
              if (Array.isArray(toolCallsField)) {
                toolCallsField.forEach((rawTc, idx) => {
                  const tc = rawTc as {
                    index?: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }
                  const slot = tc.index ?? idx
                  accumulatedToolCalls.set(slot, {
                    id: tc.id ?? `call_${slot}`,
                    type: 'function',
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  })
                })
              }
              const fr = (choice as { finish_reason?: unknown })?.finish_reason
              if (typeof fr === 'string') {
                finishReason = fr
              }
            } else {
              if (!response.body) {
                throw new Error('响应体为空')
              }
              const reader = response.body.getReader()
              const decoder = new TextDecoder('utf-8')
              let buffer = ''
              let done = false
              while (!done) {
                const { value, done: readerDone } = await reader.read()
                if (readerDone) {
                  break
                }
                buffer += decoder.decode(value, { stream: true })
                const events = buffer.split('\n\n')
                buffer = events.pop() ?? ''
                for (const event of events) {
                  const data = event
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.replace(/^data:\s*/, ''))
                    .join('\n')
                  if (!data) {
                    continue
                  }
                  if (data === '[DONE]') {
                    done = true
                    break
                  }
                  try {
                    const payload = JSON.parse(data)
                    const choice = payload?.choices?.[0] ?? {}
                    const deltaPayload = choice?.delta ?? {}
                    const delta = typeof deltaPayload?.content === 'string' ? deltaPayload.content : ''
                    if (payload?.model) {
                      actualModel = payload.model
                    }
                    if (payload?.usage && typeof payload.usage === 'object') {
                      lastUsage = payload.usage
                    }
                    if (typeof choice?.finish_reason === 'string') {
                      finishReason = choice.finish_reason
                    }
                    const explicitReasoning =
                      typeof deltaPayload?.reasoning === 'string' && deltaPayload.reasoning.length > 0
                        ? deltaPayload.reasoning
                        : ''
                    if (explicitReasoning) {
                      appendReasoningDelta(explicitReasoning, 'reasoning')
                      scheduleFlush()
                    }
                    const deltaReasoning = collectReasoningFromObject(
                      deltaPayload as Record<string, unknown>,
                    )
                    if (deltaReasoning.text && deltaReasoning.text !== explicitReasoning) {
                      appendReasoningDelta(deltaReasoning.text, deltaReasoning.type)
                      scheduleFlush()
                    }
                    if (delta) {
                      const { contentChunk, reasoningChunk } = splitReasoningFromContent(delta)
                      if (contentChunk) {
                        pendingDelta += contentChunk
                      }
                      if (reasoningChunk) {
                        appendReasoningDelta(reasoningChunk, 'thinking')
                      }
                      scheduleFlush()
                    }
                    if (Array.isArray(deltaPayload?.tool_calls)) {
                      for (const rawTc of deltaPayload.tool_calls as Array<{
                        index?: number
                        id?: string
                        function?: { name?: string; arguments?: string }
                      }>) {
                        const slot = rawTc.index ?? 0
                        const existing =
                          accumulatedToolCalls.get(slot) ?? {
                            id: '',
                            type: 'function' as const,
                            function: { name: '', arguments: '' },
                          }
                        if (rawTc.id) existing.id = rawTc.id
                        if (rawTc.function?.name) existing.function.name = rawTc.function.name
                        if (typeof rawTc.function?.arguments === 'string') {
                          existing.function.arguments += rawTc.function.arguments
                        }
                        accumulatedToolCalls.set(slot, existing)
                      }
                    }
                  } catch (parseError) {
                    console.warn('解析流式响应失败', parseError)
                  }
                }
              }
            }

            if (flushTimer !== null) {
              window.clearTimeout(flushTimer)
              flushTimer = null
            }
            flushPending()
            flushUsageRecord()

            const toolCallsArr = Array.from(accumulatedToolCalls.values()).filter(
              (tc) => tc.function.name.length > 0,
            )
            if (
              toolsEnabled &&
              toolCallsArr.length > 0 &&
              (finishReason === 'tool_calls' || finishReason === null)
            ) {
              baseMessages.push({
                role: 'assistant',
                content: assistantContent || '',
                tool_calls: toolCallsArr,
              })
              for (const tc of toolCallsArr) {
                let resultText: string
                try {
                  if (tc.function.name === 'search_memory' && supabase) {
                    let args: { query?: string; count?: number; category?: string } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}') as typeof args
                    } catch (jsonError) {
                      console.warn('解析 search_memory 参数失败', jsonError)
                    }
                    const queryLabel = (args.query ?? '').toString().trim().slice(0, 40)
                    setToolStatus(
                      queryLabel
                        ? `🔍 正在搜索记忆库：${queryLabel}…`
                        : '🔍 正在搜索记忆库…',
                    )
                    const { data, error } = await supabase.functions.invoke('search_memory', {
                      body: {
                        query: args.query,
                        count: args.count,
                        category: args.category,
                      },
                    })
                    resultText = error
                      ? JSON.stringify({ error: error.message ?? String(error) })
                      : JSON.stringify(data ?? {})
                  } else {
                    resultText = JSON.stringify({ error: `unsupported tool: ${tc.function.name}` })
                  }
                } catch (toolError) {
                  resultText = JSON.stringify({ error: String(toolError) })
                }
                baseMessages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: resultText,
                })
              }
              setToolStatus('')
              // Loop back for another model turn
              continue
            }
            conversationDone = true
          }

          const { message: assistantMessage, updatedAt } = await addRemoteMessage(
            sessionId,
            user.id,
            'assistant',
            assistantContent,
            assistantClientId,
            assistantClientCreatedAt,
            buildAssistantMeta(false),
          )
          const updatedMessages = updateMessage(messagesRef.current, {
            ...assistantMessage,
            pending: false,
          })
          const updatedSessions = sessionsRef.current.map((session) =>
            session.id === sessionId ? { ...session, updatedAt } : session,
          )
          applySnapshot(updatedSessions, updatedMessages)
        } catch (error) {
          if (flushTimer !== null) {
            window.clearTimeout(flushTimer)
            flushTimer = null
          }
          flushPending()
          flushUsageRecord()
          if (error instanceof DOMException && error.name === 'AbortError') {
            if (assistantContent.trim().length > 0) {
              const { message: assistantMessage, updatedAt } = await addRemoteMessage(
                sessionId,
                user.id,
                'assistant',
                assistantContent,
                assistantClientId,
                assistantClientCreatedAt,
                buildAssistantMeta(false),
              )
              const updatedMessages = updateMessage(messagesRef.current, {
                ...assistantMessage,
                pending: false,
              })
              const updatedSessions = sessionsRef.current.map((session) =>
                session.id === sessionId ? { ...session, updatedAt } : session,
              )
              applySnapshot(updatedSessions, updatedMessages)
            } else {
              const abortedMessages = updateMessage(messagesRef.current, {
                id: assistantClientId,
                sessionId,
                role: 'assistant',
                clientId: assistantClientId,
                content: assistantContent,
                createdAt: assistantClientCreatedAt,
                clientCreatedAt: assistantClientCreatedAt,
                meta: buildAssistantMeta(false),
                pending: false,
              })
              applySnapshot(sessionsRef.current, abortedMessages)
            }
            return
          }
          console.warn('流式回复失败', error)
          const failedMessages = updateMessage(messagesRef.current, {
            id: assistantClientId,
            sessionId,
            role: 'assistant',
            clientId: assistantClientId,
            content: assistantContent || '回复失败，请稍后重试。',
            createdAt: assistantClientCreatedAt,
            clientCreatedAt: assistantClientCreatedAt,
            meta: buildAssistantMeta(false),
            pending: false,
          })
          applySnapshot(sessionsRef.current, failedMessages)
          const errorMessage = error instanceof Error && error.message ? error.message : '回复失败，请稍后重试。'
          window.alert(errorMessage)
        } finally {
          setIsStreaming(false)
          streamingControllerRef.current = null
        }
      }

      void persist()
    },
    [applySnapshot, resolveSessionReasoning, resolveSessionModel, user],
  )

  const handleStopStreaming = useCallback(() => {
    streamingControllerRef.current?.abort()
    setIsStreaming(false)
  }, [])

  const regenerateAssistantReply = useCallback(
    async (assistantMessageId: string) => {
      const all = messagesRef.current
      const target = all.find(
        (m) => m.id === assistantMessageId || m.clientId === assistantMessageId,
      )
      if (!target || target.role !== 'assistant') return
      const sessionMessages = all
        .filter((m) => m.sessionId === target.sessionId)
        .sort(
          (a, b) =>
            new Date(a.clientCreatedAt ?? a.createdAt).getTime() -
            new Date(b.clientCreatedAt ?? b.createdAt).getTime(),
        )
      const targetIdx = sessionMessages.findIndex((m) => m.id === target.id)
      if (targetIdx <= 0) return
      let priorUser: ChatMessage | undefined
      for (let i = targetIdx - 1; i >= 0; i--) {
        if (sessionMessages[i].role === 'user' && sessionMessages[i].content.trim().length > 0) {
          priorUser = sessionMessages[i]
          break
        }
      }
      if (!priorUser) return
      // Abort any active streaming for safety
      streamingControllerRef.current?.abort()
      // Delete the stale assistant message
      try {
        if (user && supabase && !target.pending) {
          await deleteRemoteMessage(target.id)
        }
      } catch (deleteError) {
        console.warn('删除旧 AI 回复失败', deleteError)
      }
      const filtered = messagesRef.current.filter(
        (m) => m.id !== target.id && m.clientId !== target.id,
      )
      applySnapshot(sessionsRef.current, filtered)
      // Re-stream using the existing user message (skipUser = true)
      await sendMessage(target.sessionId, priorUser.content, { skipUser: true })
    },
    [user, sendMessage, applySnapshot],
  )

  const removeMessage = useCallback(
    async (messageId: string) => {
      const targetMessage = messagesRef.current.find(
        (message) => message.id === messageId || message.clientId === messageId,
      )
      if (targetMessage?.pending) {
        const nextMessages = messagesRef.current.filter(
          (message) => message.id !== messageId && message.clientId !== messageId,
        )
        applySnapshot(sessionsRef.current, nextMessages)
        return
      }
      if (user && supabase) {
        try {
          await deleteRemoteMessage(messageId)
          const nextMessages = messagesRef.current.filter(
            (message) => message.id !== messageId && message.clientId !== messageId,
          )
          applySnapshot(sessionsRef.current, nextMessages)
          return
        } catch (error) {
          console.warn('删除云端消息失败，已切换本地存储', error)
        }
      }
      deleteMessage(messageId)
      setMessages((prev) =>
        prev.filter((message) => message.id !== messageId && message.clientId !== messageId),
      )
    },
    [applySnapshot, user],
  )

  const removeSession = useCallback(
    async (sessionId: string) => {
      if (user && supabase) {
        try {
          await deleteRemoteSession(sessionId)
          const nextSessions = sessionsRef.current.filter(
            (session) => session.id !== sessionId,
          )
          const nextMessages = messagesRef.current.filter(
            (message) => message.sessionId !== sessionId,
          )
          applySnapshot(nextSessions, nextMessages)
          return
        } catch (error) {
          console.warn('删除云端会话失败，已切换本地存储', error)
        }
      }
      deleteSession(sessionId)
      setSessions((prev) => prev.filter((session) => session.id !== sessionId))
      setMessages((prev) => prev.filter((message) => message.sessionId !== sessionId))
    },
    [applySnapshot, user],
  )

  const handleSaveSettings = useCallback(async (nextSettings: UserSettings) => {
    if (user && supabase) {
      await updateUserSettings(nextSettings)
    }
    setUserSettings(nextSettings)
  }, [user])

  const handleSaveSnackSystemPrompt = useCallback(async (nextSnackSystemPrompt: string) => {
    if (!user) {
      return
    }
    const nextSettings = {
      ...(settingsRef.current ?? createDefaultSettings(user.id)),
      userId: user.id,
      snackSystemOverlay: nextSnackSystemPrompt,
      updatedAt: new Date().toISOString(),
    }
    if (supabase) {
      await saveSnackSystemPrompt(user.id, nextSnackSystemPrompt)
    }
    setUserSettings(nextSettings)
  }, [user])
  const handleSaveSyzygyPostSystemPrompt = useCallback(async (nextPrompt: string) => {
    if (!user) {
      return
    }
    const nextSettings = {
      ...(settingsRef.current ?? createDefaultSettings(user.id)),
      userId: user.id,
      syzygyPostSystemPrompt: nextPrompt,
      updatedAt: new Date().toISOString(),
    }
    if (supabase) {
      await saveSyzygyPostSystemPrompt(user.id, nextPrompt)
    }
    setUserSettings(nextSettings)
  }, [user])

  const handleSaveSyzygyReplySystemPrompt = useCallback(async (nextPrompt: string) => {
    if (!user) {
      return
    }
    const nextSettings = {
      ...(settingsRef.current ?? createDefaultSettings(user.id)),
      userId: user.id,
      syzygyReplySystemPrompt: nextPrompt,
      updatedAt: new Date().toISOString(),
    }
    if (supabase) {
      await saveSyzygyReplySystemPrompt(user.id, nextPrompt)
    }
    setUserSettings(nextSettings)
  }, [user])


  return (
    <div className="app-shell">
      <Routes>
        <Route
          path="/setup"
          element={
            <Navigate to="/auth" replace />
          }
        />
        <Route
          path="/auth"
          element={
            <AuthPage user={user} supabaseConfigured={supabaseConfigured} />
          }
        />
        <Route
          path="/"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <HomePage
                user={user}
                onOpenChat={() => {
                  const latest = selectMostRecentSession(sessions)
                  if (latest) {
                    navigate(`/chat/${latest.id}`)
                    return
                  }
                  void createSessionEntry().then((session) => {
                    navigate(`/chat/${session.id}`)
                  })
                }}
              />
            </RequireAuth>
          }
        />
        <Route
          path="/home"
          element={<Navigate to="/" replace />}
        />
        <Route
          path="/home-layout"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <HomeLayoutSettingsPage
                user={user}
                onOpenChat={() => {
                  const latest = selectMostRecentSession(sessions)
                  if (latest) {
                    navigate(`/chat/${latest.id}`)
                    return
                  }
                  void createSessionEntry().then((session) => {
                    navigate(`/chat/${session.id}`)
                  })
                }}
              />
            </RequireAuth>
          }
        />
        <Route
          path="/chat"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <NewSessionRedirect
                sessions={sessions}
                sessionsReady={sessionsReady}
                onCreateSession={createSessionEntry}
              />
            </RequireAuth>
          }
        />
        <Route
          path="/chat/:sessionId"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <ChatRoute
                sessions={sessions}
                messages={messages}
                messageCounts={messageCounts}
                drawerOpen={drawerOpen}
                syncing={syncing}
                sessionsReady={sessionsReady}
                isStreaming={isStreaming}
                onStopStreaming={handleStopStreaming}
                onOpenDrawer={() => setDrawerOpen(true)}
                onCloseDrawer={() => setDrawerOpen(false)}
                onCreateSession={createSessionEntry}
                onRenameSession={renameSessionEntry}
                onSendMessage={sendMessage}
                onDeleteMessage={removeMessage}
                onRegenerate={regenerateAssistantReply}
                onDeleteSession={removeSession}
                enabledModels={enabledModels}
                defaultModel={defaultModelId}
                onSelectModel={handleSessionOverrideChange}
                defaultReasoning={activeSettings.chatReasoningEnabled}
                onSelectReasoning={handleSessionReasoningOverrideChange}
                onArchiveSession={handleSessionArchiveStateChange}
                onActiveSessionChange={setActiveChatSessionId}
                user={user}
              />
            </RequireAuth>
          }
        />
        <Route
          path="/checkin"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <CheckinPage user={user} />
            </RequireAuth>
          }
        />
        <Route
          path="/export"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <ExportPage user={user} />
            </RequireAuth>
          }
        />
        <Route
          path="/usage"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <UsagePage user={user} />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <SettingsPage
                user={user}
                settings={userSettings}
                ready={settingsReady}
                onSaveSettings={handleSaveSettings}
                onSaveSnackSystemPrompt={handleSaveSnackSystemPrompt}
                onSaveSyzygyPostPrompt={handleSaveSyzygyPostSystemPrompt}
                onSaveSyzygyReplyPrompt={handleSaveSyzygyReplySystemPrompt}
              />
            </RequireAuth>
          }
        />
        <Route
          path="/snacks"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <MyHomePage user={user} snackAiConfig={snackAiConfig} />
            </RequireAuth>
          }
        />

        <Route
          path="/memory-vault"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <MemoryVaultPage />
            </RequireAuth>
          }
        />
        <Route
          path="/syzygy"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <AssistantHomePage user={user} snackAiConfig={syzygyAiConfig} />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={<Navigate to={supabaseConfigured ? '/' : '/auth'} replace />}
        />
      </Routes>
    </div>
  )
}

const RequireAuth = ({
  ready,
  user,
  configured,
  children,
}: {
  ready: boolean
  user: User | null
  configured: boolean
  children: ReactNode
}) => {
  if (!configured) {
    return <Navigate to="/auth" replace />
  }
  if (!ready) {
    return (
      <div className="loading-state">
        <p>正在检查登录状态...</p>
      </div>
    )
  }
  if (!user) {
    return <Navigate to="/auth" replace />
  }
  return children
}

const NewSessionRedirect = ({
  sessions,
  sessionsReady,
  onCreateSession,
}: {
  sessions: ChatSession[]
  sessionsReady: boolean
  onCreateSession: (title?: string) => Promise<ChatSession>
}) => {
  const navigate = useNavigate()
  const hasInitializedRef = useRef(false)
  useEffect(() => {
    if (hasInitializedRef.current) {
      return
    }
    if (!sessionsReady) {
      return
    }
    hasInitializedRef.current = true
    let active = true
    const create = async () => {
      if (sessions.length > 0) {
        const targetSession = selectMostRecentSession(sessions)
        if (targetSession) {
          navigate(`/chat/${targetSession.id}`, { replace: true })
        }
        return
      }
      const newSession = await onCreateSession()
      if (!active) {
        return
      }
      navigate(`/chat/${newSession.id}`, { replace: true })
    }
    create()
    return () => {
      active = false
    }
  }, [navigate, onCreateSession, sessions, sessionsReady])
  return null
}

const ChatRoute = ({
  sessions,
  messages,
  messageCounts,
  drawerOpen,
  syncing,
  sessionsReady,
  isStreaming,
  onStopStreaming,
  onOpenDrawer,
  onCloseDrawer,
  onCreateSession,
  onRenameSession,
  onSendMessage,
  onDeleteMessage,
  onRegenerate,
  onDeleteSession,
  enabledModels,
  defaultModel,
  onSelectModel,
  defaultReasoning,
  onSelectReasoning,
  onArchiveSession,
  onActiveSessionChange,
  user,
}: {
  sessions: ChatSession[]
  messages: ChatMessage[]
  messageCounts: Record<string, number>
  drawerOpen: boolean
  syncing: boolean
  sessionsReady: boolean
  isStreaming: boolean
  onStopStreaming: () => void
  onOpenDrawer: () => void
  onCloseDrawer: () => void
  onCreateSession: (title?: string) => Promise<ChatSession>
  onRenameSession: (sessionId: string, title: string) => Promise<void>
  onSendMessage: (
    sessionId: string,
    text: string,
    options?: { attachments?: Array<{ type: 'image'; url: string; width?: number; height?: number }> },
  ) => Promise<void>
  onDeleteMessage: (messageId: string) => Promise<void>
  onRegenerate: (assistantMessageId: string) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<void>
  enabledModels: string[]
  defaultModel: string
  onSelectModel: (sessionId: string, model: string | null) => Promise<void>
  defaultReasoning: boolean
  onSelectReasoning: (sessionId: string, reasoning: boolean | null) => Promise<void>
  onArchiveSession: (sessionId: string, isArchived: boolean) => Promise<void>
  onActiveSessionChange: (sessionId: string) => void
  user: User | null
}) => {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const activeSession = sessions.find((session) => session.id === sessionId)

  useEffect(() => {
    if (activeSession) {
      onActiveSessionChange(activeSession.id)
    }
  }, [activeSession, onActiveSessionChange])
  const activeMessages = useMemo(() => {
    return messages
      .filter((message) => message.sessionId === sessionId)
      .sort(
        (a, b) =>
          new Date(a.clientCreatedAt ?? a.createdAt).getTime() -
            new Date(b.clientCreatedAt ?? b.createdAt).getTime() ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
  }, [messages, sessionId])

  const handleCreateSession = useCallback(async () => {
    const newSession = await onCreateSession()
    navigate(`/chat/${newSession.id}`)
    onCloseDrawer()
  }, [navigate, onCloseDrawer, onCreateSession])

  const handleSelectSession = useCallback(
    (id: string) => {
      navigate(`/chat/${id}`)
      onCloseDrawer()
    },
    [navigate, onCloseDrawer],
  )

  const handleDeleteSession = useCallback(
    async (id: string) => {
      let nextSessionId: string | null = null
      if (activeSession?.id === id) {
        const remaining = sessions.filter((session) => session.id !== id)
        if (remaining.length > 0) {
          nextSessionId = remaining[0].id
        } else {
          const newSession = await onCreateSession('新会话')
          nextSessionId = newSession.id
        }
      }

      if (nextSessionId) {
        navigate(`/chat/${nextSessionId}`, { replace: true })
      }
      await onDeleteSession(id)
    },
    [activeSession?.id, navigate, onCreateSession, onDeleteSession, sessions],
  )

  useEffect(() => {
    if (!activeSession && sessions.length > 0) {
      const targetSession = selectMostRecentSession(sessions)
      if (targetSession) {
        navigate(`/chat/${targetSession.id}`, { replace: true })
      }
    }
  }, [activeSession, navigate, sessions])

  useEffect(() => {
    if (activeSession || syncing || !sessionsReady || sessions.length > 0) {
      return
    }
    let active = true
    const createSession = async () => {
      const newSession = await onCreateSession('新会话')
      if (!active) {
        return
      }
      navigate(`/chat/${newSession.id}`, { replace: true })
    }
    void createSession()
    return () => {
      active = false
    }
  }, [activeSession, navigate, onCreateSession, sessions.length, sessionsReady, syncing])

  if (!activeSession) {
    return null
  }

  return (
    <>
      <ChatPage
        session={activeSession}
        messages={activeMessages}
        onOpenDrawer={onOpenDrawer}
        onSendMessage={(text, options) => onSendMessage(activeSession.id, text, options)}
        onDeleteMessage={onDeleteMessage}
        onRegenerate={onRegenerate}
        isStreaming={isStreaming}
        onStopStreaming={onStopStreaming}
        enabledModels={enabledModels}
        defaultModel={defaultModel}
        onSelectModel={(model) => onSelectModel(activeSession.id, model)}
        defaultReasoning={defaultReasoning}
        onSelectReasoning={(reasoning) =>
          onSelectReasoning(activeSession.id, reasoning)
        }
        user={user}
      />
      <SessionsDrawer
        open={drawerOpen}
        sessions={sessions}
        messageCounts={messageCounts}
        activeSessionId={activeSession.id}
        syncing={syncing}
        onClose={onCloseDrawer}
        onCreateSession={handleCreateSession}
        onSelectSession={handleSelectSession}
        onRenameSession={onRenameSession}
        onDeleteSession={handleDeleteSession}
        onArchiveSession={onArchiveSession}
      />
    </>
  )
}

export default App
