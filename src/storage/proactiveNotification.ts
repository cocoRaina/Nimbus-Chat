import { LocalNotifications } from '@capacitor/local-notifications'
import { Capacitor } from '@capacitor/core'
import { getAssistantName } from './assistantPersona'

const PENDING_KEY = 'nimbus_pending_proactive_v1'
const PERSIST_KEY = 'nimbus_persist_proactive_v1'
const NOTIF_ID_TRANSIENT = 2001
const NOTIF_ID_PERSIST = 2002

export type PendingProactive = {
  sessionId: string
  text: string
  fireAt: number
  persist?: boolean
  /** proactive_queue row id, set when registered for server-side dispatch. */
  queueId?: string
}

export const shouldScheduleProactive = (_delayMs: number): boolean => true

export const savePendingProactive = (entry: PendingProactive): void => {
  const key = entry.persist ? PERSIST_KEY : PENDING_KEY
  try { localStorage.setItem(key, JSON.stringify(entry)) } catch {}
}

export const readPendingProactive = (): PendingProactive | null => {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as PendingProactive) : null
  } catch { return null }
}

export const readPersistProactive = (): PendingProactive | null => {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    return raw ? (JSON.parse(raw) as PendingProactive) : null
  } catch { return null }
}

export const clearPendingProactive = (): void => {
  try { localStorage.removeItem(PENDING_KEY) } catch {}
}

export const clearPersistProactive = (): void => {
  try { localStorage.removeItem(PERSIST_KEY) } catch {}
}

export const scheduleProactiveNotification = async (
  text: string,
  delayMs: number,
  options?: { persist?: boolean },
): Promise<void> => {
  if (Capacitor.getPlatform() === 'web') return
  const id = options?.persist ? NOTIF_ID_PERSIST : NOTIF_ID_TRANSIENT
  try {
    await LocalNotifications.cancel({ notifications: [{ id }] })
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title: getAssistantName(),
        body: text,
        schedule: { at: new Date(Date.now() + delayMs) },
        channelId: 'proactive',
      }],
    })
  } catch {}
}

export const cancelProactiveNotification = async (): Promise<void> => {
  if (Capacitor.getPlatform() === 'web') return
  try {
    await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID_TRANSIENT }] })
  } catch {}
}

export const cancelPersistProactiveNotification = async (): Promise<void> => {
  if (Capacitor.getPlatform() === 'web') return
  try {
    await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID_PERSIST }] })
  } catch {}
}
