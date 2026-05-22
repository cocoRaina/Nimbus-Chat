import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

// One stable notification id we reuse so re-scheduling cancels the
// previous instead of accumulating.
const PROACTIVE_NOTIFICATION_ID = 1001
const PROACTIVE_DELAY_MS = 60 * 60 * 1000

const messageVariants = [
  '🌿 想你了，过来聊两句吗？',
  '☕ 在干嘛呢？我这里有点话想跟你说',
  '💭 突然想到一件事…',
  '🌙 你好像有一阵没说话了，还好吗？',
  '✨ 我有个想分享的事，回来看看？',
]

const pickMessage = () => messageVariants[Math.floor(Math.random() * messageVariants.length)]

const isAvailable = () => Capacitor.getPlatform() !== 'web'

export const scheduleProactiveNotification = async () => {
  if (!isAvailable()) return
  try {
    // Cancel previous schedule if any.
    await LocalNotifications.cancel({ notifications: [{ id: PROACTIVE_NOTIFICATION_ID }] })
    await LocalNotifications.schedule({
      notifications: [
        {
          id: PROACTIVE_NOTIFICATION_ID,
          title: 'Claude',
          body: pickMessage(),
          schedule: { at: new Date(Date.now() + PROACTIVE_DELAY_MS) },
          smallIcon: 'ic_stat_icon_config_sample',
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
