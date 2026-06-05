import { useState, useEffect, useCallback } from 'react'
import { registerPlugin } from '@capacitor/core'

interface ShareReceiverPlugin {
  getPendingShare(): Promise<{ text: string | null; title: string }>
}

const ShareReceiver = registerPlugin<ShareReceiverPlugin>('ShareReceiver')

export type PendingShare = { text: string; title: string } | null

/**
 * Checks for pending shared text from Android's share sheet.
 * Returns null if no share is pending, or { text, title } if another app
 * shared content to Nimbus. Clears after being read, so each share is
 * consumed exactly once.
 */
export const checkPendingShare = async (): Promise<PendingShare> => {
  try {
    const result = await ShareReceiver.getPendingShare()
    if (result.text && result.text.trim().length > 0) {
      return { text: result.text.trim(), title: result.title || '' }
    }
    return null
  } catch {
    // Plugin not available (web, iOS, or first load before registration)
    return null
  }
}

/**
 * Hook that polls for share intent data on mount and app foreground.
 * Returns a callback that the chat page can use to consume the share
 * and clear it.
 */
export const usePendingShare = (): [
  PendingShare,
  (share: PendingShare) => void,
] => {
  const [pending, setPending] = useState<PendingShare>(null)

  const poll = useCallback(async () => {
    const share = await checkPendingShare()
    if (share) setPending(share)
  }, [])

  useEffect(() => {
    void poll()
    const onResume = () => void poll()
    document.addEventListener('resume', onResume)
    return () => document.removeEventListener('resume', onResume)
  }, [poll])

  const clear = useCallback((share: PendingShare) => {
    setPending((current) => (current === share ? null : current))
  }, [])

  return [pending, clear]
}
