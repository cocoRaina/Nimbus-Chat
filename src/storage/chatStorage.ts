import type { ChatMessage, ChatSession } from '../types'

const DB_NAME = 'nimbus-chat'
const DB_VERSION = 1
const STORE = 'snapshot'
const SNAPSHOT_KEY = 'main'
// Old localStorage key — read once for migration then removed.
const LS_LEGACY_KEY = 'hamster-nest.chat-data.v1'

type StorageSnapshot = {
  sessions: ChatSession[]
  messages: ChatMessage[]
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

let db: IDBDatabase | null = null

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const d = (e.target as IDBOpenDBRequest).result
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
    }
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result)
    req.onerror = () => reject(req.error)
  })

const idbGet = (key: string): Promise<StorageSnapshot | undefined> =>
  new Promise((resolve, reject) => {
    if (!db) { resolve(undefined); return }
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as StorageSnapshot | undefined)
    req.onerror = () => reject(req.error)
  })

const idbPut = (key: string, value: StorageSnapshot): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!db) { reject(new Error('db not open')); return }
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })

// ─── In-memory snapshot (source of truth between writes) ─────────────────────

const snapshot: StorageSnapshot = { sessions: [], messages: [] }

// ─── Startup: open IDB, migrate from localStorage if needed ──────────────────

const initPromise = (async () => {
  try {
    db = await openDb()
    let data = await idbGet(SNAPSHOT_KEY)

    if (!data) {
      // First run after migration — pull whatever is in localStorage.
      const raw = typeof localStorage !== 'undefined'
        ? localStorage.getItem(LS_LEGACY_KEY)
        : null
      if (raw) {
        try {
          data = JSON.parse(raw) as StorageSnapshot
          await idbPut(SNAPSHOT_KEY, data)
          // Free up the old localStorage quota immediately.
          localStorage.removeItem(LS_LEGACY_KEY)
        } catch { /* corrupt — start fresh */ }
      }
    }

    if (data) {
      snapshot.sessions = Array.isArray(data.sessions) ? data.sessions : []
      snapshot.messages = Array.isArray(data.messages) ? data.messages : []
    }
  } catch (err) {
    console.warn('IndexedDB 不可用，回退到 localStorage', err)
    // Fallback: keep reading/writing localStorage (old behaviour).
    db = null
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LS_LEGACY_KEY)
      if (raw) {
        try {
          const data = JSON.parse(raw) as StorageSnapshot
          snapshot.sessions = Array.isArray(data.sessions) ? data.sessions : []
          snapshot.messages = Array.isArray(data.messages) ? data.messages : []
        } catch { /* */ }
      }
    }
  }
})()

// Await this before reading the snapshot for the first time.
export const waitForStorage = (): Promise<void> => initPromise

// ─── Write helpers ────────────────────────────────────────────────────────────

let pendingWrite: ReturnType<typeof setTimeout> | null = null

const writeNow = () => {
  if (pendingWrite) {
    clearTimeout(pendingWrite)
    pendingWrite = null
  }
  const payload: StorageSnapshot = {
    sessions: snapshot.sessions,
    messages: snapshot.messages,
  }
  if (db) {
    void idbPut(SNAPSHOT_KEY, payload).catch((err) => {
      console.warn('IDB 写入失败', err)
      // Last-resort fallback.
      try { localStorage.setItem(LS_LEGACY_KEY, JSON.stringify(payload)) } catch { /* */ }
    })
  } else {
    try { localStorage.setItem(LS_LEGACY_KEY, JSON.stringify(payload)) } catch { /* */ }
  }
}

const scheduleWrite = () => {
  if (pendingWrite) return
  pendingWrite = setTimeout(() => {
    pendingWrite = null
    writeNow()
  }, 150)
}

// Flush the debounced write on page hide so the last messages aren't lost
// when Android kills the WebView while backgrounded.
if (typeof window !== 'undefined') {
  const flushIfPending = () => { if (pendingWrite) writeNow() }
  window.addEventListener('pagehide', flushIfPending)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushIfPending()
  })
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

