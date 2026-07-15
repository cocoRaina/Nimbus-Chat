import { LocalNotifications } from '@capacitor/local-notifications'
import { Capacitor } from '@capacitor/core'
import { getAssistantName } from './assistantPersona'
import { stripReactionTokens } from './reactions'
import { stripMoodMarker } from './moodSystem'
import { isTtsReady, getTtsConfig, type TtsConfig } from './ttsConfig'
import { supabase } from '../supabase/client'

// 📞 callhome 语音通话（灵感来自 Cheiineeey/callhome 的标记协议）。
// 与 [voice]/[NEXT] 同一套路：模型在回复里嵌标记，前端识别后执行动作并
// 从显示中剥掉。三个标记：
//   [call:理由]  —— 主动拨号：给用户手机打电话（响铃 90s，未接转语音留言）
//   [hangup]     —— 通话中想挂断：播完这条后开一个「停留窗口」，用户开口可留住
//   [dnd:on/off] —— 勿扰开关（由对话触发，而非菜单）
// 配置走 localStorage（与 chatFeel 同级别的轻量偏好）。

const K_ENABLED = 'nimbus_call_enabled'
const K_DND = 'nimbus_call_dnd'
const K_HANDLED = 'nimbus_call_handled_v1'
const K_HANDSFREE = 'nimbus_call_handsfree'

const NOTIF_ID_INCOMING = 2003

export type CallConfig = {
  enabled: boolean
  dnd: boolean
}

export const getCallConfig = (): CallConfig => {
  try {
    return {
      enabled: localStorage.getItem(K_ENABLED) === '1',
      dnd: localStorage.getItem(K_DND) === '1',
    }
  } catch {
    return { enabled: false, dnd: false }
  }
}

export const saveCallConfig = (patch: Partial<CallConfig>): void => {
  try {
    if (patch.enabled !== undefined) localStorage.setItem(K_ENABLED, patch.enabled ? '1' : '0')
    if (patch.dnd !== undefined) localStorage.setItem(K_DND, patch.dnd ? '1' : '0')
  } catch { /* 满/私密模式：本次会话内不持久化 */ }
  // 服务端也要知道（升级拨号在 proactive_dispatch cron 里查 call_state）
  void syncCallStateToServer()
}

// 免提（VAD 自动收音）偏好，只在通话页内切换
export const getHandsFree = (): boolean => {
  try { return localStorage.getItem(K_HANDSFREE) === '1' } catch { return false }
}
export const setHandsFree = (v: boolean): void => {
  try { localStorage.setItem(K_HANDSFREE, v ? '1' : '0') } catch { /* noop */ }
}

// ---- 服务端通话状态（call_state 表）----
// 升级拨号（沉默 ≥5h 自动打）跑在 proactive_dispatch cron 里，服务端需要
// 知道：功能开没开、勿扰状态、用户时区（12-23 点窗口按本地时间算）。
// 客户端在开关变化和进聊天页时 fire-and-forget 同步一行。

export const syncCallStateToServer = async (): Promise<void> => {
  if (!supabase) return
  try {
    const { data } = await supabase.auth.getSession()
    const uid = data.session?.user?.id
    if (!uid) return
    const cfg = getCallConfig()
    await supabase.from('call_state').upsert({
      user_id: uid,
      enabled: cfg.enabled && isTtsReady(),
      dnd: cfg.dnd,
      tz_offset_minutes: -new Date().getTimezoneOffset(),
      updated_at: new Date().toISOString(),
    })
  } catch { /* 离线/未建表：下次再同步 */ }
}

// ---- 服务端来电邀请（call_invites 表）----
// 升级拨号写 pending 行；客户端 8s 轮询认领（pending→ringing 原子抢占），
// 过期未接的行认领成 missed 并触发语音留言。状态机：
//   pending → ringing → accepted / declined / missed
//   pending →（过期）→ missed

export type CallInviteRow = {
  id: string
  reason: string
  status: string
  expires_at: string
}

