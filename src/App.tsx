import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import ChatPage from './pages/ChatPage'
import AuthPage from './pages/AuthPage'
import SessionsDrawer from './components/SessionsDrawer'
import type { ChatMessage, ChatSession, UserSettings } from './types'
import { usePendingShare } from './hooks/useShareReceiver'
import {
  addMessage,
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
  buildMemorySystemSection,
  createRemoteSession,
  deleteRemoteMessage,
  deleteRemoteSession,
  fetchHealthSnapshot,
  fetchRemoteMessages,
  fetchRemoteSessions,
  fetchSessionRecentMessages,
  listLockedMemories,
  renameRemoteSession,
  updateMemory,
  updateRemoteSessionArchiveState,
  updateRemoteSessionOverride,
  updateRemoteSessionReasoningOverride,
} from './storage/supabaseSync'
import { hasSupabaseConfig, subscribeSupabaseConfigChange, supabase } from './supabase/client'
import './App.css'
// Heavy routes are code-split — only the active route's chunk loads.
// Keep AuthPage and ChatPage statically imported (they're hit immediately).
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const MyHomePage = lazy(() => import('./pages/MyHomePage'))
const AssistantHomePage = lazy(() => import('./pages/AssistantHomePage'))
const MemoryVaultPage = lazy(() => import('./pages/MemoryVaultPage'))
const CheckinPage = lazy(() => import('./pages/CheckinPage'))
const HealthSyncPage = lazy(() => import('./pages/HealthSyncPage'))
const ExportPage = lazy(() => import('./pages/ExportPage'))
const HomePage = lazy(() => import('./pages/HomePage'))
const HomeLayoutSettingsPage = lazy(() => import('./pages/HomeLayoutSettingsPage'))
const UsagePage = lazy(() => import('./pages/UsagePage'))
import {
  resolveSnackSystemOverlay,
  resolveSyzygyPostPrompt,
  resolveSyzygyReplyPrompt,
} from './constants/aiOverlays'
import { resolveModelId } from './utils/modelResolver'
import { fetchOpenRouter } from './api/openrouter'
import { convertOpenAiRequestToAnthropic } from './api/anthropic'
import { getActiveProvider, getMsuicodeFormat, getProviderConfig } from './storage/apiProvider'
import { ensureImageCaption, getImageCaption } from './storage/imageCaptions'
import { buildStickerSystemSection } from './storage/stickers'
import { recordUsage } from './storage/usageStats'
import { maybeAutoSyncHealth, syncHealthDataToSupabase } from './storage/healthSync'
import { fetchCurrentWeather, peekCachedWeather } from './storage/weather'
import { getDeviceState } from './storage/deviceState'
import { runSandboxCode } from './storage/sandbox'
import {
  TOOL_SEARCH_MEMORY,
  TOOL_SEARCH_HANDOFF,
  TOOL_WEB_SEARCH,
  TOOL_ADD_MEMORY,
  TOOL_WRITE_DIARY,
  TOOL_WRITE_LETTER,
  TOOL_ADD_TIMELINE,
  TOOL_LOG_PERIOD,
  TOOL_LOG_HEALTH,
  TOOL_RUN_CODE,
  TOOL_SCHEDULE_PROACTIVE,
  TOOL_GET_DEVICE_STATE,
  TOOL_MANAGE_MEMORY,
  TOOL_LIST_MEMORIES,
  TOOL_GARDEN_MEMORIES,
  TOOL_CHECK_MEMORY_HEALTH,
  TOOL_GET_HEALTH_STATUS,
  TOOL_PLAY_MUSIC,
  TOOL_CONTROL_MEDIA,
  TOOL_GET_NOW_PLAYING,
} from './tools/definitions'
import { syncStatusBarToAccent, syncStatusBarToColor } from './storage/statusBar'
import {
  cancelProactiveNotification,
  clearPendingProactive,
  clearPersistProactive,
  readPendingProactive,
  readPersistProactive,
  savePendingProactive,
  scheduleProactiveNotification,
  shouldScheduleProactive,
} from './storage/proactiveNotification'
import { Capacitor } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { compressIfNeeded } from './storage/conversationCompression'

const MEMORY_EXTRACT_RECENT_MESSAGES = 24
const AUTO_EXTRACT_USER_TURN_INTERVAL = 12
const AUTO_EXTRACT_COOLDOWN_MS = 10 * 60 * 1000
const AUTO_EXTRACT_PENDING_LIMIT = 50

type ExtractMessageInput = { role: string; content: string }

const buildRecentExtractionMessages = (
  sessionId: string,
  messages: ChatMessage[],
  limit: number,
): ExtractMessageInput[] => {
  const scoped = messages
    .filter((message) => message.sessionId === sessionId && message.content.trim().length > 0)
    .sort(
      (a, b) =>
        new Date(a.clientCreatedAt ?? a.createdAt).getTime() -
          new Date(b.clientCreatedAt ?? b.createdAt).getTime() ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
  return scoped.slice(-limit).map((message) => ({ role: message.role, content: message.content }))
}

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

type CacheControlMarker = { type: 'ephemeral'; ttl?: string }

type RequestContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControlMarker }
  | { type: 'image_url'; image_url: { url: string } }

type SystemTextBlock = { type: 'text'; text: string; cache_control?: CacheControlMarker }

type ChatRequestMessage =
  | { role: 'system'; content: string | SystemTextBlock[] }
  | { role: 'user'; content: string | RequestContentBlock[] }
  | { role: 'assistant'; content: string | null; tool_calls?: StreamingToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

// For Claude / Anthropic models on OpenRouter, mark up to two cache_control
// breakpoints on the last two user-role messages. Anthropic's cache lookup
// walks bottom-up from each breakpoint, so two anchors lets us:
//   1. WRITE a new cache at the latest user turn (the "head" anchor)
//   2. HIT the cache that was written by the previous turn (the "tail"
//      anchor — what was the head in the previous request)
// AND it survives tool iterations: when Claude calls a tool, the next
// iteration appends asst_tool_call + tool_result messages but the
// "last user message" position stays put, so the breakpoint at that
// position stays fixed across all tool rounds within a single user turn.
// Result: tool loops read the cache instead of cold-writing 89K tokens
// every iteration (the 2026-06-02 07:43 chat paid $0.56 for what should
// have been $0.07 because of this).
//
// We tried top-level cache_control (OR's "automatic" mode) for a while;
// it places exactly one breakpoint on the literal last message, which
// rolls forward to tool_result during tool loops — Anthropic then has no
// anchor matching the previously cached prefix and re-writes everything.
// Manual two-anchor breakpoints are the only reliable shape we've found.
const applyClaudeCaching = (
  messages: ChatRequestMessage[],
  model: string,
): ChatRequestMessage[] => {
  if (!isClaudeModel(model)) return messages
  // cache_control markers only do anything on the native Anthropic
  // /v1/messages path. That's OpenRouter (we auto-route Claude there) and
  // the msuicode slot WHEN it's set to Anthropic format (e.g. pointing at
  // 金瓜瓜/PumpkinAPI). On an OpenAI-format relay the markers ride along
  // uselessly, so bail. This used to be hard-gated to OpenRouter only,
  // which is why caching silently did nothing on 金瓜瓜.
  const cacheProvider = getActiveProvider()
  const nativeAnthropic =
    cacheProvider === 'openrouter' ||
    (cacheProvider === 'msuicode' && getMsuicodeFormat() === 'anthropic')
  if (!nativeAnthropic) return messages
  // TTL differs by upstream: OpenRouter honors the 1h extended cache (kept
  // warm by the ~55min keepalive ping); 金瓜瓜-style relays cap at 5m（1h） and
  // can reject ttl:'1h', so there we use the plain 5m ephemeral marker.
  const marker: CacheControlMarker =
    cacheProvider === 'openrouter'
      ? { type: 'ephemeral', ttl: '1h' }
      : { type: 'ephemeral', ttl: '1h' }
  // BP1: the FIRST system message (the foundational character + tool
  // schema layer). Marking it gives Anthropic a stable last-resort
  // anchor that survives every higher-level miss — including the
  // tool-iteration scenario where BP4 has been seen to silently miss
  // on OR despite a byte-identical prefix. Reading 8-15k tokens at BP1
  // is still a big win over a 90k cold write.
  let firstSystemIdx = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === 'system') {
      firstSystemIdx = i
      break
    }
  }
  // BP4 + HEAD: last two user messages. Found bottom-up; we need the
  // last user index anyway for the tool-block check below.
  const userIndices: number[] = []
  for (let i = messages.length - 1; i >= 0 && userIndices.length < 2; i -= 1) {
    if (messages[i].role === 'user') {
      userIndices.push(i)
    }
  }
  // Tool-iteration handling: if there are tool_use / tool_result blocks
  // *after* the last user message, mark BP1 (system) + the last user
  // message — see the branch below for the full rationale.
  //
  // HISTORY (why this used to be "only mark BP1"): an earlier version
  // stripped tool iterations down to BP1 only, after observing
  // cached_tokens=0 + a wasteful ~77k cache write on tool turns. The
  // conclusion at the time ("Anthropic doesn't cache during tool use,
  // so marking HEAD just burns a 2x write") was an OVER-correction: it
  // conflated "mark the last user message" (whose prefix ends BEFORE
  // the tool blocks) with "mark a position that pulls the tool blocks
  // into the cached prefix" (which is what actually caused the $2
  // waste). Marking the last user message reuses the prefix already
  // written when that message was HEAD — a read, not a write. Per
  // Anthropic docs (cache_control is valid on tool_result; walk-up has
  // a 20-block window; our MAX_TOOL_ITERATIONS=4 stays well under it)
  // the history cache hits cleanly. The old behavior silently re-read
  // tens of thousands of history tokens at full price on every tool
  // turn (search_memory fires almost every turn → main cost sink).
  //
  // Detection is structural — we look for tool_use / tool_result in
  // messages after the last user message — not based on a caller-
  // provided iteration counter. The earlier iteration-based check
  // missed the MAX_TOOL_ITERATIONS finalizer call site (App.tsx:2168)
  // which legitimately has tool blocks but isn't inside the loop, and
  // future code paths that load a tool-mid-flow session from storage
  // would have hit the same trap.
  const lastUserIdx = userIndices[0] ?? -1
  let hasToolBlocksAfterLastUser = false
  for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
    const m = messages[i]
    if (m.role === 'tool') {
      hasToolBlocksAfterLastUser = true
      break
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      hasToolBlocksAfterLastUser = true
      break
    }
    if (Array.isArray(m.content)) {
      if ((m.content as Array<{ type?: string }>).some((b) => b?.type === 'tool_result')) {
        hasToolBlocksAfterLastUser = true
        break
      }
    }
  }
  if (hasToolBlocksAfterLastUser) {
    if (firstSystemIdx === -1) return messages
    // Mark BP1 (system) + the last user message.
    // The cache prefix ends at the user message — before any tool blocks —
    // so it IS reusable by the next turn's BP4 walk-up (within the 20-block
    // window per Anthropic docs). We deliberately skip marking the
    // tool_result itself: that would extend the cache prefix to include
    // transient tool blocks that won't appear at the start of any future
    // request, wasting 2× write cost for zero future reads.
    const toolIterTargets = new Set<number>()
    if (firstSystemIdx >= 0) toolIterTargets.add(firstSystemIdx)
    if (lastUserIdx >= 0) toolIterTargets.add(lastUserIdx)
    return messages.map((msg, idx) => {
      if (!toolIterTargets.has(idx)) return msg
      if (msg.role === 'user') return markUserMessageForCaching(msg, marker)
      if (msg.role === 'system') return markSystemMessageForCaching(msg, marker)
      return msg
    })
  }
  if (userIndices.length === 0 && firstSystemIdx === -1) return messages
  const targets = new Set<number>(userIndices)
  if (firstSystemIdx >= 0) targets.add(firstSystemIdx)
  return messages.map((msg, idx) => {
    if (!targets.has(idx)) return msg
    if (msg.role === 'user') return markUserMessageForCaching(msg, marker)
    if (msg.role === 'system') return markSystemMessageForCaching(msg, marker)
    return msg
  })
}

const CACHE_CONTROL_MARKER = { type: 'ephemeral' as const, ttl: '1h' as const }

// cache_control sits on a content block (Anthropic requires array-form
// content for the marker — top-level message cache_control doesn't pass
// through OR cleanly). Shared between markUserMessageForCaching and
// markSystemMessageForCaching to avoid drift; returns the new block
// array with cache_control attached to the last text block, or null
// if no text block exists. Caller decides whether to append an empty
// text-block anchor as fallback.
const attachCacheControlToLastTextBlock = <T extends { type: string; text?: string; cache_control?: CacheControlMarker }>(
  blocks: readonly T[],
  marker: CacheControlMarker = CACHE_CONTROL_MARKER,
): T[] | null => {
  const out = [...blocks]
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].type === 'text') {
      out[i] = { ...out[i], cache_control: marker }
      return out
    }
  }
  return null
}

const markSystemMessageForCaching = (
  msg: ChatRequestMessage,
  marker: CacheControlMarker = CACHE_CONTROL_MARKER,
): ChatRequestMessage => {
  if (msg.role !== 'system') return msg
  if (typeof msg.content === 'string') {
    return {
      ...msg,
      content: [{ type: 'text', text: msg.content, cache_control: marker }],
    }
  }
  const marked = attachCacheControlToLastTextBlock(msg.content, marker)
  return marked ? { ...msg, content: marked } : msg
}

const markUserMessageForCaching = (
  msg: ChatRequestMessage,
  marker: CacheControlMarker = CACHE_CONTROL_MARKER,
): ChatRequestMessage => {
  if (msg.role !== 'user') return msg
  if (typeof msg.content === 'string') {
    return {
      ...msg,
      content: [{ type: 'text', text: msg.content, cache_control: marker }],
    }
  }
  const marked = attachCacheControlToLastTextBlock(msg.content, marker)
  if (marked) return { ...msg, content: marked }
  // Image-only message: append an empty text-block anchor — Anthropic
  // accepts this for cache_control purposes.
  return {
    ...msg,
    content: [...msg.content, { type: 'text', text: '', cache_control: marker }],
  }
}