const createId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`

const ensureMessageFields = (message: ChatMessage): ChatMessage => {
  const clientId = message.clientId ?? message.id ?? createId()
  const clientCreatedAt = message.clientCreatedAt ?? message.createdAt ?? null
  return {
    ...message,
    id: message.id ?? clientId,
    clientId,
    clientCreatedAt,
    createdAt: message.createdAt ?? clientCreatedAt ?? new Date().toISOString(),
    pending: message.pending ?? false,
  }
}

const ensureSessionFields = (session: ChatSession): ChatSession => ({
  ...session,
  isArchived: session.isArchived ?? false,
  archivedAt: session.archivedAt ?? null,
})

// Keep the local IDB snapshot bounded. Supabase has everything; local is
// just a fast-start cache. 2000 messages ≈ 2MB worst-case, won't budge.
const MAX_LOCAL_MESSAGES = 2000

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

// ─── Public API (same interface as before) ────────────────────────────────────

export const loadSnapshot = (): StorageSnapshot => {
  snapshot.sessions = sortSessions(snapshot.sessions.map(ensureSessionFields))
  snapshot.messages = sortMessages(snapshot.messages.map(ensureMessageFields))
  return {
    sessions: [...snapshot.sessions],
    messages: [...snapshot.messages],
  }
}

export const setSnapshot = (next: StorageSnapshot) => {
  snapshot.sessions = sortSessions(next.sessions.map(ensureSessionFields))
  let msgs = sortMessages(next.messages.map(ensureMessageFields))
  // Cap local cache. Keep the newest MAX_LOCAL_MESSAGES; older ones live in
  // Supabase and are fetched on demand. Prevents unbounded IDB growth.
  if (msgs.length > MAX_LOCAL_MESSAGES) msgs = msgs.slice(msgs.length - MAX_LOCAL_MESSAGES)
  snapshot.messages = msgs
  scheduleWrite()
}

export const createSession = (title?: string): ChatSession => {
  const now = new Date().toISOString()
  const session: ChatSession = {
    id: createId(),
    title: title ?? '新会话',
    createdAt: now,
    updatedAt: now,
    isArchived: false,
    archivedAt: null,
    overrideModel: null,
    overrideReasoning: null,
  }
  snapshot.sessions = sortSessions([...snapshot.sessions, session])
  scheduleWrite()
  return session
}

export const renameSession = (sessionId: string, title: string): ChatSession | null => {
  let updatedSession: ChatSession | null = null
  snapshot.sessions = snapshot.sessions.map((session) => {
    if (session.id !== sessionId) return session
    updatedSession = { ...session, title }
    return updatedSession
  })
  if (!updatedSession) return null
  scheduleWrite()
  return updatedSession
}

export const addMessage = (
  sessionId: string,
  role: ChatMessage['role'],
  content: string,
  meta?: ChatMessage['meta'],
  options?: {
    clientId?: string
    clientCreatedAt?: string
    createdAt?: string
    pending?: boolean
  },
): { message: ChatMessage; session: ChatSession } | null => {
  const now = options?.createdAt ?? new Date().toISOString()
  const sessionIndex = snapshot.sessions.findIndex((s) => s.id === sessionId)
  if (sessionIndex === -1) return null
  const clientId = options?.clientId ?? createId()
  const clientCreatedAt = options?.clientCreatedAt ?? now
  const message: ChatMessage = {
    id: options?.pending ? clientId : createId(),
    sessionId,
    role,
    content,
    createdAt: now,
    clientId,
    clientCreatedAt,
    meta,
    pending: options?.pending ?? false,
  }
  const sessions = [...snapshot.sessions]
  const updatedSession = { ...sessions[sessionIndex], updatedAt: now }
  sessions[sessionIndex] = updatedSession
  snapshot.sessions = sessions
  snapshot.messages = [...snapshot.messages, message]
  scheduleWrite()
  return { message, session: updatedSession }
}

export const deleteMessage = (messageId: string) => {
  snapshot.messages = snapshot.messages.filter((m) => m.id !== messageId)
  scheduleWrite()
}

export const deleteSession = (sessionId: string) => {
  snapshot.sessions = snapshot.sessions.filter((s) => s.id !== sessionId)
  snapshot.messages = snapshot.messages.filter((m) => m.sessionId !== sessionId)
  scheduleWrite()
}

export const updateSessionOverride = (
  sessionId: string,
  overrideModel: string | null,
): ChatSession | null => {
  let updatedSession: ChatSession | null = null
  snapshot.sessions = snapshot.sessions.map((session) => {
    if (session.id !== sessionId) return session
    updatedSession = { ...session, overrideModel }
    return updatedSession
  })
  if (!updatedSession) return null
  scheduleWrite()
  return updatedSession
}

export const updateSessionReasoningOverride = (
  sessionId: string,
  overrideReasoning: boolean | null,
): ChatSession | null => {
  let updatedSession: ChatSession | null = null
  snapshot.sessions = snapshot.sessions.map((session) => {
    if (session.id !== sessionId) return session
    updatedSession = { ...session, overrideReasoning }
    return updatedSession
  })
  if (!updatedSession) return null
  scheduleWrite()
  return updatedSession
}

export const setSessionArchiveState = (
  sessionId: string,
  isArchived: boolean,
): ChatSession | null => {
  let updatedSession: ChatSession | null = null
  const archivedAt = isArchived ? new Date().toISOString() : null
  snapshot.sessions = snapshot.sessions.map((session) => {
    if (session.id !== sessionId) return session
    updatedSession = { ...session, isArchived, archivedAt }
    return updatedSession
  })
  if (!updatedSession) return null
  scheduleWrite()
  return updatedSession
}
