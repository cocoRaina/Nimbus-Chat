import { useEffect, useRef } from 'react'
import { supabase } from '../supabase/client'
import type { UserSettings, ChatMessage } from '../types'

export function useAutoMemoryExtract(
  userId: string | null,
  settings: UserSettings | null,
  activeMessages: ChatMessage[],
  onUpdateLastExtractAt: (iso: string) => void,
) {
  const triggeredRef = useRef(false)

  useEffect(() => {
    triggeredRef.current = false
  }, [userId])

  useEffect(() => {
    const sb = supabase
    if (!userId || !sb || !settings || triggeredRef.current) return
    if (!settings.autoMemoryExtractEnabled) return
    if (activeMessages.length < 5) return

    const lastExtract = settings.lastMemoryExtractAt
      ? new Date(settings.lastMemoryExtractAt).getTime()
      : 0
    const intervalMs = (settings.memoryExtractIntervalHours ?? 6) * 60 * 60 * 1000

    if (Date.now() - lastExtract < intervalMs) return

    triggeredRef.current = true

    const timer = window.setTimeout(async () => {
      const startMs = Date.now()
      try {
        const recentMessages = activeMessages.slice(-30).map((m) => ({
          role: m.role,
          content: m.content,
        }))

        const { data, error } = await sb.functions.invoke('memory-extract', {
          body: {
            recentMessages,
          },
        })

        const durationMs = Date.now() - startMs
        const now = new Date().toISOString()

        if (error) {
          console.warn('[AutoExtract] error:', error)
          void sb.from('memory_extract_log').insert({
            user_id: userId,
            messages_scanned: recentMessages.length,
            memories_extracted: 0,
            memories_inserted: 0,
            memories_skipped: 0,
            timeline_extracted: 0,
            timeline_inserted: 0,
            duration_ms: durationMs,
            error: typeof error === 'string' ? error : JSON.stringify(error),
          })
          return
        }

        console.log('[AutoExtract] result:', data)

        void sb.from('memory_extract_log').insert({
          user_id: userId,
          messages_scanned: recentMessages.length,
          memories_extracted: data?.items?.length ?? 0,
          memories_inserted: data?.inserted ?? 0,
          memories_skipped: data?.skipped ?? 0,
          timeline_extracted: 0,
          timeline_inserted: 0,
          duration_ms: durationMs,
        })

        void sb
          .from('user_settings')
          .update({ last_memory_extract_at: now })
          .eq('user_id', userId)
          .then(() => onUpdateLastExtractAt(now))
      } catch (e) {
        console.warn('[AutoExtract] exception:', e)
      }
    }, 5000)

    return () => clearTimeout(timer)
  }, [userId, settings, activeMessages.length, onUpdateLastExtractAt])
}
