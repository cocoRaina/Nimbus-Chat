import { registerPlugin } from '@capacitor/core'

export interface NowPlaying {
  playing: boolean
  title?: string
  artist?: string
  album?: string
  duration_seconds?: number
  position_seconds?: number
  package_name?: string
  app?: string
}

export interface MediaControlPlugin {
  /** Play/pause/next/previous the current media (precise via session, or media-key fallback). */
  control(options: { action: string }): Promise<{ ok: boolean; action: string; method: string }>
  /** Read what's currently playing. Rejects with "NO_PERMISSION" if notification access isn't granted. */
  getNowPlaying(): Promise<NowPlaying>
  /** Whether the app is an enabled notification listener (the get_now_playing gate). */
  hasPermission(): Promise<{ granted: boolean }>
  /** Open Settings → 通知使用权 so the user can grant notification access. */
  requestPermission(): Promise<void>
  /** Fire an ACTION_VIEW intent. Pass packageName to route directly to a specific app (skips browser chooser). */
  openUrl(options: { url: string; packageName?: string }): Promise<{ ok: boolean }>
}

export const MediaControlPlugin = registerPlugin<MediaControlPlugin>('MediaControl')
