import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

const PROACTIVE_NOTIFICATION_ID = 1001
const DEFAULT_DELAY_MS = 60 * 60 * 1000

const STORAGE_KEY = 'nimbus_pending_proactive_v1'

// Active hours: notifications only fire between [start, end). Outside
// this window we skip entirely so the user isn't woken up + so we don't
// burn API credits on a generation that won't be seen.
const ACTIVE_START_HOUR = 7
const ACTIVE_END_HOUR = 24

const isAvailable = () => Capacitor.getPlatform() !== 'web'

// Pass delayMs = 0 to check "is NOW in active hours?" (pre-gen gate).
// Pass the actual delay after Claude picks one to verify the fire time.
export const shouldScheduleProactive = (delayMs?: number): boolean => {
  const fireAt = new Date(Date.now() + (delayMs ?? DEFAULT_DELAY_MS))
  const hour = fireAt.getHours()
  return hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR
}

export type PendingProactive = {
  sessionId: string
  text: string
  fireAt: number // epoch ms
}

export const savePendingProactive = (entry: PendingProactive) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry))
  } catch {
    // ignore
  }
}

export const readPendingProactive = (): PendingProactive | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PendingProactive
  } catch {
    return null
  }
}

export const clearPendingProactive = () => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export const scheduleProactiveNotification = async (
  notificationBody: string,
  delayMs?: number,
) => {
  if (!isAvailable()) return
  const delay = delayMs ?? DEFAULT_DELAY_MS
  try {
    await LocalNotifications.cancel({ notifications: [{ id: PROACTIVE_NOTIFICATION_ID }] })
    await LocalNotifications.schedule({
      notifications: [
        {
          id: PROACTIVE_NOTIFICATION_ID,
          title: 'Claude',
          body: notificationBody,
          schedule: { at: new Date(Date.now() + delay) },
          // smallIcon omitted: Capacitor's docs example name
          // 'ic_stat_icon_config_sample' isn't shipped in our drawable
          // folders, so notifications would silently fall back. Letting
          // Capacitor use the app icon is what we want anyway.
          channelId: 'proactive',
        },
      ],
    })
  } catch (err) {
    console.warn('schedule proactive notification failed', err)
  }
}

export const cancelProactiveNotification = async () => {
  if (!isAvailable()) return
  try {
    await LocalNotifications.cancel({ notifications: [{ id: PROACTIVE_NOTIFICATION_ID }] })
  } catch {
    // ignore
  }
}
