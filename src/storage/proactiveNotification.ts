import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { getAssistantName } from './assistantPersona'

// Transient = "ping if she hasn't come back yet" — auto-cancelled when
// user sends a new message. Persist = "user explicitly asked for this,
// fire no matter what" — wake-up alarms, next-day reminders. They use
// separate notification IDs and separate storage so they don't collide.
const TRANSIENT_NOTIFICATION_ID = 1001
const PERSIST_NOTIFICATION_ID = 1002
const DEFAULT_DELAY_MS = 60 * 60 * 1000

const STORAGE_KEY_TRANSIENT = 'nimbus_pending_proactive_v1'
const STORAGE_KEY_PERSIST = 'nimbus_persist_proactive_v1'

const isAvailable = () => Capacitor.getPlatform() !== 'web'

// Kept for the existing pre-gen guard path; currently always true since
// we removed quiet hours. Left in place so re-introducing them later
// only touches this file.
export const shouldScheduleProactive = (_delayMs?: number): boolean => true

export type PendingProactive = {
  sessionId: string
  text: string
  fireAt: number // epoch ms
  persist?: boolean
}

const writeStorage = (key: string, entry: PendingProactive) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // ignore
  }
}

const readStorage = (key: string): PendingProactive | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as PendingProactive
  } catch {
    return null
  }
}

const removeStorage = (key: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export const savePendingProactive = (entry: PendingProactive) => {
  const key = entry.persist ? STORAGE_KEY_PERSIST : STORAGE_KEY_TRANSIENT
  writeStorage(key, entry)
}

// Returns the transient pending only — the one that should be wiped
// when the user comes back to chat. Persist pendings are read via
// readPersistProactive.
export const readPendingProactive = (): PendingProactive | null =>
  readStorage(STORAGE_KEY_TRANSIENT)

export const readPersistProactive = (): PendingProactive | null =>
  readStorage(STORAGE_KEY_PERSIST)

export const clearPendingProactive = () => removeStorage(STORAGE_KEY_TRANSIENT)

export const clearPersistProactive = () => removeStorage(STORAGE_KEY_PERSIST)

export const scheduleProactiveNotification = async (
  notificationBody: string,
  delayMs?: number,
  options?: { persist?: boolean },
) => {
  if (!isAvailable()) return
  const delay = delayMs ?? DEFAULT_DELAY_MS
  const id = options?.persist ? PERSIST_NOTIFICATION_ID : TRANSIENT_NOTIFICATION_ID
  try {
    await LocalNotifications.cancel({ notifications: [{ id }] })
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title: getAssistantName(),
          body: notificationBody,
          schedule: { at: new Date(Date.now() + delay) },
          channelId: 'proactive',
        },
      ],
    })
  } catch (err) {
    console.warn('schedule proactive notification failed', err)
  }
}

// Only cancels the transient one. Persist (wake-up etc.) must be
// cancelled explicitly via cancelPersistProactiveNotification — never
// silently dropped by chat replies.
export const cancelProactiveNotification = async () => {
  if (!isAvailable()) return
  try {
    await LocalNotifications.cancel({ notifications: [{ id: TRANSIENT_NOTIFICATION_ID }] })
  } catch {
    // ignore
  }
}

export const cancelPersistProactiveNotification = async () => {
  if (!isAvailable()) return
  try {
    await LocalNotifications.cancel({ notifications: [{ id: PERSIST_NOTIFICATION_ID }] })
  } catch {
    // ignore
  }
}
