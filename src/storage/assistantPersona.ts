// User-customisable name for the assistant in the chat header and
// any proactive notifications. Stored client-side only — there's no
// strong reason to round-trip through supabase since this is purely
// a presentation choice.
//
// Default name for the assistant (沈暮). Users who have explicitly renamed
// in-app keep their stored choice; only those on the default see this.

const STORAGE_KEY = 'nimbus_assistant_name'
const DEFAULT_NAME = '沈暮'

export const getAssistantName = (): string => {
  if (typeof window === 'undefined') return DEFAULT_NAME
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const trimmed = raw?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_NAME
}

export const setAssistantName = (value: string): void => {
  if (typeof window === 'undefined') return
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    window.localStorage.removeItem(STORAGE_KEY)
    return
  }
  window.localStorage.setItem(STORAGE_KEY, trimmed)
}

export const ASSISTANT_NAME_DEFAULT = DEFAULT_NAME