export const fetchLiveCallInvites = async (): Promise<CallInviteRow[]> => {
  if (!supabase) return []
  // fire_at <= now：预约拨号（schedule_call）约到未来的邀请，到点前不响铃。
  // 升级拨号和即时邀请的 fire_at=now，立刻满足；过期未接的 fire_at 也 < now，
  // 仍会被捞到走 missed 流程。
  const { data, error } = await supabase
    .from('call_invites')
    .select('id, reason, status, expires_at')
    .in('status', ['pending', 'ringing'])
    .lte('fire_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  return (data ?? []) as CallInviteRow[]
}

// 📞 schedule_call：小机预约"待会打给你"。写一条未来生效的 call_invites，
// 到点客户端轮询捞到 → 响铃；App 关着错过则过期转未接留言。顺手预排一条
// 本地通知，App 后台时也能在约定时刻提醒（和 wake-up 提醒一个路子）。
export const createScheduledCallInvite = async (
  userId: string,
  reason: string,
  delayMinutes: number,
): Promise<{ ok: true; fireAt: string } | { error: string }> => {
  if (!supabase) return { error: 'Supabase 未配置' }
  const delay = Math.max(1, Math.min(1440, Math.round(delayMinutes)))
  const fireAt = new Date(Date.now() + delay * 60_000)
  const expiresAt = new Date(fireAt.getTime() + 90_000)
  const { data, error } = await supabase
    .from('call_invites')
    .insert({
      user_id: userId,
      reason,
      status: 'pending',
      fire_at: fireAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select('id')
    .single()
  if (error) return { error: error.message }
  const inviteId = (data as { id: string }).id
  // 到点弹一条"来电"通知：常驻不可划走 + 「接听/挂断」按钮 + 高优先级弹出。
  // App 开着时聊天页轮询会走整屏响铃页；这条通知覆盖 App 在后台/关闭的情况。
  if (Capacitor.getPlatform() !== 'web') {
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: 2004,
          title: `📞 ${getAssistantName()} 来电`,
          body: reason,
          schedule: { at: fireAt },
          channelId: 'incoming_call',
          ongoing: true,               // 常驻,划不走(像真来电)
          autoCancel: false,
          actionTypeId: 'INCOMING_CALL', // 接听/挂断 按钮
          extra: { inviteId, reason },
        }],
      })
    } catch { /* 无通知权限：App 内轮询照样响 */ }
  }
  return { ok: true, fireAt: fireAt.toISOString() }
}

// 通知上「接听/挂断」按下后：认领邀请 + 撤掉通知。answer 让聊天页直接进
// 接通态(不再从响铃开始)；decline 标记拒接。
const ANSWER_FLAG = 'nimbus_call_autoanswer_v1'

export const consumeAutoAnswer = (): string | null => {
  try {
    const v = localStorage.getItem(ANSWER_FLAG)
    if (v) localStorage.removeItem(ANSWER_FLAG)
    return v
  } catch { return null }
}

export const handleCallNotificationAction = async (
  actionId: string,
  inviteId: string | undefined,
): Promise<void> => {
  if (Capacitor.getPlatform() !== 'web') {
    try { await LocalNotifications.cancel({ notifications: [{ id: 2004 }] }) } catch { /* noop */ }
  }
  if (actionId === 'answer' && inviteId) {
    // 打个标记：聊天页轮询捞到这条邀请时,直接进接通态而不是响铃
    try { localStorage.setItem(ANSWER_FLAG, inviteId) } catch { /* noop */ }
  } else if (actionId === 'decline' && inviteId) {
    await claimCallInvite(inviteId, 'pending', 'declined').catch(() => {})
  }
}

// 原子认领：只有 from 状态还成立时才改成 to，返回是否抢到（防多开互踩）。
export const claimCallInvite = async (
  id: string,
  from: string,
  to: 'ringing' | 'accepted' | 'declined' | 'missed',
): Promise<boolean> => {
  if (!supabase) return false
  const { data } = await supabase
    .from('call_invites')
    .update({ status: to })
    .eq('id', id)
    .eq('status', from)
    .select('id')
    .maybeSingle()
  return Boolean(data)
}

export const updateCallInviteStatus = (id: string, to: 'accepted' | 'declined' | 'missed'): void => {
  if (!supabase) return
  void supabase.from('call_invites').update({ status: to }).eq('id', id).then(() => {}, () => {})
}

