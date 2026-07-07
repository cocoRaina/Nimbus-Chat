// 聊天氛围偏好（借鉴 Tidal Echo 的 UI 细节）：
//   - 聊天壁纸：三套纯 CSS 主题（点阵/暮色/海雾），localStorage 持久化。
//   - 消息音效：WebAudio 现场合成的软提示音（无二进制资产、无授权问题），
//     发送上滑音、接收下滑音；跟随手机静音/震动（读 envSnapshot 缓存行）。
import { peekEnvSnapshot } from './envState'

export type WallpaperId = 'polka' | 'dusk' | 'seafog'

export const WALLPAPERS: Array<{ id: WallpaperId; label: string; className: string }> = [
  { id: 'polka', label: '点阵', className: 'chat-polka-dots' },
  { id: 'dusk', label: '暮色', className: 'chat-wall-dusk' },
  { id: 'seafog', label: '海雾', className: 'chat-wall-seafog' },
]

const WALL_KEY = 'nimbus_chat_wallpaper'
const SOUND_KEY = 'nimbus_chat_sound'

export const getWallpaper = (): WallpaperId => {
  try {
    const v = window.localStorage.getItem(WALL_KEY)
    if (v && WALLPAPERS.some((w) => w.id === v)) return v as WallpaperId
  } catch { /* ignore */ }
  return 'seafog' // 默认海雾（晨雾蓝）；点阵/暮色在 ⚙️ 菜单循环切
}

export const setWallpaper = (id: WallpaperId): void => {
  try { window.localStorage.setItem(WALL_KEY, id) } catch { /* quota */ }
}

export const getSoundEnabled = (): boolean => {
  try { return window.localStorage.getItem(SOUND_KEY) !== '0' } catch { return true }
}

export const setSoundEnabled = (v: boolean): void => {
  try { window.localStorage.setItem(SOUND_KEY, v ? '1' : '0') } catch { /* quota */ }
}

// ── 消息提示音（WebAudio 合成）─────────────────────────────────────────────
// AudioContext 惰性创建：首次调用多半在发送点击（用户手势）里，天然解锁。
// 之后接收音复用同一个 context。创建/恢复失败一律静默跳过，绝不影响聊天。
let audioCtx: AudioContext | null = null

const ensureAudioCtx = (): AudioContext | null => {
  if (!audioCtx) {
    try { audioCtx = new AudioContext() } catch { return null }
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {})
  return audioCtx
}

const playSlide = (
  ctx: AudioContext,
  from: number,
  to: number,
  durS: number,
  vol: number,
): void => {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const t0 = ctx.currentTime
  osc.type = 'sine'
  osc.frequency.setValueAtTime(from, t0)
  osc.frequency.exponentialRampToValueAtTime(to, t0 + durS)
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durS)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + durS + 0.02)
}

export const playMessageSound = (kind: 'send' | 'receive'): void => {
  if (!getSoundEnabled()) return
  // 手机静音/震动时不出声。envSnapshot 是给模型看的环境快照缓存行
  // （mount/前台时刷新），这里蹭它做同步判断——APK 上有值，web 上为 null
  // （无原生插件）则默认出声。
  const env = peekEnvSnapshot()
  if (env && (env.includes('静音') || env.includes('震动'))) return
  const ctx = ensureAudioCtx()
  if (!ctx || ctx.state !== 'running') return
  if (kind === 'send') playSlide(ctx, 660, 920, 0.1, 0.06)
  else playSlide(ctx, 880, 620, 0.12, 0.05)
}
