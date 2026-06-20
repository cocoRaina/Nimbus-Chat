import { Capacitor, registerPlugin } from '@capacitor/core'

// Bridge to the custom ProactivePoll Android plugin (see
// android/app/src/main/java/.../ProactivePollPlugin.java). Schedules a
// WorkManager periodic job that polls the poll_proactive Edge Function for
// server-written spontaneous AI messages and raises a LOCAL notification —
// no push service (FCM/HMS) needed, so it works on GMS-less phones (Huawei).

type ProactivePollPlugin = {
  configure(opts: {
    supabaseUrl: string
    anonKey: string
    userId: string
    persona: string
    now: string
  }): Promise<void>
  setSeen(opts: { now: string }): Promise<void>
  disable(): Promise<void>
}

const ProactivePoll = registerPlugin<ProactivePollPlugin>('ProactivePoll')

const isAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('ProactivePoll')

export const configureProactivePoll = async (opts: {
  supabaseUrl: string
  anonKey: string
  userId: string
  persona: string
}): Promise<void> => {
  if (!isAvailable()) return
  try {
    await ProactivePoll.configure({ ...opts, now: new Date().toISOString() })
  } catch (err) {
    console.warn('configure proactive poll failed', err)
  }
}

// Advance the poll pointer so messages already visible in-app aren't
// re-surfaced as notifications. Call on app foreground.
export const markProactiveSeen = async (): Promise<void> => {
  if (!isAvailable()) return
  try {
    await ProactivePoll.setSeen({ now: new Date().toISOString() })
  } catch (err) {
    console.warn('mark proactive seen failed', err)
  }
}