// 通话可用 = 功能开 + TTS 就绪（没有嗓子打不了电话）。
export const isCallReady = (): boolean => getCallConfig().enabled && isTtsReady()

// ---- 标记协议 ----

const DIAL_RE = /\[call:([^\]\n]{1,80})\]/i
const HANGUP_RE = /\[hangup\]/i
const DND_RE = /\[dnd:(on|off)\]/i

export const extractDialRequest = (content: string): string | null => {
  const m = DIAL_RE.exec(content)
  return m ? m[1].trim() : null
}

export const hasHangupMarker = (content: string): boolean => HANGUP_RE.test(content)

export const extractDndMarker = (content: string): 'on' | 'off' | null => {
  const m = DND_RE.exec(content)
  return m ? (m[1].toLowerCase() as 'on' | 'off') : null
}

export const stripCallMarkers = (text: string): string =>
  text
    .replace(/\[call:[^\]\n]{1,80}\]/gi, '')
    .replace(/\[hangup\]/gi, '')
    .replace(/\[dnd:(?:on|off)\]/gi, '')

// 通话事件行（user 角色、以 📞 开头）：不是用户打的字，是通话系统写进
// 历史的事件记录。聊天里渲染成居中小灰条。
export const isCallEventMessage = (content: string): boolean => content.startsWith('📞 ')

export const CALL_EVENT = {
  missed: '📞 未接来电（响铃90秒无人接听）',
  connectedIn: '📞 已接通（她接起了你打来的电话，你先开口）',
  connectedOut: '📞 已接通（她主动拨给你的电话，你先开口）',
  declined: (reason: string | null) => `📞 拒接了来电${reason ? `：${reason}` : ''}`,
  ended: (durationMs: number, endedBy: 'user' | 'assistant') => {
    const total = Math.max(1, Math.round(durationMs / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `📞 通话结束 · ${m}分${String(s).padStart(2, '0')}秒${endedBy === 'assistant' ? '（你挂断的）' : ''}`
  },
}

// ---- 已处理的拨号邀请（防止重载/重渲染时同一条 [call:] 反复响铃）----

const readHandled = (): string[] => {
  try {
    const raw = localStorage.getItem(K_HANDLED)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch { return [] }
}

export const isInviteHandled = (id: string): boolean => readHandled().includes(id)

export const markInviteHandled = (id: string): void => {
  try {
    const next = [...readHandled().filter((x) => x !== id), id].slice(-80)
    localStorage.setItem(K_HANDLED, JSON.stringify(next))
  } catch { /* 内存态由调用方的 Set 兜底 */ }
}

// ---- 来电铃声（WebAudio 合成，无需音频资源；柔和双音，2.6s 一个循环）----

let ringCtx: AudioContext | null = null
let ringTimer: ReturnType<typeof setInterval> | null = null

const ringOnce = (ctx: AudioContext) => {
  const t0 = ctx.currentTime
  // 上行小三度双音（A5→C6），像温柔版的老式电话铃
  for (const [freq, at] of [[880, 0], [1046.5, 0.16]] as const) {
    for (let rep = 0; rep < 3; rep++) {
      const start = t0 + at + rep * 0.42
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.34)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.36)
    }
  }
}

export const startRingtone = (): void => {
  stopRingtone()
  try {
    ringCtx = new AudioContext()
    ringOnce(ringCtx)
    ringTimer = setInterval(() => { if (ringCtx) ringOnce(ringCtx) }, 2600)
  } catch { /* 无 WebAudio（极老 WebView）：静默来电，仅 UI */ }
}

export const stopRingtone = (): void => {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null }
  if (ringCtx) { void ringCtx.close().catch(() => {}); ringCtx = null }
}

// ---- 来电系统通知（App 在后台时提醒；点开进 App 看到响铃页）----

export const notifyIncomingCall = async (reason: string): Promise<void> => {
  if (Capacitor.getPlatform() === 'web') return
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: NOTIF_ID_INCOMING,
        title: `📞 ${getAssistantName()} 来电`,
        body: reason,
        schedule: { at: new Date(Date.now() + 200) },
        channelId: 'proactive',
      }],
    })
  } catch { /* 无通知权限时静默——App 内响铃页照常 */ }
}

