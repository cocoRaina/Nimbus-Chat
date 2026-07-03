import type { ChatMessage, ChatSession } from '../types'

const DB_NAME = 'nimbus-chat'
// v1: single 'snapshot' blob (all sessions+messages, rewritten in full on
//     every change — ~2MB structured-clone per keystroke of streaming).
// v2: row-level 'sessions' / 'messages' stores keyed by id. A debounced
//     flush diffs the in-memory arrays against what was last persisted (by
//     object REFERENCE — App-side updates keep untouched rows' references)
//     and writes only the dirty rows. The v1 blob is migrated then deleted.
const DB_VERSION = 2
const SNAP_STORE = 'snapshot'
const SNAPSHOT_KEY = 'main'
const SESSIONS_STORE = 'sessions'
const MESSAGES_STORE = 'messages'
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
      if (!d.objectStoreNames.contains(SNAP_STORE)) d.createObjectStore(SNAP_STORE)
      if (!d.objectStoreNames.contains(SESSIONS_STORE)) d.createObjectStore(SESSIONS_STORE)
      if (!d.objectStoreNames.contains(MESSAGES_STORE)) d.createObjectStore(MESSAGES_STORE)
    }
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result)
    req.onerror = () => reject(req.error)
  })

const idbGetSnapshotBlob = (): Promise<StorageSnapshot | undefined> =>
  new Promise((resolve, reject) => {
    if (!db) { resolve(undefined); return }
    const req = db.transaction(SNAP_STORE, 'readonly').objectStore(SNAP_STORE).get(SNAPSHOT_KEY)
    req.onsuccess = () => resolve(req.result as StorageSnapshot | undefined)
    req.onerror = () => reject(req.error)
  })

const idbGetAll = <T,>(store: string): Promise<T[]> =>
  new Promise((resolve, reject) => {
    if (!db) { resolve([]); return }
    const req = db.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve((req.result as T[]) ?? [])
    req.onerror = () => reject(req.error)
  })

// ─── In-memory snapshot (source of truth between writes) ─────────────────────

const snapshot: StorageSnapshot = { sessions: [], messages: [] }

// What's currently persisted in the row stores, keyed by id, holding the
// exact object REFERENCE that was written. flushRows() diffs against these
// to decide which rows to put/delete; they're only advanced when the
// transaction commits, so a failed flush retries the same rows next time.
let persistedSessions = new Map<string, ChatSession>()
let persistedMessages = new Map<string, ChatMessage>()

const seedPersistedMaps = () => {
  persistedSessions = new Map(snapshot.sessions.map((s) => [s.id, s]))
  persistedMessages = new Map(snapshot.messages.map((m) => [m.id, m]))
}

// ─── Startup: open IDB, migrate v1 blob / legacy localStorage if needed ──────

const initPromise = (async () => {
  try {
    db = await openDb()

    // Normal path: row stores already populated (v2 steady state).
    const [rowSessions, rowMessages] = await Promise.all([
      idbGetAll<ChatSession>(SESSIONS_STORE),
      idbGetAll<ChatMessage>(MESSAGES_STORE),
    ])
    if (rowSessions.length > 0 || rowMessages.length > 0) {
      snapshot.sessions = rowSessions
      snapshot.messages = rowMessages
      seedPersistedMaps()
      return
    }

    // Migration: v1 single-blob snapshot, then the even older localStorage.
    let data = await idbGetSnapshotBlob()
    if (!data) {
      const raw = typeof localStorage !== 'undefined'
        ? localStorage.getItem(LS_LEGACY_KEY)
        : null
      if (raw) {
        try { data = JSON.parse(raw) as StorageSnapshot } catch { /* corrupt — start fresh */ }
      }
    }
    if (data) {
      snapshot.sessions = Array.isArray(data.sessions) ? data.sessions : []
      snapshot.messages = Array.isArray(data.messages) ? data.messages : []
      // Write everything as rows once; only clean up the old copies after
      // the transaction commits so a mid-migration crash loses nothing.
      await new Promise<void>((resolve, reject) => {
        if (!db) { reject(new Error('db not open')); return }
        const tx = db.transaction([SESSIONS_STORE, MESSAGES_STORE, SNAP_STORE], 'readwrite')
        const sStore = tx.objectStore(SESSIONS_STORE)
        for (const s of snapshot.sessions) if (s?.id) sStore.put(s, s.id)
        const mStore = tx.objectStore(MESSAGES_STORE)
        for (const m of snapshot.messages) if (m?.id) mStore.put(m, m.id)
        tx.objectStore(SNAP_STORE).delete(SNAPSHOT_KEY)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('migration tx aborted'))
      })
      try { localStorage.removeItem(LS_LEGACY_KEY) } catch { /* */ }
      seedPersistedMaps()
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

// Diff the in-memory arrays against the last-persisted maps and write only
// what changed. Reference equality is the dirty check: App-level updates are
// immutable-style (changed rows get new objects, untouched rows keep their
// reference), so a streaming delta or a single new message flushes as one
// small row put instead of a ~2MB whole-history blob like v1 did.
const flushRows = () => {
  if (!db) return
  const curSessions = snapshot.sessions
  const curMessages = snapshot.messages
  const nextSessions = new Map<string, ChatSession>()
  const nextMessages = new Map<string, ChatMessage>()
  try {
    const tx = db.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite')
    const sStore = tx.objectStore(SESSIONS_STORE)
    for (const s of curSessions) {
      if (!s?.id) continue
      nextSessions.set(s.id, s)
      if (persistedSessions.get(s.id) !== s) sStore.put(s, s.id)
    }
    for (const id of persistedSessions.keys()) {
      if (!nextSessions.has(id)) sStore.delete(id)
    }
    const mStore = tx.objectStore(MESSAGES_STORE)
    for (const m of curMessages) {
      if (!m?.id) continue
      nextMessages.set(m.id, m)
      if (persistedMessages.get(m.id) !== m) mStore.put(m, m.id)
    }
    for (const id of persistedMessages.keys()) {
      if (!nextMessages.has(id)) mStore.delete(id)
    }
    tx.oncomplete = () => {
      persistedSessions = nextSessions
      persistedMessages = nextMessages
    }
    tx.onerror = () => console.warn('IDB 行写入失败（下次 flush 重试）', tx.error)
    tx.onabort = () => console.warn('IDB 行写入事务中止（下次 flush 重试）', tx.error)
  } catch (err) {
    console.warn('IDB 行写入异常（下次 flush 重试）', err)
  }
}

const writeNow = () => {
  if (pendingWrite) {
    clearTimeout(pendingWrite)
    pendingWrite = null
  }
  if (db) {
    flushRows()
  } else {
    const payload: StorageSnapshot = {
      sessions: snapshot.sessions,
      messages: snapshot.messages,
    }
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

// Reference-preserving: return the SAME object when nothing needs filling.
// The row-level flush diffs by reference — if these cloned every row on every
// loadSnapshot/setSnapshot pass, every flush would look 100% dirty and
// degrade back to a full rewrite.
const ensureMessageFields = (message: ChatMessage): ChatMessage => {
  if (
    message.id &&
    message.clientId &&
    message.clientCreatedAt !== undefined &&
    message.createdAt &&
    message.pending !== undefined
  ) {
    return message
  }
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

const ensureSessionFields = (session: ChatSession): ChatSession => {
  if (session.isArchived !== undefined && session.archivedAt !== undefined) {
    return session
  }
  return {
    ...session,
    isArchived: session.isArchived ?? false,
    archivedAt: session.archivedAt ?? null,
  }
}

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
