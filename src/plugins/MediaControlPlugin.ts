import { registerPlugin } from '@capacitor/core'

export interface MediaControlPlugin {
  control(options: { action: string }): Promise<{ ok: boolean }>
}

export const MediaControlPlugin = registerPlugin<MediaControlPlugin>('MediaControl')