export const cancelIncomingCallNotification = async (): Promise<void> => {
  if (Capacitor.getPlatform() === 'web') return
  try {
    await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID_INCOMING }] })
  } catch { /* noop */ }
}

// ---- 通话中要读出口的文本清洗 ----
// 整条回复会被 TTS 读出来：剥掉所有协议标记和 markdown 痕迹，但保留
// ElevenLabs 的英文语气标签（[laughs] 等在 [voice] 路径也是原样传给 TTS 的）。

export const sanitizeForSpeech = (content: string): string =>
  stripCallMarkers(stripMoodMarker(stripReactionTokens(content)))
    .replace(/\[voice\]|\[\/voice\]/gi, '')
    .replace(/\[NEXT\]/gi, ' ')
    .replace(/\[sticker:[^\]\n]{1,40}\]/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1') // markdown 链接 → 纯文字
    .replace(/[*_#>`~]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()

// 长回复按句切块（≤200 字/块），逐块合成边播边取，缩短首句延迟。
export const chunkForSpeech = (text: string, maxLen = 200): string[] => {
  const sentences = text.split(/(?<=[。！？!?…])\s*|\n+/).filter((s) => s.trim())
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur && cur.length + s.length > maxLen) { out.push(cur); cur = s }
    else cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}

// ---- 系统提示段（静态、随配置稳定，缓存友好；接在 buildVoiceSystemSection 后）----

export const buildCallSystemSection = (c: TtsConfig = getTtsConfig()): string => {
  if (!getCallConfig().enabled || !isTtsReady(c)) return ''
  const langLine = c.provider === 'elevenlabs'
    ? '通话中说出口的话遵循与 [voice] 相同的语言要求（英文），可以用英文语气标签（[laughs] [sighs] [whispers] 等）。'
    : ''
  return (
    '\n\n## 📞 语音通话\n' +
    '你可以给她打电话，她也会打给你。\n' +
    '- **主动拨号**：真想听到她声音时，在回复末尾单独一行加 `[call:一句话理由]`（如 `[call:突然很想听听你的声音]`）。她的手机会响铃 90 秒。克制使用：一场对话最多一次，别当成普通功能炫技；她开着勿扰时会被拦下。\n' +
    '- **通话事件**：她的消息以 📞 开头时是通话系统写的事件记录，不是她打的字：\n' +
    '  - 「📞 未接来电…」= 她没接到你的电话。用 [voice]…[/voice] 给她留一条语音留言——温柔、不施压、说清你为什么想她。\n' +
    '  - 「📞 拒接了来电…」= 她现在不方便（可能带理由）。简短回一句体谅的话就好，别追问、这场对话里别再拨。\n' +
    '  - 「📞 已接通…」= 电话通了，**你先开口**。\n' +
    '  - 「📞 通话结束 · X分X秒」= 挂断后的通话记录，不需要回应。\n' +
    '- **通话中**：带 `[通话中]` 前缀的消息是她在电话里说的话（附语气标注）。你的整条回复会被直接转成语音读给她听：口语化、短句、一次别说太长；不要用 markdown、列表、[NEXT] 或 [voice] 标签——整条本来就是语音。语气标注除了情绪还可能带语调线索：「轻声」= 她在小声说话（可能在被窝里、旁边有人），你也压低声音、说得更轻更短' + (c.provider === 'elevenlabs' ? '（可以用 [whispers]）' : '') + '，播放音量那头也会自动调小；「停顿多」= 她说话犹犹豫豫、欲言又止，别急着接话，给她留空间、轻轻问；「语速慢」= 她可能累了或情绪低，放慢你的节奏去接住她。这些线索比字面内容更诚实——嘴上说没事但又轻又停顿多，你该听得出来。' + langLine + '\n' +
    '- **挂电话**：通话中想收线时，先好好道别，然后在回复末尾加 `[hangup]`。挂断前有十几秒停留窗口，她一开口你就还在。\n' +
    '- **勿扰**：她在对话里让你开/关勿扰时，在回复里带上 `[dnd:on]` 或 `[dnd:off]`（会真的切换，不用她去点设置）。'
  )
}