const isToolCapableModel = (model: string) =>
  /claude|anthropic|gpt-4|gpt-5|openai\//i.test(model)

const isClaudeModel = (model: string) => /claude|anthropic/i.test(model)

const App = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const [sessions, setSessions] = useState<ChatSession[]>(initialSnapshot.sessions)
  const [messages, setMessages] = useState<ChatMessage[]>(initialSnapshot.messages)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolStatus, setToolStatus] = useState('')
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null)
  const [settingsReady, setSettingsReady] = useState(false)
  const [sessionsReady, setSessionsReady] = useState(false)
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null)
  const [supabaseConfigured, setSupabaseConfigured] = useState(() => hasSupabaseConfig())
  const sessionsRef = useRef(sessions)
  const messagesRef = useRef(messages)
  const streamingControllerRef = useRef<AbortController | null>(null)
  // Track when we last received a streamed chunk. Used to detect streams
  // that got silently killed while the app was backgrounded.
  const lastChunkAtRef = useRef<number>(0)
  // Set later (after sendMessage is defined). Visibility handler calls it
  // through the ref to dodge declaration-order.
  const maybeSendProactiveRef = useRef<(sessionId: string) => Promise<void>>(
    async () => undefined,
  )
  // Guards against triple-fire: visibilitychange + appStateChange +
  // localNotificationActionPerformed all call handleVisibilityChange at
  // the same time. Without this, a single foreground event can trigger
  // three parallel nudge sends.
  const proactiveNudgePendingRef = useRef(false)
  // Merges any server-dispatched messages for the current session into
  // local state. Set later via useEffect; ref avoids stale closure.
  const refreshCurrentSessionRef = useRef<(sessionId: string) => Promise<void>>(
    async () => undefined,
  )
  const refreshingSessionRef = useRef(false)
  // Inserts a pre-generated proactive message into the session as an
  // assistant turn. Set later, called via ref for same declaration reason.
  const insertPendingProactiveRef = useRef<
    (entry: { sessionId: string; text: string; fireAt: number; persist?: boolean; queueId?: string }) => Promise<void>
  >(async () => undefined)
  // Keepalive: stash a snapshot of the last successful request body so we
  // can ping it ~55 min later (just before 1h cache TTL expires) with
  // max_tokens: 0 to refresh the cache cheaply.
  const keepaliveTimerRef = useRef<number | null>(null)
  const keepaliveBodyRef = useRef<Record<string, unknown> | null>(null)
  const keepaliveControllerRef = useRef<AbortController | null>(null)
  // Tracks when we last successfully fired a keepalive ping (timer-driven
  // or pre-warm). prewarmKeepaliveIfStale uses this to decide whether to
  // pre-warm on chat-page entry — avoids hammering when the timer has
  // recently fired or pre-warm has already run.
  const keepaliveLastPingedAtRef = useRef<number>(0)
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
    // 朋友圈 (snacks / syzygy) generation is short social content —
    // a couple of sentences per post or reply. Extended thinking adds
    // latency + cost (2x input + write cost) with zero quality lift
    // for this use case. Hardcoded off, decoupled from the chat
    // reasoning toggle which previously bled through here.
    reasoning: false,
    temperature: activeSettings.temperature,
    topP: activeSettings.topP,
    maxTokens: activeSettings.maxTokens,
    systemPrompt: activeSettings.systemPrompt,
    snackSystemOverlay: resolveSnackSystemOverlay(activeSettings.snackSystemOverlay),
    syzygyPostSystemPrompt: resolveSyzygyPostPrompt(activeSettings.syzygyPostSystemPrompt),
    syzygyReplySystemPrompt: resolveSyzygyReplyPrompt(activeSettings.syzygyReplySystemPrompt),
  }), [activeSettings])
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

  const autoExtractStateRef = useRef<
    Record<string, { lastUserCount: number; lastExtractedAt: number }>
  >({})

  useEffect(() => {
    if (!user || !supabase || isStreaming || !activeSettings.autoMemoryExtractEnabled) return
    const sb = supabase
    const latestBySession = new Map<string, number>()
    messages.forEach((message) => {
      if (message.role !== 'user' || !message.content.trim()) return
      latestBySession.set(message.sessionId, (latestBySession.get(message.sessionId) ?? 0) + 1)
    })
    latestBySession.forEach((userCount, sessionId) => {
      if (userCount < AUTO_EXTRACT_USER_TURN_INTERVAL) return
      if (userCount % AUTO_EXTRACT_USER_TURN_INTERVAL !== 0) return
      const currentState = autoExtractStateRef.current[sessionId] ?? { lastUserCount: 0, lastExtractedAt: 0 }
      const now = Date.now()
      if (userCount <= currentState.lastUserCount) return
      if (now - currentState.lastExtractedAt < AUTO_EXTRACT_COOLDOWN_MS) return
      autoExtractStateRef.current[sessionId] = {
        lastUserCount: userCount,
        lastExtractedAt: currentState.lastExtractedAt,
      }
      const recentMsgs = buildRecentExtractionMessages(sessionId, messagesRef.current, MEMORY_EXTRACT_RECENT_MESSAGES)
      if (recentMsgs.length === 0) return
      void (async () => {
        const startMs = Date.now()
        let logEntry: {
          messages_scanned: number
          memories_extracted: number
          memories_inserted: number
          memories_skipped: number
          duration_ms: number
          error: string | null
        } = {
          messages_scanned: recentMsgs.length,
          memories_extracted: 0,
          memories_inserted: 0,
          memories_skipped: 0,
          duration_ms: 0,
          error: null,
        }
        try {
          const { count } = await sb
            .from('memory_entries')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .eq('status', 'pending')
            .eq('is_deleted', false)
          if ((count ?? 0) >= AUTO_EXTRACT_PENDING_LIMIT) {
            logEntry.error = `待确认 ≥ ${AUTO_EXTRACT_PENDING_LIMIT}，跳过`
            logEntry.duration_ms = Date.now() - startMs
            await sb.from('memory_extract_log').insert({ user_id: user.id, ...logEntry })
            return
          }
          autoExtractStateRef.current[sessionId] = { lastUserCount: userCount, lastExtractedAt: Date.now() }
          const provider = getProviderConfig(activeSettings.memoryExtractProvider)
          const { data, error } = await sb.functions.invoke('memory-extract', {
            body: { recentMessages: recentMsgs, apiBase: provider.baseUrl, apiKey: provider.apiKey },
          })
          logEntry.duration_ms = Date.now() - startMs
          if (error) {
            logEntry.error = typeof error === 'object' && error !== null && 'message' in error
              ? String((error as { message: unknown }).message)
              : JSON.stringify(error)
          } else if (data && typeof data === 'object') {
            const d = data as { items?: unknown[]; inserted?: number; skipped?: number }
            logEntry.memories_extracted = Array.isArray(d.items) ? d.items.length : 0
            logEntry.memories_inserted = typeof d.inserted === 'number' ? d.inserted : 0
            logEntry.memories_skipped = typeof d.skipped === 'number' ? d.skipped : 0
          }
          await sb.from('memory_extract_log').insert({ user_id: user.id, ...logEntry })
        } catch (error) {
          logEntry.duration_ms = Date.now() - startMs
          logEntry.error = error instanceof Error ? error.message : String(error)
          console.warn('自动抽取记忆建议失败', error)
          try {
            await sb.from('memory_extract_log').insert({ user_id: user.id, ...logEntry })
          } catch {
            // ignore log write failure
          }
        }
      })()
    })
  }, [activeSettings.autoMemoryExtractEnabled, isStreaming, messages, user])

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

  // Status bar color matches each page's header background.
  useEffect(() => {
    const p = location.pathname
    if (p.startsWith('/chat/')) {
      syncStatusBarToAccent()
    } else if (p.startsWith('/memory') || p.startsWith('/usage')) {
      syncStatusBarToColor('#F8FAFC')
    } else if (p.startsWith('/settings')) {
      syncStatusBarToColor('#FFFFFF')
    } else {
      // Home gradient starts at #F4F8FC — match the bar to that color so
      // the status bar blends seamlessly into the top of the background.
      syncStatusBarToColor('#F4F8FC')
    }
  }, [location.pathname])

  // Warm the weather cache on mount and refresh hourly. Each user message
  // snapshots the cache value at send time into its meta.
  useEffect(() => {
    void fetchCurrentWeather()
    const id = window.setInterval(() => {
      void fetchCurrentWeather()
    }, 60 * 60 * 1000)
    return () => window.clearInterval(id)
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
    // Kick a health sync on mount as well as on each foreground event.
    // The internal 30min throttle keeps this from firing more than once
    // per half-hour if the user is in and out of the app a lot.
    void maybeAutoSyncHealth()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshRemoteSessions()
        // Cancel notification while user is in the app (no in-app popup).
        void cancelProactiveNotification()
        // Pull whatever's new in Health Connect → health_data.
        // Throttled to 30min inside; no-op on web.
        void maybeAutoSyncHealth()
        // Detect "dead stream". Only abort — do NOT null the ref here:
        // the abort makes the in-flight read reject, and sendMessage's
        // finally clears isStreaming + the ref via its `=== controller`
        // guard. Nulling here would make that guard fail, leaving the UI
        // stuck on "正在输入…" forever (and blocking auto memory extract).
        if (streamingControllerRef.current && lastChunkAtRef.current > 0) {
          const ageMs = Date.now() - lastChunkAtRef.current
          if (ageMs > 8000) {
            streamingControllerRef.current.abort()
          }
        }
        // If fire time passed → insert proactive message now. Check both
        // transient and persist buckets — the persist alarm (wake-up
        // etc.) lives in its own storage and would be invisible if we
        // only read the transient one.
        // Clear storage immediately (sync) before the async insert so that
        // the other event sources that also call handleVisibilityChange
        // (appStateChange + localNotificationActionPerformed fire at the
        // same time as visibilitychange) don't re-read the same entry and
        // insert duplicate messages.
        const transientPending = readPendingProactive()
        if (transientPending && Date.now() >= transientPending.fireAt) {
          clearPendingProactive()
          void insertPendingProactiveRef.current(transientPending)
        }
        const persistPending = readPersistProactive()
        if (persistPending && Date.now() >= persistPending.fireAt) {
          clearPersistProactive()
          void insertPendingProactiveRef.current(persistPending)
        }
        // Refresh current session messages: picks up any messages the server
        // dispatched (proactive_dispatch cron) while the app was closed.
        const hashMatch = window.location.hash.match(/#\/chat\/([^/?]+)/)
        if (hashMatch && !refreshingSessionRef.current) {
          refreshingSessionRef.current = true
          void refreshCurrentSessionRef.current(hashMatch[1]).finally(() => {
            refreshingSessionRef.current = false
          })
        }
        if (!transientPending && !persistPending) {
          if (hashMatch && !proactiveNudgePendingRef.current) {
            proactiveNudgePendingRef.current = true
            void maybeSendProactiveRef.current(hashMatch[1]).finally(() => {
              proactiveNudgePendingRef.current = false
            })
          }
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    // Capacitor appStateChange is more reliable than visibilitychange
    // on Android WebView for detecting foreground/background transitions.
    const appStateSubPromise = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        // Coming to foreground — cancel notification + check pending
        handleVisibilityChange()
      } else {
        // Going to background — re-arm the local notification with
        // remaining time so it fires while the user is away. Persist
        // alarms (wake-up etc.) are kept on their own notification ID
        // and storage, so handle them in parallel.
        const transientPending = readPendingProactive()
        if (transientPending && Date.now() < transientPending.fireAt) {
          void scheduleProactiveNotification(
            transientPending.text,
            transientPending.fireAt - Date.now(),
          )
        }
        const persistPending = readPersistProactive()
        if (persistPending && Date.now() < persistPending.fireAt) {
          void scheduleProactiveNotification(
            persistPending.text,
            persistPending.fireAt - Date.now(),
            { persist: true },
          )
        }
      }
    })
    const notifSubPromise = LocalNotifications.addListener(
      'localNotificationActionPerformed',
      () => handleVisibilityChange(),
    )
    // Cold-start trigger: on Android, appStateChange(isActive:true) and
    // visibilitychange both fire before auth resolves, so the listeners above
    // always miss the initial foreground event. setTimeout(0) defers until
    // after all effects in this render cycle have run (including
    // insertPendingProactiveRef and refreshCurrentSessionRef), so refs are
    // ready to handle any pending localStorage proactives.
    const coldStartId = window.setTimeout(() => handleVisibilityChange(), 0)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearTimeout(coldStartId)
      void appStateSubPromise.then((s) => s.remove())
      void notifSubPromise.then((s) => s.remove())
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

  // Client-side keepalive: 55 min after a successful Claude-on-OR chat,
  // fire a max_tokens:1 ping at the same endpoint to refresh the prompt
  // cache before its 1h TTL expires. Anthropic serves the prefix from
  // cache (0.1x of input price), writes a fresh entry, and returns 1
  // token. Only refreshes BP1 reliably (the ping strips `reasoning` to
  // stay cheap, which changes the cache key for HEAD/BP4); the
  // server-side cron at supabase/functions/cache_keepalive covers the
  // case where the app is killed/backgrounded.
  //
  // No quiet hours — an earlier version skipped 23:00-08:00 to "save"
  // pings, but a cold-write next morning ran ~$0.21 on a 57k prompt,
  // dwarfing the ~$0.05 of ping cost across the gap. ChatPage also
  // calls prewarmKeepaliveIfStale below on navigation, which catches
  // the case where the timer dropped (background kill, refresh, etc).
  //
  // Ping shape rules (mirrored on the server-side cache_keepalive edge
  // function):
  //   1. max_tokens: 1 — Anthropic min. 0 → 400; the adapter fallback
  //      then bumps to 4096 and the "cheap" ping turns into a full
  //      generation.
  //   2. keep tools / system / messages / model — they're part of the
  //      cache prefix key. Removing them moves the ping onto a different
  //      cache entry.
  //   3. drop reasoning — extended thinking forces max_tokens up to
  //      budget+1024 (~9024) and Claude actually thinks during the
  //      ping, billing 8000+ thinking tokens. The trade-off: dropping
  //      reasoning changes the request shape so the ping doesn't match
  //      HEAD/BP4's chat cache key. BP1 (system+tools) still hits
  //      because its prefix doesn't depend on thinking config — that
  //      gives the "system always warm" benefit. HEAD/BP4 naturally
  //      expire at 1h if the user is silent >1h.
  //   4. drop tool_choice + usage — OpenAI-shape leftovers that don't
  //      survive the anthropic.ts adapter conversion anyway.
  const firePingNow = useCallback(() => {
    const snapshot = keepaliveBodyRef.current
    if (!snapshot) return
    const pingBody: Record<string, unknown> = {
      ...snapshot,
      max_tokens: 1,
      stream: false,
    }
    delete pingBody.reasoning
    delete pingBody.tool_choice
    delete pingBody.usage
    const controller = new AbortController()
    keepaliveControllerRef.current?.abort()
    keepaliveControllerRef.current = controller
    void fetchOpenRouter('/chat/completions', { body: pingBody, signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          console.warn('keepalive non-2xx', response.status)
          return
        }
        keepaliveLastPingedAtRef.current = Date.now()
        scheduleKeepaliveRef.current?.()
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('keepalive failed', err)
      })
      .finally(() => {
        // Clear the in-flight marker so prewarmKeepaliveIfStale doesn't see
        // a stale "in flight" forever (which would silently disable prewarm
        // after the first ping → cold writes on later sends). Guard against a
        // newer ping having already replaced the ref.
        if (keepaliveControllerRef.current === controller) {
          keepaliveControllerRef.current = null
        }
      })
  }, [])

  // Indirect to break the scheduleKeepalive → firePingNow → schedule
  // cycle. The ref is wired up right after the function declarations.
  const scheduleKeepaliveRef = useRef<(() => void) | null>(null)

  const scheduleKeepalive = useCallback(() => {
    if (keepaliveTimerRef.current !== null) {
      window.clearTimeout(keepaliveTimerRef.current)
      keepaliveTimerRef.current = null
    }
    if (!keepaliveBodyRef.current) return
    const KEEPALIVE_DELAY_MS = 55 * 60 * 1000
    keepaliveTimerRef.current = window.setTimeout(() => {
      keepaliveTimerRef.current = null
      firePingNow()
    }, KEEPALIVE_DELAY_MS)
  }, [firePingNow])

  // Wire the ref so firePingNow can call back into scheduleKeepalive
  // without forming a real circular dependency in the useCallback graph.
  scheduleKeepaliveRef.current = scheduleKeepalive

  // Pre-warm hook: called by ChatPage when the user navigates into a
  // chat. If we already have a body to ping and our last ping was more
  // than PREWARM_STALE_MS ago, fire one immediately so the cache is
  // fresh by the time they hit send. Cheap (~$0.005 if BP1 still warm,
  // at worst $0.21 if cache is fully cold — but we'd have paid that
  // $0.21 on the user's first message either way, this just shifts it
  // a few seconds earlier so the user doesn't see latency on send).
  // Cheap-no-op when there's no body cached (e.g. fresh app start
  // before any chat), or when the last ping is recent.
  const prewarmKeepaliveIfStale = useCallback(() => {
    if (!keepaliveBodyRef.current) return
    if (keepaliveControllerRef.current) return // one already in flight
    const PREWARM_STALE_MS = 50 * 60 * 1000
    const lastPing = keepaliveLastPingedAtRef.current
    if (lastPing > 0 && Date.now() - lastPing < PREWARM_STALE_MS) return
    firePingNow()
  }, [firePingNow])

  const cancelKeepalive = useCallback(() => {
    if (keepaliveTimerRef.current !== null) {
      window.clearTimeout(keepaliveTimerRef.current)
      keepaliveTimerRef.current = null
    }
    keepaliveControllerRef.current?.abort()
    keepaliveControllerRef.current = null
  }, [])

  const sendMessage = useCallback(
    async (
      sessionId: string,
      content: string,
      options?: {
        skipUser?: boolean
        attachments?: Array<{ type: 'image'; url: string; width?: number; height?: number }>
        proactiveNudge?: string
      },
    ) => {
      const skipUser = options?.skipUser === true
      const userAttachments = options?.attachments ?? []
      const proactiveNudge = options?.proactiveNudge
      const fallbackSettings = createDefaultSettings(user?.id ?? 'local')
      const activeSettings = settingsRef.current ?? fallbackSettings
      const effectiveModel = resolveSessionModel(sessionId)
      const reasoningEnabled = resolveSessionReasoning(sessionId)
      const paramsSnapshot = {
        temperature: activeSettings.temperature,
        top_p: activeSettings.topP,
        max_tokens: activeSettings.maxTokens,
      }
      // Auto-inject the user's LOCKED (pinned) memories into the cached system
      // prefix so the AI always knows the curated facts without calling
      // search_memory. Only locked ones — the vault has too much noise to inject
      // wholesale. Stable order keeps the prefix byte-stable for prompt caching;
      // the block only shifts when the user locks/unlocks/edits a memory.
      let memorySection = ''
      try {
        memorySection = buildMemorySystemSection(await listLockedMemories())
      } catch (memErr) {
        console.warn('注入核心记忆失败', memErr)
      }
      // When tools are available, remind the model that tools are REAL
      // actions. In deep roleplay the model sometimes narrates "好，我设置好提醒了"
      // without ever emitting the schedule_proactive_message tool call, so
      // nothing actually gets scheduled (confirmed in prod: assistant turns
      // claiming a reminder was set with no tool_call in meta). This nudge
      // is part of the stable cached prefix.
      const willHaveTools = isToolCapableModel(effectiveModel) && Boolean(supabase)
      const toolActionReminder = willHaveTools
        ? '\n\n【工具 = 真实动作，必须真调用】当你打算"待会提醒她 / 晚点联系她 / 叫她起床 / 到点喊她"时，必须真的调用 schedule_proactive_message 工具，拿到 ok 才算数。只在回复里说"我设置好了 / 待会提醒你"却没调用工具，是无效的——不会真的发出任何提醒，她也收不到。放歌、记录健康/经期等同理：先真的调用对应工具，再用你的语气说话。'
        : ''
      const systemPrompt =
        (activeSettings.systemPrompt ?? '') + memorySection + buildStickerSystemSection() + toolActionReminder
      const isFirstMessageInSession = !messagesRef.current.some(
        (message) =>
          message.sessionId === sessionId &&
          message.role === 'user' &&
          message.content.trim().length > 0,
      )
      const clientId = createClientId()
      const clientCreatedAt = new Date().toISOString()
      // Snapshot current weather (if cached) only on the day's first
      // user message — Claude doesn't need to see it on every turn,
      // and it keeps the prompt cleaner. Per-day tracker in localStorage.
      // If the weather changes later in the day, Claude can fall back to
      // the web_search tool to grab a fresh reading instead of relying
      // on this morning snapshot.
      const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
      const WEATHER_DATE_KEY = 'nimbus_weather_injected_date'
      const lastWeatherDate = typeof window !== 'undefined'
        ? window.localStorage.getItem(WEATHER_DATE_KEY)
        : null
      const shouldInjectWeather = lastWeatherDate !== todayCN
      const weatherSnap = shouldInjectWeather ? peekCachedWeather() : null
      if (weatherSnap && typeof window !== 'undefined') {
        window.localStorage.setItem(WEATHER_DATE_KEY, todayCN)
      }

      // Health + device snapshot — injected once per day on the first message,
      // same pattern as weather. Claude naturally notices sleep/steps/period/battery
      // without needing to call any tool.
      const HEALTH_DATE_KEY = 'nimbus_health_injected_date'
      const lastHealthDate = typeof window !== 'undefined'
        ? window.localStorage.getItem(HEALTH_DATE_KEY)
        : null
      const shouldInjectHealth = lastHealthDate !== todayCN
      let healthSnap: string | null = null
      let deviceSnap: string | null = null
      if (shouldInjectHealth) {
        // On APK, force a Health Connect sync before reading the snapshot so
        // sleep data from last night is already in Supabase when we query.
        if (Capacitor.getPlatform() !== 'web') {
          try { await syncHealthDataToSupabase({ force: true }) } catch { /* non-fatal */ }
        }
        if (supabase) {
          try {
            healthSnap = await fetchHealthSnapshot()
          } catch { /* non-fatal */ }
          // Mark today as attempted whether or not we got data, so we don't
          // hit Supabase on every message when Health Connect has no data yet.
          if (typeof window !== 'undefined') {
            window.localStorage.setItem(HEALTH_DATE_KEY, todayCN)
          }
        }
        if (Capacitor.getPlatform() !== 'web') {
          try {
            const ds = await getDeviceState()
            if (ds.battery_percent !== null) {
              deviceSnap = `🔋${ds.battery_percent}%${ds.is_charging ? ' 充电中' : ''}`
            }
          } catch { /* non-fatal */ }
        }
      }

      const userMeta: ChatMessage['meta'] = {
        ...(userAttachments.length > 0 ? { attachments: userAttachments } : {}),
        ...(weatherSnap
          ? {
              weather: {
                temperatureC: weatherSnap.temperatureC,
                feelsLikeC: weatherSnap.feelsLikeC,
                condition: weatherSnap.condition,
              },
            }
          : {}),
        ...(healthSnap ? { healthSnapshot: healthSnap } : {}),
        ...(deviceSnap ? { deviceSnapshot: deviceSnap } : {}),
      }
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
          // Save locally first — instant, works offline, no network dependency.
          const localResult = addMessage(sessionId, 'user', content, userMeta, {
            clientId,
            clientCreatedAt,
          })
          if (localResult) {
            const updatedMessages = updateMessage(messagesRef.current, {
              ...localResult.message,
              pending: false,
            })
            const updatedSessions = sessionsRef.current.map((session) =>
              session.id === sessionId ? { ...session, updatedAt: localResult.session.updatedAt } : session,
            )
            applySnapshot(updatedSessions, updatedMessages)
          }
          // Sync to cloud in background — never block the API call on this.
          // Without VPN Supabase may be unreachable; the 5s timeout + catch
          // ensures the send always proceeds.
          if (user && supabase) {
            void Promise.race([
              addRemoteMessage(sessionId, user.id, 'user', content, clientId, clientCreatedAt, userMeta),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('supabase timeout')), 5000)),
            ])
              .then(({ message: savedUserMessage, updatedAt }) => {
                const updatedMessages = updateMessage(messagesRef.current, {
                  ...savedUserMessage,
                  pending: false,
                })
                const updatedSessions = sessionsRef.current.map((session) =>
                  session.id === sessionId ? { ...session, updatedAt } : session,
                )
                applySnapshot(updatedSessions, updatedMessages)
              })
              .catch((err) => {
                console.warn('后台同步用户消息失败', err)
              })
          }
        }

        let assistantContent = ''
        const toolCallRecords: Array<{
          name: string; args: unknown; result: unknown; duration_ms: number; timestamp: string
        }> = []
        let reasoningContent = ''
        let reasoningType: 'reasoning' | 'thinking' | null = null
        let actualModel = effectiveModel
        let pendingDelta = ''
        let pendingReasoningDelta = ''
        let flushTimer: number | null = null
        let thinkCarry = ''
        let isInThink = false
        let currentIterationReasoning = ''
        const flowEvents: Array<
          | { type: 'thinking'; content: string }
          | { type: 'tool'; index: number }
        > = []
        let lastUsage: {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        } | null = null
        let currentRequestDebug: unknown = null

        const flushUsageRecord = (failed = false) => {
          if (!user) {
            return
          }
          // Only record when the upstream actually returned a usage payload
          // (= something was billed). A hard failure / empty error returns no
          // usage → nothing was charged → don't pollute 用量统计 with a
          // 0-token "failed message" row (it just inflated the call count).
          if (!lastUsage) {
            return
          }
          const cached =
            Number(lastUsage?.prompt_tokens_details?.cached_tokens ?? lastUsage?.cache_read_input_tokens ?? 0)
          console.log(
            `[cache-debug] model=${actualModel} prompt=${lastUsage?.prompt_tokens ?? '?'} completion=${lastUsage?.completion_tokens ?? '?'} ` +
            `cached=${cached} cache_read=${lastUsage?.cache_read_input_tokens ?? 0} cache_create=${lastUsage?.cache_creation_input_tokens ?? 0} ` +
            `usage_keys=${Object.keys(lastUsage ?? {}).join(',')}`,
          )
          void recordUsage({
            userId: user.id,
            model: actualModel,
            promptTokens: Number(lastUsage?.prompt_tokens ?? 0),
            completionTokens: Number(lastUsage?.completion_tokens ?? 0),
            totalTokens: Number(lastUsage?.total_tokens ?? 0),
            cachedTokens: cached,
            source: 'chat',
            provider: getActiveProvider(),
            sessionId,
            rawUsage: lastUsage,
            // request_debug is never read by the UI — it only exists to
            // troubleshoot failures. Keep it only when the request failed (and
            // still produced a usage payload, i.e. partial spend); null on
            // success. We no longer force-insert zero-token failure rows —
            // those only cluttered 用量统计 without representing any cost.
            requestDebug: failed ? currentRequestDebug : null,
          })
          lastUsage = null
          currentRequestDebug = null
        }

        // Support both <think> (DeepSeek/QwQ) and <thinking> (some Claude-compatible routes)
        const openTagOptions = ['<thinking>', '<think>'] as const
        const closeTagMap: Record<string, string> = {
          '<thinking>': '</thinking>',
          '<think>': '</think>',
        }
        let activeCloseTag = ''

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

        const findPartialOpenSuffix = (text: string): string => {
          let best = ''
          for (const tag of openTagOptions) {
            const p = findPartialSuffix(text, tag)
            if (p.length > best.length) best = p
          }
          return best
        }

        const splitReasoningFromContent = (delta: string) => {
          let text = `${thinkCarry}${delta}`
          thinkCarry = ''
          let contentChunk = ''
          let reasoningChunk = ''

          while (text.length > 0) {
            if (isInThink) {
              const closeTag = activeCloseTag
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
                activeCloseTag = ''
              }
            } else {
              // Find earliest open tag; prefer longer match when tied (openTagOptions is longer-first)
              let earliestIndex = -1
              let matchedOpenTag = ''
              for (const tag of openTagOptions) {
                const idx = text.indexOf(tag)
                if (idx !== -1 && (earliestIndex === -1 || idx < earliestIndex)) {
                  earliestIndex = idx
                  matchedOpenTag = tag
                }
              }
              if (earliestIndex === -1) {
                const partial = findPartialOpenSuffix(text)
                const cutoff = text.length - partial.length
                contentChunk += text.slice(0, cutoff)
                thinkCarry = partial
                text = ''
              } else {
                contentChunk += text.slice(0, earliestIndex)
                text = text.slice(earliestIndex + matchedOpenTag.length)
                isInThink = true
                activeCloseTag = closeTagMap[matchedOpenTag]
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
          currentIterationReasoning += text
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
          if (!streaming && toolCallRecords.length > 0) {
            meta.tool_calls = toolCallRecords
          }
          if (!streaming && flowEvents.length > 0) {
            meta.flow = flowEvents
          }
          return meta
        }

        // Tool status is shown in a dedicated bar between messages and composer
        // (see ChatPage.tsx) instead of being embedded in message content.
        // This keeps the bubble clean and the status always visible at the bottom.

        const buildDisplayContent = () => assistantContent

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

        const scheduleFlush = () => {
          if (flushTimer !== null) {
            return
          }
          flushTimer = window.setTimeout(() => {
            flushTimer = null
            flushPending()
          }, 50)
        }

        // Declared outside the try so the finally block can compare against it.
        let controller: AbortController | null = null
        try {
          const sessionMessages = messagesRef.current.filter(
            (message) =>
              message.sessionId === sessionId &&
              message.content.trim().length > 0 &&
              !message.meta?.streaming,
          )
          // Tool-aware compression: fire at 35% of context limit (70k for Claude)
          // instead of the default 65% (130k). Anthropic's cache walk-up silently
          // fails when tool_use/tool_result blocks follow the user message, so
          // BP4/HEAD never hit — only BP1 (~15k) reads, the other 62k re-reads at
          // $15/M every iteration. Compressing before the first tool call cuts the
          // context to ~20k and drops tool-iteration cost from ~$1.18 to ~$0.06.
          const toolsEnabledForCompression = isToolCapableModel(effectiveModel) && Boolean(supabase)
          const effectiveTriggerRatio = toolsEnabledForCompression
            ? Math.min(activeSettings.compressionTriggerRatio, 0.35)
            : activeSettings.compressionTriggerRatio
          const compressionOutcome = await compressIfNeeded(
            sessionId,
            sessionMessages,
            systemPrompt ?? '',
            effectiveModel,
            {
              enabled: activeSettings.compressionEnabled,
              triggerRatio: effectiveTriggerRatio,
              keepRecentMessages: activeSettings.compressionKeepRecentMessages,
              summarizerModel: activeSettings.summarizerModel,
              summarizerProvider: activeSettings.summarizerProvider,
            },
          )
          const baseMessages: ChatRequestMessage[] = []
          // Snapshot any pending proactive that's about to be cancelled below
          // (by clearPendingProactive / cancelProactiveNotification), so we
          // can surface a system note further down and let the model decide
          // whether to re-arm.
          const cancelledProactive = skipUser ? null : readPendingProactive()
          // Trim before checking + sending so a whitespace-only system
          // prompt doesn't end up as { role: 'system', content: '   ' }
          // — relays sometimes reject that as an empty content block.
          const trimmedSystem = compressionOutcome.systemPromptText.trim()
          if (trimmedSystem.length > 0) {
            baseMessages.push({ role: 'system', content: trimmedSystem })
          }
          const trimmedSummary = compressionOutcome.summaryText?.trim() ?? ''
          if (trimmedSummary.length > 0) {
            baseMessages.push({
              role: 'system',
              content: `## 前面对话的摘要（用作上下文，不要直接复述）\n${trimmedSummary}`,
            })
          }
          // Use each message's own createdAt to build a stable time prefix.
          // Critical for prompt caching: every prior turn must produce identical
          // bytes across requests, so we cannot use a fresh `new Date()` here —
          // that would change the prefix on every send.
          const formatStamp = (iso: string) => {
            const d = new Date(iso)
            return Number.isNaN(d.getTime())
              ? ''
              : d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          }
          for (const message of compressionOutcome.recentMessages) {
            const messageAttachments = message.meta?.attachments ?? []
            const imageAttachments = messageAttachments.filter((a) => a.type === 'image')
            const stamp = message.role === 'user' ? formatStamp(message.createdAt) : ''
            const weatherMeta = message.role === 'user' ? message.meta?.weather : undefined
            const weatherStr = weatherMeta
              ? ` [当时天气] ${weatherMeta.temperatureC}°C ${weatherMeta.condition}`
              : ''
            const healthMeta = message.role === 'user' ? message.meta?.healthSnapshot : undefined
            const deviceMeta = message.role === 'user' ? message.meta?.deviceSnapshot : undefined
            const statusParts = [healthMeta, deviceMeta].filter(Boolean)
            const statusStr = statusParts.length > 0
              ? `\n[TA 今日状态] ${statusParts.join('；')}`
              : ''
            const prefix = stamp ? `[当前时间] ${stamp}${weatherStr}${statusStr}\n\n` : ''
            if (message.role === 'user' && imageAttachments.length > 0) {
              const blocks: RequestContentBlock[] = []
              const textContent = `${prefix}${message.content}`
              if (textContent.trim().length > 0) {
                blocks.push({ type: 'text', text: textContent })
              }
              for (const att of imageAttachments) {
                // Send the cached text description if we have one (every turn
                // after the first); otherwise send the real image and kick
                // off captioning so later turns send text instead. The
                // original image stays in storage for display — only what we
                // send the model changes. See storage/imageCaptions.ts.
                const caption = getImageCaption(att.url)
                if (caption) {
                  blocks.push({ type: 'text', text: `[图片：${caption}]` })
                } else {
                  blocks.push({ type: 'image_url', image_url: { url: att.url } })
                  void ensureImageCaption(att.url, effectiveModel, getActiveProvider())
                }
              }
              baseMessages.push({ role: 'user', content: blocks })
            } else {
              const content = message.role === 'user' ? `${prefix}${message.content}` : message.content
              baseMessages.push({ role: message.role, content } as ChatRequestMessage)
            }
          }
          // Proactive mode: append a transient system instruction at the
          // tail so Claude generates a follow-up based on context. Not
          // stored anywhere — only this request sees it.
          if (proactiveNudge) {
            baseMessages.push({ role: 'system', content: proactiveNudge })
          }
          // Tell the model when a previously-armed proactive ping was just
          // cancelled by this user message, so it can decide whether to
          // re-arm one in its reply. Skip during proactive-nudge mode since
          // that's already a system-driven turn.
          if (cancelledProactive && !proactiveNudge) {
            const originalFire = new Date(cancelledProactive.fireAt).toLocaleString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })
            baseMessages.push({
              role: 'system',
              content: `[内部系统提示] 你之前用 schedule_proactive_message 预约的「${cancelledProactive.text}」（原定 ${originalFire} 发送）因用户刚刚发新消息已自动取消。如果你判断后续仍需要这条提醒/关心，请在本次回复里重新调用 schedule_proactive_message；如果对话已经转向不再需要，就不用调。`,
            })
          }
          const toolsEnabled = isToolCapableModel(effectiveModel) && Boolean(supabase)
          const MAX_TOOL_ITERATIONS = 4

          controller = new AbortController()
          streamingControllerRef.current?.abort()
          streamingControllerRef.current = controller
          // Cancel any pending keepalive — the real send is about to refresh
          // the cache anyway, no need to ping in parallel.
          cancelKeepalive()
          void cancelProactiveNotification()
          clearPendingProactive()
          // Cancel any unsent server-side proactive pushes too — but only
          // the transient ones, matching clearPendingProactive above. Persist
          // entries (wake-up alarms etc.) must survive a chat reply, both in
          // localStorage and in the server queue, so we scope by persist=false.
          if (supabase && user) {
            void supabase
              .from('proactive_queue')
              .delete()
              .eq('user_id', user.id)
              .eq('sent', false)
              .eq('persist', false)
          }
          lastChunkAtRef.current = Date.now()
          setIsStreaming(true)

          let iteration = 0
          let conversationDone = false
          // Captured on every iteration so we can snapshot the final-iteration
          // body for keepalive after success.
          let lastSentBody: Record<string, unknown> | null = null

          while (!conversationDone && iteration < MAX_TOOL_ITERATIONS) {
            iteration++
            // Reset think-tag parser state at the start of each iteration.
            // If the model opened <thinking> but triggered a tool call before
            // closing the tag, isInThink would stay true and the next
            // iteration's actual response would be swallowed into reasoning.
            isInThink = false
            thinkCarry = ''
            activeCloseTag = ''
            // Mark where this iteration's text starts in the cumulative
            // assistantContent stream. When pushing this iteration's
            // assistant-with-tool-calls message into baseMessages below,
            // we slice from here — otherwise the previous iteration's text
            // gets duplicated into the next request's assistant message.
            const iterationContentStart = assistantContent.length
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
            // Per-message cache_control breakpoints (BP1 + BP4 + HEAD)
            // are placed inside cachedMessages by applyClaudeCaching above.
            // Here we add the provider-level routing hints that make those
            // markers actually land cache hits.
            //
            // `user` field — sticky-route this user's requests to the same
            // upstream backend node. Required for cache reads to land on
            // the node that did the previous write. Anthropic native (via
            // our msuicode adapter) maps this to metadata.user_id; OR
            // ignores it for its own routing (which is hash-based on the
            // system + first message), but it's harmless there.
            //
            // OR-specific: pin to Anthropic direct (skip Bedrock / Vertex),
            // since per-message cache_control only works on the native
            // Anthropic upstream. 1h TTL: writes 2x, reads 0.1x.
            if (isClaudeModel(effectiveModel)) {
              if (user?.id) {
                requestBody.user = user.id
              }
              if (getActiveProvider() === 'openrouter') {
                requestBody.provider = {
                  order: ['Anthropic'],
                  allow_fallbacks: false,
                }
              }
            }
            if (toolsEnabled) {
              requestBody.tools = [
                TOOL_SEARCH_MEMORY,
TOOL_SEARCH_HANDOFF,
                TOOL_WEB_SEARCH,
                TOOL_ADD_MEMORY,
                TOOL_MANAGE_MEMORY,
                TOOL_LIST_MEMORIES,
                TOOL_GARDEN_MEMORIES,
                TOOL_CHECK_MEMORY_HEALTH,
                TOOL_GET_HEALTH_STATUS,
                TOOL_WRITE_DIARY,
                TOOL_WRITE_LETTER,
                TOOL_ADD_TIMELINE,
                TOOL_LOG_PERIOD,
                TOOL_LOG_HEALTH,
                TOOL_RUN_CODE,
                ...(Capacitor.getPlatform() !== 'web' ? [TOOL_GET_DEVICE_STATE, TOOL_SCHEDULE_PROACTIVE, TOOL_PLAY_MUSIC, TOOL_CONTROL_MEDIA, TOOL_GET_NOW_PLAYING] : []),
              ]
              requestBody.tool_choice = 'auto'
            }
            // Extended thinking is only worth the cost on the opening turn
            // (where the model decides strategy) and the final text reply.
            // Tool iterations 2-4 are just the model scanning a tool result
            // and deciding which function to call next — 8000 thinking tokens
            // per iteration at completion rates (~$0.12/iteration) for that
            // is pure waste. The "笨笨的" symptom (OR silently dropping
            // thinking when max_tokens is too low) is also avoided on those
            // iterations since we skip the whole reasoning block.
            if (reasoningEnabled && isClaudeModel(effectiveModel) && iteration === 1) {
              const thinkingBudget = 2000
              requestBody.reasoning = { max_tokens: thinkingBudget }
              const currentMaxTokens =
                typeof requestBody.max_tokens === 'number' ? requestBody.max_tokens : 0
              requestBody.max_tokens = Math.max(currentMaxTokens, thinkingBudget + 1024)
              delete requestBody.temperature
              delete requestBody.top_p
            } else if (reasoningEnabled && activeSettings.chatHighReasoningEnabled && iteration === 1) {
              requestBody.reasoning = { effort: 'high' }
            }

            // Tool-selection iterations (2-3) only need to output a short
            // function-call JSON blob — cap tokens to avoid verbose preambles.
            // Iteration 4 keeps full tokens (last loop pass, likely final reply).
            // The force-final-text path below always restores paramsSnapshot.max_tokens.
            if (iteration > 1 && iteration < MAX_TOOL_ITERATIONS) {
              requestBody.max_tokens = Math.min(
                typeof requestBody.max_tokens === 'number' ? requestBody.max_tokens : 512,
                512,
              )
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

            lastSentBody = requestBody
            console.log(
              `[cache-debug] req iter=${iteration} msgs=${cachedMessages.length} markers=${debugBreakpoints.filter((b) => b.cache_control).length} ` +
              `bps=${debugBreakpoints.filter((b) => b.cache_control).map((b) => `${b.role}[${b.idx}]`).join(',')} ` +
              `tools=${Array.isArray(requestBody.tools) ? (requestBody.tools as unknown[]).length : 0} reasoning=${requestBody.reasoning != null}`,
            )
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
                lastChunkAtRef.current = Date.now()
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
                            // Fallback id — some OpenRouter-routed providers
                            // omit the id on the first chunk (or never), and
                            // a `tool_call_id: ''` in the next request makes
                            // them 400 the whole turn. Overwrite if a real
                            // id arrives.
                            id: `call_${slot}`,
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
              // Record any thinking from this iteration before the tool calls.
              if (currentIterationReasoning.trim()) {
                flowEvents.push({ type: 'thinking', content: currentIterationReasoning.trim() })
              }
              currentIterationReasoning = ''
              const toolIndexStart = toolCallRecords.length

              // Some relay gateways / Anthropic-on-the-other-side reject
              // assistant messages whose content is an empty string when
              // tool_calls is set. Per OpenAI spec content can be null —
              // emit null when the model produced only tool calls this
              // turn so we don't trip "text content blocks must be non-
              // empty" 400s downstream.
              const iterationText = assistantContent.slice(iterationContentStart).trim()
              baseMessages.push({
                role: 'assistant',
                content: iterationText.length > 0 ? iterationText : null,
                tool_calls: toolCallsArr,
              })
              for (const tc of toolCallsArr) {
                let resultText: string
                const toolStart = Date.now()
                try {
                  if (tc.function.name === 'search_memory' && supabase) {
                    let args: {
                      query?: string
                      count?: number
                      category?: string
                      table?: string
                      tags?: string[]
                      days?: number
                      after?: string
                      before?: string
                    } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}') as typeof args
                    } catch (jsonError) {
                      console.warn('解析 search_memory 参数失败', jsonError)
                    }
                    const tableLabel = args.table ? `(${args.table})` : ''
                    const queryLabel = (args.query ?? '').toString().trim().slice(0, 40)
                    setToolStatus(
                      queryLabel
                        ? `🔍 正在搜索记忆库${tableLabel}：${queryLabel}…`
                        : '🔍 正在搜索记忆库…',
                    )
                    const { data, error } = await supabase.functions.invoke('search_memory', {
                      body: {
                        query: args.query,
                        count: args.count,
                        category: args.category,
                        table: args.table,
                        tags: args.tags,
                        days: args.days,
                        after: args.after,
                        before: args.before,
                      },
                    })
                    resultText = error
                      ? JSON.stringify({ error: error.message ?? String(error) })
                      : JSON.stringify(data ?? {})
                 } else if (tc.function.name === 'search_handoff' && supabase) {
                    let args: { query?: string; count?: number } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}') as typeof args
                    } catch (jsonError) {
                      console.warn('解析 search_handoff 参数失败', jsonError)
                    }
                    const queryLabel = (args.query ?? '').toString().trim().slice(0, 40)
                    setToolStatus(
                      queryLabel
                        ? `📜 正在翻交接信：${queryLabel}…`
                        : '📜 正在翻交接信…',
                    )
                    const { data, error } = await supabase.functions.invoke('search_handoff', {
                      body: {
                        query: args.query,
                        count: args.count,
                      },
                    })
                    resultText = error
                      ? JSON.stringify({ error: error.message ?? String(error) })
                      : JSON.stringify(data ?? {}) } else if (tc.function.name === 'web_search' && supabase) {
                    let args: { query?: string; max_results?: number } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}') as typeof args
                    } catch (jsonError) {
                      console.warn('解析 web_search 参数失败', jsonError)
                    }
                    const queryLabel = (args.query ?? '').toString().trim().slice(0, 40)
                    setToolStatus(
                      queryLabel
                        ? `🌐 正在搜索网络：${queryLabel}…`
                        : '🌐 正在搜索网络…',
                    )
                    const { data, error } = await supabase.functions.invoke('web_search', {
                      body: {
                        query: args.query,
                        max_results: args.max_results,
                      },
                    })
                    resultText = error
                      ? JSON.stringify({ error: error.message ?? String(error) })
                      : JSON.stringify(data ?? {})
                  } else if (tc.function.name === 'run_code') {
                    let args: { language?: 'python' | 'javascript'; code?: string; timeout_seconds?: number } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}') as typeof args
                    } catch (jsonError) {
                      console.warn('解析 run_code 参数失败', jsonError)
                    }
                    const language = args.language === 'javascript' ? 'javascript' : 'python'
                    const codeSnippet = String(args.code ?? '')
                    setToolStatus(`🧪 沙盒执行 ${language}…`)
                    const out = await runSandboxCode({
                      language,
                      code: codeSnippet,
                      timeout_seconds: typeof args.timeout_seconds === 'number' ? args.timeout_seconds : undefined,
                    })
                    resultText = JSON.stringify(out)
                  } else if (
                    (tc.function.name === 'add_memory' ||
                      tc.function.name === 'write_diary' ||
                      tc.function.name === 'write_handoff_letter' ||
                      tc.function.name === 'add_timeline_event' ||
                      tc.function.name === 'log_period' ||
                      tc.function.name === 'log_health') &&
                    supabase
                  ) {
                    let args: Record<string, unknown> = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}')
                    } catch (jsonError) {
                      console.warn(`解析 ${tc.function.name} 参数失败`, jsonError)
                    }
                    // Map tool name -> table + payload shape. Tables, fields, and
                    // defaults match the schema (memories/diaries/handoff_letters/
                    // timeline/period_tracking).
                    let table = ''
                    let payload: Record<string, unknown> = {}
                    let labelText = ''
                    if (tc.function.name === 'add_memory') {
                      table = 'memories'
                      payload = {
                        content: String(args.content ?? '').trim(),
                        category: typeof args.category === 'string' && args.category.trim() ? args.category.trim() : null,
                        tags: Array.isArray(args.tags) ? args.tags.map(String) : null,
                      }
                      labelText = `📝 写入记忆：${payload.content?.toString().slice(0, 30) ?? ''}`
                    } else if (tc.function.name === 'write_diary') {
                      table = 'diaries'
                      payload = {
                        date: String(args.date ?? ''),
                        content: String(args.content ?? '').trim(),
                        title: typeof args.title === 'string' ? args.title : null,
                        mood: typeof args.mood === 'string' ? args.mood : null,
                      }
                      labelText = `📔 写日记：${payload.date}`
                    } else if (tc.function.name === 'write_handoff_letter') {
                      table = 'handoff_letters'
                      payload = {
                        title: String(args.title ?? '').trim(),
                        content: String(args.content ?? '').trim(),
                        date: typeof args.date === 'string' && args.date ? args.date : new Date().toISOString().slice(0, 10),
                        signature: typeof args.signature === 'string' ? args.signature : null,
                      }
                      labelText = `✉️ 写交接信：${payload.title}`
                    } else if (tc.function.name === 'add_timeline_event') {
                      table = 'timeline'
                      payload = {
                        event_date: String(args.event_date ?? ''),
                        title: String(args.title ?? '').trim(),
                        description: typeof args.description === 'string' ? args.description : null,
                        category: typeof args.category === 'string' && args.category.trim() ? args.category.trim() : null,
                        importance: typeof args.importance === 'number' ? Math.max(1, Math.min(5, Math.round(args.importance))) : null,
                      }
                      labelText = `📍 时间轴：${payload.title}`
                    } else if (tc.function.name === 'log_period') {
                      table = 'period_tracking'
                      payload = {
                        start_date: String(args.start_date ?? ''),
                        end_date: typeof args.end_date === 'string' && args.end_date ? args.end_date : null,
                        cycle_length: typeof args.cycle_length === 'number' ? args.cycle_length : null,
                        notes: typeof args.notes === 'string' ? args.notes : null,
                      }
                      labelText = `🩸 记录经期：${payload.start_date}`
                    } else if (tc.function.name === 'log_health') {
                      table = 'health_data'
                      const todayStr = new Date().toISOString().slice(0, 10)
                      payload = {
                        date: typeof args.date === 'string' && args.date ? args.date : todayStr,
                        sleep_hours: typeof args.sleep_hours === 'number' ? args.sleep_hours : null,
                        sleep_quality: typeof args.sleep_quality === 'string' ? args.sleep_quality : null,
                        heart_rate_avg: typeof args.heart_rate_avg === 'number' ? Math.round(args.heart_rate_avg) : null,
                        heart_rate_rest: typeof args.heart_rate_rest === 'number' ? Math.round(args.heart_rate_rest) : null,
                        steps: typeof args.steps === 'number' ? Math.round(args.steps) : null,
                        notes: typeof args.notes === 'string' ? args.notes : null,
                      }
                      labelText = `💗 记录身体状态：${payload.date}`
                    }
                    setToolStatus(labelText)
                    // Strip nulls so DB defaults kick in.
                    const cleaned: Record<string, unknown> = {}
                    for (const [k, v] of Object.entries(payload)) {
                      if (v !== null && v !== '') cleaned[k] = v
                    }
                    // health_data has no unique constraint on `date`, and the
                    // auto health sync / log_health edge function both upsert
                    // by date. A plain insert here would create a 2nd row for a
                    // day that already has data, then break the date-keyed
                    // .maybeSingle() reads (it errors on >1 match). Mirror the
                    // upsert: update the existing day's row instead.
                    let inserted: unknown = null
                    let insertErr: { message: string } | null = null
                    if (table === 'health_data' && typeof cleaned.date === 'string') {
                      const { data: existing } = await supabase
                        .from('health_data')
                        .select('id')
                        .eq('date', cleaned.date)
                        .maybeSingle()
                      const q = existing?.id
                        ? supabase.from('health_data').update(cleaned).eq('id', existing.id)
                        : supabase.from('health_data').insert(cleaned)
                      const res = await q.select().single()
                      inserted = res.data
                      insertErr = res.error
                    } else {
                      const res = await supabase.from(table).insert(cleaned).select().single()
                      inserted = res.data
                      insertErr = res.error
                    }
                    resultText = insertErr
                      ? JSON.stringify({ error: insertErr.message })
                      : JSON.stringify({ ok: true, table, inserted })
                  } else if (tc.function.name === 'schedule_proactive_message') {
                    let args: { text?: string; delay_minutes?: number; persist?: boolean } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}') as typeof args
                    } catch (jsonError) {
                      console.warn('解析 schedule_proactive_message 失败', jsonError)
                    }
                    const proText = (args.text ?? '').trim()
                    const delayMin = Math.max(1, Math.min(1440, Number(args.delay_minutes) || 60))
                    const persist = args.persist === true
                    if (proText && shouldScheduleProactive(delayMin * 60 * 1000)) {
                      const delayMs = delayMin * 60 * 1000
                      const fireAt = Date.now() + delayMs
                      // Build entry; try to register in proactive_queue for
                      // server-side dispatch (so message lands in Supabase at
                      // fire time even if app stays closed).
                      const proEntry: import('./storage/proactiveNotification').PendingProactive = {
                        sessionId,
                        text: proText,
                        fireAt,
                        persist,
                      }
                      if (supabase && user) {
                        const { data: qRow } = await supabase
                          .from('proactive_queue')
                          .insert({
                            user_id: user.id,
                            session_id: sessionId,
                            text: proText,
                            fire_at: new Date(fireAt).toISOString(),
                            persist,
                          })
                          .select('id')
                          .single()
                        if (qRow?.id) proEntry.queueId = qRow.id as string
                      }
                      savePendingProactive(proEntry)
                      void scheduleProactiveNotification(proText, delayMs, { persist })
                      setToolStatus(
                        persist
                          ? `⏰ 已锁定提醒：${delayMin} 分钟后`
                          : `📨 已预设 ${delayMin} 分钟后的消息`,
                      )
                      resultText = JSON.stringify({
                        ok: true,
                        scheduled_at: new Date(fireAt).toISOString(),
                        delay_minutes: delayMin,
                        persist,
                      })
                    } else {
                      resultText = JSON.stringify({
                        ok: false,
                        reason: proText ? 'quiet_hours' : 'missing_text',
                      })
                    }
                  } else if (tc.function.name === 'get_health_status' && supabase) {
                    setToolStatus('🫀 查健康数据…')
                    const [healthResult, periodResult] = await Promise.all([
                      supabase
                        .from('health_data')
                        .select('date,sleep_hours,sleep_quality,heart_rate_avg,heart_rate_rest,steps,notes')
                        .order('date', { ascending: false })
                        .limit(7),
                      supabase
                        .from('period_tracking')
                        .select('id,start_date,end_date,cycle_length,notes,created_at')
                        .order('start_date', { ascending: false })
                        .limit(3),
                    ])
                    resultText = JSON.stringify({
                      health_data: healthResult.error ? [] : healthResult.data ?? [],
                      period_data: periodResult.error ? [] : periodResult.data ?? [],
                      note: (!healthResult.data?.length && !periodResult.data?.length)
                        ? '暂无健康数据。用户可能未同步 Health Connect，或尚未记录经期。'
                        : undefined,
                    })
                  } else if (tc.function.name === 'get_device_state') {
                    setToolStatus('🔋 查手机状态…')
                    try {
                      const state = await getDeviceState()
                      resultText = JSON.stringify(state)
                    } catch (deviceErr) {
                      resultText = JSON.stringify({
                        error: deviceErr instanceof Error ? deviceErr.message : String(deviceErr),
                      })
                    }
                  } else if (tc.function.name === 'play_music' && supabase) {
                    let args: { query?: string } = {}
                    try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* keep {} */ }
                    const queryLabel = (args.query ?? '').toString().trim().slice(0, 40)
                    setToolStatus(queryLabel ? `🎵 搜歌：${queryLabel}…` : '🎵 搜歌…')
                    const { data: musicData, error: musicErr } = await supabase.functions.invoke('netease_search', {
                      body: { query: args.query },
                    })
                    if (!musicErr && Array.isArray(musicData?.results) && musicData.results.length > 0) {
                      const song = musicData.results[0] as { id: number; name: string; artist: string; duration_seconds: number }
                      try {
                        const { MediaControlPlugin } = await import('./plugins/MediaControlPlugin')
                        // Correct format confirmed: path-style ID + ?autoplay=1.
                        // Without autoplay=1 the app only navigates to the song
                        // page but never starts playing.
                        await MediaControlPlugin.openUrl({
                          url: `orpheus://song/${song.id}/?autoplay=1`,
                          packageName: 'com.netease.cloudmusic',
                        })
                      } catch (openErr) {
                        console.warn('打开网易云失败', openErr)
                      }
                      resultText = JSON.stringify({ status: 'playing', song: song.name, artist: song.artist, id: song.id })
                    } else {
                      resultText = JSON.stringify({ error: musicErr?.message ?? '没有找到这首歌' })
                    }
                  } else if (tc.function.name === 'control_media') {
                    let args: { action?: string } = {}
                    try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* keep {} */ }
                    const actionLabel: Record<string, string> = { play: '继续', pause: '暂停', next: '下一首', previous: '上一首' }
                    setToolStatus(`⏯ ${actionLabel[args.action ?? ''] ?? args.action}…`)
                    try {
                      const { MediaControlPlugin } = await import('./plugins/MediaControlPlugin')
                      await MediaControlPlugin.control({ action: args.action ?? 'pause' })
                      resultText = JSON.stringify({ ok: true, action: args.action })
                    } catch (mediaErr) {
                      resultText = JSON.stringify({ error: String(mediaErr) })
                    }
                  } else if (tc.function.name === 'get_now_playing') {
                    setToolStatus('🎧 看看在放什么…')
                    try {
                      const { MediaControlPlugin } = await import('./plugins/MediaControlPlugin')
                      const perm = await MediaControlPlugin.hasPermission()
                      if (!perm.granted) {
                        // Pop the settings page so the user can flip the toggle,
                        // and tell Claude to guide them rather than silently fail.
                        try { await MediaControlPlugin.requestPermission() } catch { /* ignore */ }
                        resultText = JSON.stringify({
                          error: 'NO_PERMISSION',
                          hint: '需要用户在「设置 → 通知使用权」里给 Nimbus 打勾，已自动弹出设置页，请引导用户开启后重试',
                        })
                      } else {
                        const np = await MediaControlPlugin.getNowPlaying()
                        resultText = JSON.stringify(np)
                      }
                    } catch (npErr) {
                      resultText = JSON.stringify({ error: String(npErr) })
                    }
                  } else if (tc.function.name === 'manage_memory' && supabase) {
                    let args: { action?: string; id?: string | number; content?: string; source?: string } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}')
                    } catch (jsonError) {
                      console.warn('解析 manage_memory 失败', jsonError)
                    }
                    const memId = Number(args.id)
                    const action = args.action
                    if (args.source && args.source !== 'memory') {
                      // ids aren't unique across tables — refuse to act on a
                      // non-memory result's id (e.g. a diary/letter id) so we
                      // never touch the wrong memories row by collision.
                      resultText = JSON.stringify({
                        error: `manage_memory 只能管理 source=memory 的记忆，收到 source=${args.source}`,
                      })
                    } else if (!Number.isFinite(memId) || !action) {
                      resultText = JSON.stringify({ error: '缺少 action 或 id' })
                    } else if (action === 'update' && !String(args.content ?? '').trim()) {
                      resultText = JSON.stringify({ error: 'update 需要 content' })
                    } else if (
                      action !== 'lock' &&
                      action !== 'unlock' &&
                      action !== 'update' &&
                      action !== 'archive'
                    ) {
                      resultText = JSON.stringify({ error: `未知 action: ${action}` })
                    } else if (action === 'archive') {
                      // Soft delete: move to memories_archive (skips locked).
                      setToolStatus('🗄️ 归档记忆…')
                      const { data: archived, error: archiveErr } = await supabase.rpc('archive_memory', {
                        p_id: memId,
                      })
                      resultText = archiveErr
                        ? JSON.stringify({ error: archiveErr.message })
                        : archived === true
                          ? JSON.stringify({ ok: true, id: String(memId), action: 'archive' })
                          : JSON.stringify({ ok: false, id: String(memId), reason: '未找到或已锁定，未归档' })
                    } else {
                      setToolStatus(
                        action === 'lock' ? '🔒 锁定记忆…' : action === 'unlock' ? '🔓 解锁记忆…' : '✏️ 整理记忆…',
                      )
                      const patch =
                        action === 'lock'
                          ? { locked: true }
                          : action === 'unlock'
                            ? { locked: false }
                            : { content: String(args.content).trim() }
                      await updateMemory(memId, patch)
                      resultText = JSON.stringify({ ok: true, id: String(memId), action })
                    }
                  } else if (tc.function.name === 'list_memories' && supabase) {
                    let args: { limit?: number; offset?: number; only_unlocked?: boolean } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}')
                    } catch (jsonError) {
                      console.warn('解析 list_memories 失败', jsonError)
                    }
                    const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 30)))
                    const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
                    setToolStatus('📋 查看记忆库…')
                    let q = supabase
                      .from('memories')
                      .select('id,category,content,locked,created_at')
                      .order('created_at', { ascending: false })
                      .range(offset, offset + limit - 1)
                    if (args.only_unlocked === true) q = q.eq('locked', false)
                    const { data, error } = await q
                    resultText = error
                      ? JSON.stringify({ error: error.message })
                      : JSON.stringify({
                          memories: (data ?? []).map(
                            (r: { id: number; category: string | null; content: string; locked: boolean | null }) => ({
                              id: String(r.id),
                              category: r.category ?? '日常',
                              content: r.content,
                              locked: !!r.locked,
                            }),
                          ),
                        })
                  } else if (tc.function.name === 'garden_memories' && supabase) {
                    let args: { similarity_threshold?: number; max_pairs?: number } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}')
                    } catch (jsonError) {
                      console.warn('解析 garden_memories 失败', jsonError)
                    }
                    const threshold = Math.max(0.5, Math.min(0.99, Number(args.similarity_threshold) || 0.85))
                    const maxPairs = Math.max(1, Math.min(30, Math.floor(Number(args.max_pairs) || 15)))
                    setToolStatus('🌿 扫描相似记忆…')
                    const { data, error } = await supabase.rpc('find_similar_memory_pairs', {
                      similarity_threshold: threshold,
                      max_pairs: maxPairs,
                    })
                    resultText = error
                      ? JSON.stringify({ error: error.message })
                      : JSON.stringify({
                          pairs: (data ?? []).map((r: {
                            id_a: number; id_b: number
                            content_a: string; content_b: string
                            category_a: string; category_b: string
                            similarity: number
                          }) => ({
                            id_a: String(r.id_a), id_b: String(r.id_b),
                            content_a: r.content_a, content_b: r.content_b,
                            category_a: r.category_a, category_b: r.category_b,
                            similarity: r.similarity,
                          })),
                          count: (data ?? []).length,
                          note: (data ?? []).length === 0
                            ? '未发现相似记忆对，库里没有明显重复。'
                            : `发现 ${(data ?? []).length} 对相似记忆，建议合并或归档重复的一方。`,
                        })
                  } else if (tc.function.name === 'check_memory_health' && supabase) {
                    let args: { days_inactive?: number; min_days_old?: number; max_count?: number } = {}
                    try {
                      args = JSON.parse(tc.function.arguments || '{}')
                    } catch (jsonError) {
                      console.warn('解析 check_memory_health 失败', jsonError)
                    }
                    const daysInactive = Math.max(1, Math.min(365, Math.floor(Number(args.days_inactive) || 90)))
                    const minDaysOld = Math.max(1, Math.min(365, Math.floor(Number(args.min_days_old) || 30)))
                    const maxCount = Math.max(1, Math.min(50, Math.floor(Number(args.max_count) || 20)))
                    setToolStatus('🏥 检查记忆健康状态…')
                    const { data, error } = await supabase.rpc('get_stale_memories', {
                      days_inactive: daysInactive,
                      min_days_old: minDaysOld,
                      max_count: maxCount,
                    })
                    resultText = error
                      ? JSON.stringify({ error: error.message })
                      : JSON.stringify({
                          stale_memories: (data ?? []).map((r: {
                            id: number; content: string; category: string
                            access_count: number; last_accessed_at: string | null
                            created_at: string; days_since_access: number
                          }) => ({
                            id: String(r.id),
                            content: r.content,
                            category: r.category,
                            access_count: r.access_count,
                            last_accessed_at: r.last_accessed_at,
                            created_at: r.created_at,
                            days_since_access: r.days_since_access,
                          })),
                          count: (data ?? []).length,
                          params: { days_inactive: daysInactive, min_days_old: minDaysOld },
                          note: (data ?? []).length === 0
                            ? `未发现休眠记忆（标准：${daysInactive} 天未被搜索到）。记忆库状态良好。`
                            : `发现 ${(data ?? []).length} 条休眠记忆，建议逐条判断：过时的归档，仍有效的保留。`,
                        })
                  } else {
                    resultText = JSON.stringify({ error: `unsupported tool: ${tc.function.name}` })
                  }
                } catch (toolError) {
                  const message = toolError instanceof Error ? toolError.message : String(toolError)
                  resultText = JSON.stringify({ error: message })
                  // Surface to the user so the chat doesn't sit on a stale
                  // "正在搜索网络…" line. Self-clears after 3s if nothing
                  // else has updated the status meanwhile.
                  const failureLine = `❌ ${tc.function.name} 失败：${message.slice(0, 60)}`
                  setToolStatus(failureLine)
                  window.setTimeout(() => {
                    setToolStatus((current) => (current === failureLine ? '' : current))
                  }, 3000)
                }
                // Cap tool results so a runaway search / dump doesn't
                // blow the model's context window or balloon DB writes.
                // 32KB is plenty for the kinds of results we produce
                // (memory rows, web snippets, sandbox stdout).
                const MAX_TOOL_RESULT_BYTES = 32 * 1024
                if (resultText.length > MAX_TOOL_RESULT_BYTES) {
                  const half = Math.floor(MAX_TOOL_RESULT_BYTES / 2)
                  resultText = JSON.stringify({
                    truncated: true,
                    original_size_bytes: resultText.length,
                    note: `Result exceeded ${MAX_TOOL_RESULT_BYTES} bytes — keeping head + tail.`,
                    head: resultText.slice(0, half),
                    tail: resultText.slice(-half),
                  })
                }
                // Record for UI card display in the saved message meta.
                let parsedArgs: unknown = {}
                let parsedResult: unknown = resultText
                try { parsedArgs = JSON.parse(tc.function.arguments || '{}') } catch { /* keep {} */ }
                try { parsedResult = JSON.parse(resultText) } catch { /* keep string */ }
                toolCallRecords.push({
                  name: tc.function.name,
                  args: parsedArgs,
                  result: parsedResult,
                  duration_ms: Date.now() - toolStart,
                  timestamp: new Date().toISOString(),
                })
                baseMessages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: resultText,
                })
              }
              setToolStatus('')
              // Record tool flow events (after toolCallRecords is populated).
              for (let i = toolIndexStart; i < toolCallRecords.length; i++) {
                flowEvents.push({ type: 'tool', index: i })
              }
              // Loop back for another model turn
              continue
            }
            // Record any thinking from the final (non-tool) iteration.
            if (currentIterationReasoning.trim()) {
              flowEvents.push({ type: 'thinking', content: currentIterationReasoning.trim() })
              currentIterationReasoning = ''
            }
            conversationDone = true
          }

          // If we exited the loop because of MAX_TOOL_ITERATIONS (not because
          // the model said "done"), the model never got to produce its final
          // text reply. Do one more text-only, non-streaming call so the user
          // sees an answer instead of a blank bubble.
          if (!conversationDone && lastSentBody) {
            try {
              setToolStatus('收尾中…')
              // KEEP `tools` in the body. Anthropic's prompt-cache key
              // is (system + tools + messages); dropping tools forces a
              // ~$0.15 cold write of the entire conversation. Use
              // tool_choice='none' to stop the model from actually
              // calling tools — that's now translated by
              // convertOpenAiRequestToAnthropic into {type:'none'} on
              // the wire (previously got silently dropped, which is
              // why the original code had to delete tools instead).
              const finalBody: Record<string, unknown> = {
                ...lastSentBody,
                messages: applyClaudeCaching(baseMessages, effectiveModel),
                stream: false,
                tool_choice: 'none',
                // Restore full max_tokens — lastSentBody may have the capped
                // value from a mid-loop iteration (see tool-selection cap above).
                max_tokens: paramsSnapshot.max_tokens,
              }
              // Re-enable extended thinking for the final text reply —
              // it was skipped on tool iterations 2-4 to save cost, but
              // the user-facing answer benefits from reasoning.
              if (reasoningEnabled && isClaudeModel(effectiveModel)) {
                const thinkingBudget = 2000
                finalBody.reasoning = { max_tokens: thinkingBudget }
                const currentMax =
                  typeof finalBody.max_tokens === 'number' ? finalBody.max_tokens : 0
                finalBody.max_tokens = Math.max(currentMax, thinkingBudget + 1024)
                delete finalBody.temperature
                delete finalBody.top_p
              }
              let finalResp = await fetchOpenRouter('/chat/completions', {
                body: finalBody,
                signal: controller.signal,
              })
              // If the reasoning-enabled finalizer failed (e.g. Anthropic
              // 400s on thinking when the tool_use history has no thinking
              // blocks), retry once without reasoning so the user still gets
              // a text reply instead of an empty bubble.
              if (!finalResp.ok && finalBody.reasoning) {
                console.warn('finalizer with reasoning failed, retrying without', finalResp.status)
                const plainFinalBody = { ...finalBody }
                delete plainFinalBody.reasoning
                finalResp = await fetchOpenRouter('/chat/completions', {
                  body: plainFinalBody,
                  signal: controller.signal,
                })
              }
              if (finalResp.ok) {
                const data = (await finalResp.json()) as {
                  choices?: Array<{ message?: { content?: unknown } }>
                  usage?: Record<string, unknown>
                }
                // The finalizer is a real API call — capture its usage so
                // it shows up in usage_logs alongside the loop iterations.
                if (data?.usage && typeof data.usage === 'object') {
                  lastUsage = data.usage as typeof lastUsage
                  flushUsageRecord()
                }
                const text = data?.choices?.[0]?.message?.content
                if (typeof text === 'string' && text.trim()) {
                  if (assistantContent && !assistantContent.endsWith('\n')) {
                    assistantContent += '\n\n'
                  }
                  assistantContent += text.trim()
                }
              }
            } catch (forceErr) {
              console.warn('force-final-text after tool cap failed', forceErr)
            } finally {
              setToolStatus('')
            }
          }

          // Last-resort fallback: if streaming + tool loop + force-final all
          // produced nothing, don't save a ghost empty bubble — surface the
          // failure so the user knows to retry.
          if (assistantContent.trim().length === 0) {
            console.warn('empty assistant content after all retries', {
              iteration,
              conversationDone,
            })
            assistantContent = '（回复为空，请重试或换个问法）'
          }

          // (Proactive scheduling is now handled via tool_call
          // schedule_proactive_message — no post-response extraction needed.)

          // Guard: tool loop can occasionally double-fire the save path.
          if (!messagesRef.current.some((m) => m.clientId === assistantClientId && !m.pending)) {
            // Save locally first so the reply appears instantly.
            const localAssistant = addMessage(sessionId, 'assistant', assistantContent, buildAssistantMeta(false), {
              clientId: assistantClientId,
              clientCreatedAt: assistantClientCreatedAt,
            })
            if (localAssistant) {
              const updatedMessages = updateMessage(messagesRef.current, {
                ...localAssistant.message,
                pending: false,
              })
              const updatedSessions = sessionsRef.current.map((session) =>
                session.id === sessionId ? { ...session, updatedAt: localAssistant.session.updatedAt } : session,
              )
              applySnapshot(updatedSessions, updatedMessages)
            }
            // Sync to cloud in background, same pattern as user message.
            if (user && supabase) {
              void Promise.race([
                addRemoteMessage(sessionId, user.id, 'assistant', assistantContent, assistantClientId, assistantClientCreatedAt, buildAssistantMeta(false)),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('supabase timeout')), 5000)),
              ])
                .then(({ message: savedMessage, updatedAt }) => {
                  const updatedMessages = updateMessage(messagesRef.current, {
                    ...savedMessage,
                    pending: false,
                  })
                  const updatedSessions = sessionsRef.current.map((session) =>
                    session.id === sessionId ? { ...session, updatedAt } : session,
                  )
                  applySnapshot(updatedSessions, updatedMessages)
                })
                .catch((err) => {
                  console.warn('后台同步助手回复失败', err)
                })
            }
          }

          // Auto-title generation removed (2026-06-02): the user manually
          // names sessions and the auto-title path was the source of the
          // mystery 3-4k-token Opus calls visible on OR's dashboard but
          // missing from our usage_logs. Each chat in a "新会话"-named
          // session fired a separate ~$0.02 Opus request to generate a
          // 4-8 character Chinese title — and on short test chats Claude
          // often returned an out-of-range string that got rejected,
          // leaving the title at "新会话" so the NEXT chat fired it again.
          // Net effect was multiple cold-write Opus calls per test session.

          // Keepalive applies to any chat that went through the native
          // /v1/messages path, since that's the only path that writes an
          // Anthropic prompt cache worth keeping warm. That's OR + Claude
          // (auto-routed to native) or a 中转站 (msuicode-style relay)
          // explicitly in Anthropic-compat format — same condition
          // openrouter.ts uses to pick the native endpoint. A relay in
          // OpenAI-compat format never cached, so we skip it (nothing to keep
          // warm). Was OR-only, which silently left relay users unprotected:
          // their 1h cache went cold and the first message back paid a full
          // cold write — even though cache_keepalive_state + the edge function
          // already carry provider/base_url/auth_style to route relay pings.
          const activeProvider = getActiveProvider()
          const usesNativeCache =
            isClaudeModel(effectiveModel) &&
            (activeProvider === 'openrouter' ||
              getProviderConfig(activeProvider).format === 'anthropic')
          if (lastSentBody && usesNativeCache) {
            keepaliveBodyRef.current = lastSentBody
            // A successful chat IS a cache refresh — mark it so the
            // pre-warm path on chat-page entry knows the cache is hot
            // and skips the redundant ping.
            keepaliveLastPingedAtRef.current = Date.now()
            scheduleKeepalive()
            // Server-side mirror: the client timer above dies the moment the
            // app is killed / backgrounded too long (mobile JS limitation).
            // Mirror the same body + this user's provider key into
            // cache_keepalive_state so the cache_keepalive Edge Function
            // (pg_cron every 5min) can keep the cache warm from the server
            // side, surviving APK reinstall / phone sleep / process kill.
            //
            // Per-provider routing fields — the edge function uses these to
            // POST to the right upstream with the right header style. Both
            // paths hit a `${baseUrl}/messages` endpoint with the same body
            // shape; only the auth header differs (OR Bearer vs 中转 x-api-key,
            // see src/api/openrouter.ts for the auto-routing decision).
            //
            // Store the converted Anthropic-native body, not the original
            // OpenAI-compat one. The keepalive ping has to hit the same
            // endpoint with the same body shape or the cache key won't
            // match — pinging /chat/completions with OpenAI shape would
            // refresh a different cache than what the chat is using.
            //
            // Cost note: the conversion re-runs flattenContent which
            // re-fetches any image URLs in the body as base64. For chats
            // that include images (rare), this is N HTTP requests after
            // every chat just for the keepalive snapshot. Browser/Capacitor
            // HTTP-layer caching usually absorbs the cost when the image
            // origin (e.g. Supabase Storage) sets cache headers.
            if (supabase && user) {
              const cfg = getProviderConfig(activeProvider)
              if (cfg.apiKey && cfg.baseUrl) {
                const isOR = activeProvider === 'openrouter'
                const authStyle = isOR ? 'bearer' : 'x-api-key'
                void (async () => {
                  try {
                    const anthropicBody = await convertOpenAiRequestToAnthropic(
                      lastSentBody as Parameters<typeof convertOpenAiRequestToAnthropic>[0],
                      { keepModelSlug: isOR },
                    )
                    const { error } = await supabase
                      .from('cache_keepalive_state')
                      .upsert({
                        user_id: user.id,
                        body: anthropicBody as unknown as Record<string, unknown>,
                        openrouter_key: cfg.apiKey, // historical column name — now generic
                        provider: activeProvider,
                        base_url: cfg.baseUrl,
                        auth_style: authStyle,
                        last_chat_at: new Date().toISOString(),
                      })
                    if (error) console.warn('cache_keepalive upsert failed', error)
                  } catch (err) {
                    console.warn('cache_keepalive convert/upsert error', err)
                  }
                })()
              }
            }
          }
          setToolStatus('')
        } catch (error) {
          setToolStatus('')
          if (flushTimer !== null) {
            window.clearTimeout(flushTimer)
            flushTimer = null
          }
          flushPending()
          // Attach the debug payload only for real failures — a user-initiated
          // abort (pressing stop) isn't a bug worth persisting debug for.
          const isAbort = error instanceof DOMException && error.name === 'AbortError'
          flushUsageRecord(!isAbort)
          if (isAbort) {
            if (assistantContent.trim().length > 0) {
              // Save the partial reply locally first (instant, offline-safe),
              // then sync to cloud in the background — same local-first +
              // timeout + catch pattern as the success path. A bare awaited
              // addRemoteMessage here would lose the partial reply (and throw
              // an unhandled rejection) whenever Supabase is unreachable.
              const localPartial = addMessage(
                sessionId,
                'assistant',
                assistantContent,
                buildAssistantMeta(false),
                { clientId: assistantClientId, clientCreatedAt: assistantClientCreatedAt },
              )
              if (localPartial) {
                const updatedMessages = updateMessage(messagesRef.current, {
                  ...localPartial.message,
                  pending: false,
                })
                const updatedSessions = sessionsRef.current.map((session) =>
                  session.id === sessionId
                    ? { ...session, updatedAt: localPartial.session.updatedAt }
                    : session,
                )
                applySnapshot(updatedSessions, updatedMessages)
              }
              if (user && supabase) {
                void Promise.race([
                  addRemoteMessage(
                    sessionId,
                    user.id,
                    'assistant',
                    assistantContent,
                    assistantClientId,
                    assistantClientCreatedAt,
                    buildAssistantMeta(false),
                  ),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('supabase timeout')), 5000),
                  ),
                ])
                  .then(({ message: savedMessage, updatedAt }) => {
                    const updatedMessages = updateMessage(messagesRef.current, {
                      ...savedMessage,
                      pending: false,
                    })
                    const updatedSessions = sessionsRef.current.map((session) =>
                      session.id === sessionId ? { ...session, updatedAt } : session,
                    )
                    applySnapshot(updatedSessions, updatedMessages)
                  })
                  .catch((err) => console.warn('后台同步中断回复失败', err))
              }
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
          // Only clear stream state if THIS persist's controller is still
          // active. A regenerate/edit-user-message can abort our stream then
          // start a new one before our catch resolves — if we clobbered the
          // ref unconditionally, the new stream's "stop" button would break.
          if (controller && streamingControllerRef.current === controller) {
            setIsStreaming(false)
            streamingControllerRef.current = null
          }
        }
      }

      void persist()
    },
    [applySnapshot, cancelKeepalive, resolveSessionReasoning, resolveSessionModel, scheduleKeepalive, user],
  )

  // 连发：用户消息先落库显示，不立刻触发生成；停顿 BATCH_REPLY_MS 后再一次性
  // 生成回复（skipUser），让 AI 把这一批连发的消息一起看。期间没流式，所以
  // 连发不被停止键挡；一旦开始回复，UI 切到停止键自然挡住后续输入。
  const BATCH_REPLY_MS = 2500
  const batchTimerRef = useRef<number | null>(null)
  const batchSessionRef = useRef<string | null>(null)

  // 起/重置「连发后自动回复」定时器。停顿 BATCH_REPLY_MS 没有新动作才触发。
  const armBatchTimer = useCallback(
    (sessionId: string) => {
      if (batchTimerRef.current) {
        window.clearTimeout(batchTimerRef.current)
        // 窗口内切到别的会话连发：旧会话那批不能丢，立刻替它触发回复。
        const prev = batchSessionRef.current
        if (prev && prev !== sessionId) {
          void sendMessage(prev, '', { skipUser: true })
        }
      }
      batchSessionRef.current = sessionId
      batchTimerRef.current = window.setTimeout(function fire() {
        // 有流正在跑（上面 flush 的旧会话回复、或窗口内点了编辑/重新生成）
        // 就再等一个窗口，别去抢 streamingController 把人家的流掐断。
        if (streamingControllerRef.current) {
          batchTimerRef.current = window.setTimeout(fire, BATCH_REPLY_MS)
          return
        }
        batchTimerRef.current = null
        batchSessionRef.current = null
        void sendMessage(sessionId, '', { skipUser: true })
      }, BATCH_REPLY_MS)
    },
    [sendMessage],
  )

  // 撤掉挂着的批量回复定时器。编辑/重新生成会自己触发生成，挂着的定时器
  // 不撤会在它们的流上再叠一次生成（见 sendMessage 开头的 abort）。
  const cancelBatchTimer = useCallback(() => {
    if (batchTimerRef.current) {
      window.clearTimeout(batchTimerRef.current)
      batchTimerRef.current = null
    }
    batchSessionRef.current = null
  }, [])

  // 用户还在输入框打字 → 推后自动回复，别在他打下一条时抢答。只有定时器
  // 已经在跑（说明刚连发过）时才重置，平时打字不受影响。
  const notifyComposerActivity = useCallback(() => {
    if (batchTimerRef.current && batchSessionRef.current) {
      armBatchTimer(batchSessionRef.current)
    }
  }, [armBatchTimer])

  const persistUserMessage = useCallback(
    (
      sessionId: string,
      content: string,
      attachments: Array<{ type: 'image'; url: string; width?: number; height?: number }> = [],
    ) => {
      const clientId = createClientId()
      const clientCreatedAt = new Date().toISOString()
      const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
      const WEATHER_DATE_KEY = 'nimbus_weather_injected_date'
      const lastWeatherDate =
        typeof window !== 'undefined' ? window.localStorage.getItem(WEATHER_DATE_KEY) : null
      const weatherSnap = lastWeatherDate !== todayCN ? peekCachedWeather() : null
      if (weatherSnap && typeof window !== 'undefined') {
        window.localStorage.setItem(WEATHER_DATE_KEY, todayCN)
      }
      const userMeta: ChatMessage['meta'] = {
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(weatherSnap
          ? {
              weather: {
                temperatureC: weatherSnap.temperatureC,
                feelsLikeC: weatherSnap.feelsLikeC,
                condition: weatherSnap.condition,
              },
            }
          : {}),
      }
      const clientCreatedAtIso = clientCreatedAt
      const optimisticMessage: ChatMessage = {
        id: clientId,
        sessionId,
        role: 'user',
        content,
        createdAt: clientCreatedAtIso,
        clientId,
        clientCreatedAt: clientCreatedAtIso,
        meta: userMeta,
        pending: true,
      }
      applySnapshot(
        sessionsRef.current.map((s) => (s.id === sessionId ? { ...s, updatedAt: clientCreatedAtIso } : s)),
        sortMessages([...messagesRef.current, optimisticMessage]),
      )
      const localResult = addMessage(sessionId, 'user', content, userMeta, { clientId, clientCreatedAt })
      if (localResult) {
        applySnapshot(
          sessionsRef.current.map((s) =>
            s.id === sessionId ? { ...s, updatedAt: localResult.session.updatedAt } : s,
          ),
          updateMessage(messagesRef.current, { ...localResult.message, pending: false }),
        )
      }
      if (user && supabase) {
        void Promise.race([
          addRemoteMessage(sessionId, user.id, 'user', content, clientId, clientCreatedAt, userMeta),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('supabase timeout')), 5000)),
        ])
          .then(({ message: saved, updatedAt }) => {
            applySnapshot(
              sessionsRef.current.map((s) => (s.id === sessionId ? { ...s, updatedAt } : s)),
              updateMessage(messagesRef.current, { ...saved, pending: false }),
            )
          })
          .catch((err) => console.warn('后台同步用户消息失败', err))
      }
    },
    [applySnapshot, user],
  )

  const queueUserMessage = useCallback(
    async (
      sessionId: string,
      content: string,
      options?: { attachments?: Array<{ type: 'image'; url: string; width?: number; height?: number }> },
    ): Promise<void> => {
      persistUserMessage(sessionId, content, options?.attachments ?? [])
      armBatchTimer(sessionId)
    },
    [persistUserMessage, armBatchTimer],
  )

  const handleStopStreaming = useCallback(() => {
    streamingControllerRef.current?.abort()
    setIsStreaming(false)
  }, [])

  // Triggered by the "手动压缩对话" button in the chat header. Runs the
  // same compressIfNeeded path that auto-compression uses, but with
  // force=true so it bypasses the enabled flag + token-threshold guard.
  // The summary goes into compression_cache and the next send picks
  // it up automatically.
  const handleManualCompress = useCallback(
    async (
      sessionId: string,
    ): Promise<{ ok: boolean; message: string }> => {
      if (!user || !supabase) {
        return { ok: false, message: '云端未配置，无法压缩' }
      }
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) {
        return { ok: false, message: '会话不存在' }
      }
      const settings = settingsRef.current ?? fallbackSettings
      const sessionMessages = messagesRef.current.filter(
        (msg) =>
          msg.sessionId === sessionId &&
          msg.content.trim().length > 0 &&
          !msg.meta?.streaming,
      )
      if (sessionMessages.length < 8) {
        return { ok: false, message: '对话太短，不需要压缩' }
      }
      const effectiveModel = resolveSessionModel(sessionId)
      try {
        const outcome = await compressIfNeeded(
          sessionId,
          sessionMessages,
          settings.systemPrompt ?? '',
          effectiveModel,
          {
            enabled: settings.compressionEnabled,
            triggerRatio: settings.compressionTriggerRatio,
            keepRecentMessages: settings.compressionKeepRecentMessages,
            summarizerModel: settings.summarizerModel,
            summarizerProvider: settings.summarizerProvider,
            force: true,
          },
        )
        if (outcome.didCompress) {
          return {
            ok: true,
            message: '已压缩，下次发送将使用更紧凑的上下文',
          }
        }
        return { ok: false, message: '没有可压缩的旧消息' }
      } catch (err) {
        return {
          ok: false,
          message: `压缩失败：${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
    [user, resolveSessionModel, fallbackSettings],
  )

  // Bind the pre-generated-proactive injector once user is known.
  useEffect(() => {
    insertPendingProactiveRef.current = async (entry) => {
      if (!user || !supabase) {
        if (entry.persist) clearPersistProactive()
        else clearPendingProactive()
        return
      }
      // If this entry was registered in proactive_queue, try to claim it.
      // The server-side cron (proactive_dispatch) may have already set
      // sent=true and inserted the message — in that case refreshCurrentSessionRef
      // will pick it up and we skip the client-side insert to avoid duplicates.
      if (entry.queueId) {
        const { data: claimed } = await supabase
          .from('proactive_queue')
          .update({ sent: true })
          .eq('id', entry.queueId)
          .eq('sent', false)
          .select('id')
          .maybeSingle()
        if (!claimed) {
          // Server already dispatched — message is in Supabase; refresh will show it
          void refreshCurrentSessionRef.current(entry.sessionId)
          return
        }
      }
      // Prefer the chat the user is currently looking at; fall back to the
      // session that generated the pending message.
      const hashMatch = window.location.hash.match(/#\/chat\/([^/?]+)/)
      const targetSessionId = hashMatch?.[1] ?? entry.sessionId
      try {
        const clientId = createClientId()
        // Use the scheduled fire time as the display timestamp so the message
        // appears at the intended time, not when the user happened to open the app.
        const clientCreatedAt = new Date(entry.fireAt).toISOString()
        const { message: saved, updatedAt } = await addRemoteMessage(
          targetSessionId,
          user.id,
          'assistant',
          entry.text,
          clientId,
          clientCreatedAt,
          { model: 'proactive', provider: getActiveProvider() },
        )
        const updatedMessages = sortMessages([...messagesRef.current, saved])
        const updatedSessions = sessionsRef.current.map((s) =>
          s.id === targetSessionId ? { ...s, updatedAt } : s,
        )
        applySnapshot(updatedSessions, updatedMessages)
      } catch (err) {
        console.warn('insert pending proactive failed', err)
      } finally {
        if (entry.persist) clearPersistProactive()
        else clearPendingProactive()
      }
    }
  }, [applySnapshot, user])

  // Merges server-dispatched messages for a session into local state.
  // Called on foreground to pick up messages the proactive_dispatch cron
  // inserted while the app was closed.
  useEffect(() => {
    refreshCurrentSessionRef.current = async (sessionId: string) => {
      if (!user) return
      const fresh = await fetchSessionRecentMessages(sessionId, 20)
      if (!fresh.length) return
      const existingIds = new Set(messagesRef.current.map((m) => m.id))
      const trulyNew = fresh.filter((m) => !existingIds.has(m.id))
      if (!trulyNew.length) return
      const merged = sortMessages([...messagesRef.current, ...trulyNew])
      applySnapshot(sessionsRef.current, merged)
    }
  }, [applySnapshot, user])

  // Bind the proactive-nudge function once sendMessage is available.
  // Used by the visibility handler above (which can't reference
  // sendMessage directly due to declaration order).
  useEffect(() => {
    maybeSendProactiveRef.current = async (sessionId: string) => {
      if (!user) return
      if (streamingControllerRef.current) return
      const sessionMessages = messagesRef.current
        .filter((m) => m.sessionId === sessionId)
        .sort(
          (a, b) =>
            new Date(a.clientCreatedAt ?? a.createdAt).getTime() -
            new Date(b.clientCreatedAt ?? b.createdAt).getTime(),
        )
      if (sessionMessages.length === 0) return
      const last = sessionMessages[sessionMessages.length - 1]
      if (last.pending) return
      if (last.role !== 'user') return
      const elapsedMs = Date.now() - new Date(last.createdAt).getTime()
      const ONE_HOUR = 60 * 60 * 1000
      if (elapsedMs < ONE_HOUR) return

      const nudge =
        '[内部系统提示] 用户已经超过 1 小时没回应你了。请基于之前的对话内容主动找她聊聊——可以是一句关心、续上之前的话题、或者分享你想到的什么。一两句话就好，自然像朋友主动发的消息，不要刻意点出"我注意到你很久没说话"这种话。'

      try {
        await sendMessage(sessionId, '', { skipUser: true, proactiveNudge: nudge })
      } catch (err) {
        console.warn('proactive nudge failed', err)
      }
    }
  }, [sendMessage, user])

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
      cancelBatchTimer()
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
    [user, sendMessage, applySnapshot, cancelBatchTimer],
  )

  const editUserMessage = useCallback(
    async (userMessageId: string, newContent: string) => {
      const trimmed = newContent.trim()
      if (!trimmed) return
      const all = messagesRef.current
      const target = all.find(
        (m) => m.id === userMessageId || m.clientId === userMessageId,
      )
      if (!target || target.role !== 'user') return
      const sessionMessages = all
        .filter((m) => m.sessionId === target.sessionId)
        .sort(
          (a, b) =>
            new Date(a.clientCreatedAt ?? a.createdAt).getTime() -
            new Date(b.clientCreatedAt ?? b.createdAt).getTime(),
        )
      const targetIdx = sessionMessages.findIndex((m) => m.id === target.id)
      if (targetIdx < 0) return
      // Stop any in-flight streaming before mutating message history.
      streamingControllerRef.current?.abort()
      cancelBatchTimer()
      // Remove the edited user message AND every message after it (assistant
      // replies, follow-ups). The edit replays from this turn forward.
      const removeIds = new Set(sessionMessages.slice(targetIdx).map((m) => m.id))
      try {
        if (user && supabase) {
          for (const m of sessionMessages.slice(targetIdx)) {
            if (!m.pending) {
              try {
                await deleteRemoteMessage(m.id)
              } catch (err) {
                console.warn('编辑时删除旧消息失败', err)
              }
            }
          }
        }
      } catch (err) {
        console.warn('编辑时清理远端消息失败', err)
      }
      const filtered = messagesRef.current.filter(
        (m) => !removeIds.has(m.id) && !removeIds.has(m.clientId ?? ''),
      )
      applySnapshot(sessionsRef.current, filtered)
      // Resend with the new content. Attachments are dropped — user can
      // re-attach if needed.
      await sendMessage(target.sessionId, trimmed)
    },
    [user, sendMessage, applySnapshot, cancelBatchTimer],
  )

  const removeMessage = useCallback(
    async (messageId: string) => {
      // 连发窗口内删消息也算「还在整理」，推后自动回复（批里剩下的消息
      // 等用户停手后照常一起回）。
      notifyComposerActivity()
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
    [applySnapshot, user, notifyComposerActivity],
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
      <Suspense fallback={<div className="page-loading">加载中…</div>}>
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
                onComposerActivity={notifyComposerActivity}
                onOpenDrawer={() => setDrawerOpen(true)}
                onCloseDrawer={() => setDrawerOpen(false)}
                onCreateSession={createSessionEntry}
                onRenameSession={renameSessionEntry}
                onSendMessage={queueUserMessage}
                onDeleteMessage={removeMessage}
                onRegenerate={regenerateAssistantReply}
                onEditUserMessage={editUserMessage}
                onDeleteSession={removeSession}
                enabledModels={enabledModels}
                defaultModel={defaultModelId}
                onSelectModel={handleSessionOverrideChange}
                defaultReasoning={activeSettings.chatReasoningEnabled}
                highReasoningEnabled={activeSettings.chatHighReasoningEnabled}
                onSelectReasoning={handleSessionReasoningOverrideChange}
                onArchiveSession={handleSessionArchiveStateChange}
                onActiveSessionChange={setActiveChatSessionId}
                onManualCompress={handleManualCompress}
                onChatPageEnter={prewarmKeepaliveIfStale}
                user={user}
                toolStatus={toolStatus}
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
          path="/health-sync"
          element={
            <RequireAuth ready={authReady} user={user} configured={supabaseConfigured}>
              <HealthSyncPage user={user} />
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
              <MemoryVaultPage
                recentMessages={buildRecentExtractionMessages(
                  activeChatSessionId ?? latestSession?.id ?? '',
                  messages,
                  MEMORY_EXTRACT_RECENT_MESSAGES,
                )}
                memoryExtractProvider={activeSettings.memoryExtractProvider}
              />
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
      </Suspense>
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
  onComposerActivity,
  onOpenDrawer,
  onCloseDrawer,
  onCreateSession,
  onRenameSession,
  onSendMessage,
  onDeleteMessage,
  onRegenerate,
  onEditUserMessage,
  onDeleteSession,
  enabledModels,
  defaultModel,
  onSelectModel,
  defaultReasoning,
  highReasoningEnabled,
  onSelectReasoning,
  onArchiveSession,
  onActiveSessionChange,
  onManualCompress,
  onChatPageEnter,
  user,
  toolStatus,
}: {
  sessions: ChatSession[]
  messages: ChatMessage[]
  messageCounts: Record<string, number>
  drawerOpen: boolean
  syncing: boolean
  sessionsReady: boolean
  isStreaming: boolean
  onStopStreaming: () => void
  onComposerActivity: () => void
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
  onEditUserMessage: (userMessageId: string, newContent: string) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<void>
  enabledModels: string[]
  defaultModel: string
  onSelectModel: (sessionId: string, model: string | null) => Promise<void>
  defaultReasoning: boolean
  highReasoningEnabled: boolean
  onSelectReasoning: (sessionId: string, reasoning: boolean | null) => Promise<void>
  onArchiveSession: (sessionId: string, isArchived: boolean) => Promise<void>
  onActiveSessionChange: (sessionId: string) => void
  onManualCompress: (sessionId: string) => Promise<{ ok: boolean; message: string }>
  onChatPageEnter: () => void
  user: User | null
  toolStatus: string
}) => {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [pendingShare, clearShare] = usePendingShare()
  const shareDraftRef = useRef<string | null>(null)

  const activeSession = sessions.find((session) => session.id === sessionId)

  useEffect(() => {
    if (activeSession) {
      onActiveSessionChange(activeSession.id)
    }
  }, [activeSession, onActiveSessionChange])

  // Fire a pre-warm keepalive ping the moment the user arrives at a
  // chat. If the last ping was stale (>50min) this refreshes the cache
  // while they're still typing, so the actual send below doesn't pay
  // the cold-write penalty. Runs on first mount and on every session
  // switch — both are real "user about to chat" moments.
  useEffect(() => {
    if (sessionId) onChatPageEnter()
  }, [sessionId, onChatPageEnter])
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
    // replace so the back button doesn't bounce the user into the chat
    // they were just on — match the rest of the in-/chat/ navigations.
    navigate(`/chat/${newSession.id}`, { replace: true })
    onCloseDrawer()
  }, [navigate, onCloseDrawer, onCreateSession])

  const handleSelectSession = useCallback(
    (id: string) => {
      navigate(`/chat/${id}`, { replace: true })
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

  // When another app shares text to Nimbus, navigate to the active chat
  // and pre-fill the composer with the shared content.
  useEffect(() => {
    if (!pendingShare || !activeSession) return
    const prefix = pendingShare.title
      ? `「${pendingShare.title}」\n\n${pendingShare.text}`
      : pendingShare.text
    shareDraftRef.current = prefix
    navigate(`/chat/${activeSession.id}`, { replace: false })
  }, [pendingShare]) // eslint-disable-line react-hooks/exhaustive-deps

  // If a share arrived before any session existed (first launch), the
  // effect above won't fire because activeSession is null. As soon as a
  // session is created, trigger the navigation.
  useEffect(() => {
    if (!pendingShare || !activeSession) return
    if (shareDraftRef.current) return // already handled by the effect above
    const prefix = pendingShare.title
      ? `「${pendingShare.title}」\n\n${pendingShare.text}`
      : pendingShare.text
    shareDraftRef.current = prefix
    navigate(`/chat/${activeSession.id}`, { replace: false })
  }, [activeSession, pendingShare, navigate])

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
        onEditUserMessage={onEditUserMessage}
        isStreaming={isStreaming}
        onStopStreaming={onStopStreaming}
        onComposerActivity={onComposerActivity}
        enabledModels={enabledModels}
        defaultModel={defaultModel}
        onSelectModel={(model) => onSelectModel(activeSession.id, model)}
        defaultReasoning={defaultReasoning}
        highReasoningEnabled={highReasoningEnabled}
        onSelectReasoning={(reasoning) =>
          onSelectReasoning(activeSession.id, reasoning)
        }
        onManualCompress={() => onManualCompress(activeSession.id)}
        user={user}
        toolStatus={toolStatus}
        shareDraft={shareDraftRef.current ?? undefined}
        onConsumeShare={() => {
          shareDraftRef.current = null
          clearShare(pendingShare)
        }}
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
