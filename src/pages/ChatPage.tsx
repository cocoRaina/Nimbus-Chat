import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Share } from '@capacitor/share'
import { Clipboard } from '@capacitor/clipboard'
import { Network } from '@capacitor/network'
import { getAssistantName, setAssistantName } from '../storage/assistantPersona'
import MoodOverlay from '../components/MoodOverlay'
import {
  getActiveProvider,
  getMsuicodeFormat,
  getOpenRouterFormat,
} from '../storage/apiProvider'
import type { ChatMessage, ChatSession, MessageAttachment } from '../types'
import ConfirmDialog from '../components/ConfirmDialog'
import MarkdownRenderer from '../components/MarkdownRenderer'
import VoiceBubble from '../components/VoiceBubble'
import VoiceRecordBubble from '../components/VoiceRecordBubble'
import {
  type Sticker,
  type RemotePackMap,
  type RemoteStickerEntry,
  getStickers,
  findSticker,
  upsertSticker,
  deleteSticker,
  fileToStickerDataUrl,
} from '../storage/stickers'
import {
  type PreparedSticker,
  prepareStickerFiles,
  suggestStickerNames,
  dedupeStickerNames,
  sanitizeStickerName,
  uploadStickerPack,
  deleteRemoteSticker,
} from '../storage/stickerImport'
import { saveToAlbum } from '../storage/album'
import { saveToy } from '../storage/toybox'
import { extractArtifactCode } from '../utils/artifact'
import { extractReaction, stripReactionTokens, isUserReactionMessage } from '../storage/reactions'
import {
  WALLPAPERS,
  type WallpaperId,
  getWallpaper,
  setWallpaper,
  getSoundEnabled,
  setSoundEnabled,
} from '../storage/chatFeel'
import ReasoningPanel from '../components/ReasoningPanel'
import { ToolCallGroup, groupToolCalls } from '../components/ToolCallCard'
import type { ToolCallRecord } from '../components/ToolCallCard'
import CallOverlay from '../components/CallOverlay'
import {
  CALL_EVENT,
  cancelIncomingCallNotification,
  claimCallInvite,
  consumeAutoAnswer,
  extractDialRequest,
  extractDndMarker,
  fetchLiveCallInvites,
  getCallConfig,
  isCallEventMessage,
  isCallReady,
  isInviteHandled,
  markInviteHandled,
  notifyIncomingCall,
  sanitizeForSpeech,
  saveCallConfig,
  stripCallMarkers,
  syncCallStateToServer,
  updateCallInviteStatus,
} from '../storage/callConfig'
import './ChatPage.css'

// Haptics swallow errors silently — on web / dev / cameraless emulators
// the plugin throws and we'd rather drop the buzz than the click.
const buzz = (style: ImpactStyle = ImpactStyle.Light) => {
  void Haptics.impact({ style }).catch(() => {})
}

// 长按 AI 消息时的快捷表情回应（Telegram 风格一排）。再点同一个 = 撤销。
const QUICK_REACTIONS = ['❤️', '🥺', '😂', '😮', '😢', '👍']

export type ChatPageProps = {
  session: ChatSession
  messages: ChatMessage[]
  onOpenDrawer: () => void
  onSendMessage: (
    text: string,
    options?: {
      attachments?: MessageAttachment[]
      voiceEmotion?: string
      // 📞 通话（callhome）：callMode 标记这句是电话里说的；silent 只落库不触发
      // 回复；tones = 语调标签（轻声/停顿多/语速慢），拼进语气标注
      callMode?: boolean
      silent?: boolean
      tones?: string[]
    },
  ) => Promise<void>
  onDeleteMessage: (messageId: string) => void | Promise<void>
  onRegenerate: (assistantMessageId: string) => void | Promise<void>
  onEditUserMessage: (userMessageId: string, newContent: string) => void | Promise<void>
  // Telegram 式双向表情回应：用户长按 AI 消息 → 快捷 emoji 行 → 贴/换/撤回应。
  onReactToMessage: (messageId: string, emoji: string) => void | Promise<void>
  isStreaming: boolean
  onStopStreaming: () => void
  // 连发：用户在输入框打字时调用，用来推后「自动回复」定时器，避免还在
  // 打下一条时 AI 就抢着回复（见 App.tsx queueUserMessage）。
  onComposerActivity?: () => void
  enabledModels: string[]
  defaultModel: string
  onSelectModel: (model: string | null) => void
  defaultReasoning: boolean
  highReasoningEnabled: boolean
  onSelectReasoning: (reasoning: boolean | null) => void
  onManualCompress: () => Promise<{ ok: boolean; message: string }>
  // Real context fill for the active session: last turn's server prompt_tokens
  // (current) vs the auto-compression trigger (trigger). Drives the capacity
  // bar under the manual-compress button. current=0 until the first reply lands.
  contextUsage?: { current: number; trigger: number }
  keepaliveEnabled: boolean
  onToggleKeepalive: () => void
  user: User | null
  toolStatus?: string
  remoteStickerPacks?: RemotePackMap
  // Batch sticker import: refresh App's remote pack cache after upload/delete,
  // and the cheap vision model (memory-extract slot) used for auto-naming.
  onRefreshStickers?: () => Promise<void>
  stickerNamingModel?: string
  stickerNamingProvider?: 'openrouter' | 'msuicode'
  shareDraft?: string
  onConsumeShare?: () => void
}

// Split an assistant message into multiple "WeChat-style" bubbles ONLY when
// Claude explicitly emits the [NEXT] marker. Paragraph breaks inside the
// reply stay as paragraphs within a single bubble — same behaviour as the
// Claude desktop/web app: long replies = one long bubble, short replies =
// one short bubble. If you want a multi-bubble feel, instruct Claude to
// drop [NEXT] between bubbles (case-insensitive).
// 引用回复：发送时把被引用的消息按 `> 每行` 前缀进正文（让 AI 也看到
// 上下文），正文再跟在空行之后。渲染时把开头这段 `> …` 拆出来，做成好看的
// 引用卡片，而不是让 `>` 裸露成文字。
const extractLeadingQuote = (text: string): { quote: string; body: string } | null => {
  if (!text.startsWith('>')) return null
  const lines = text.split('\n')
  const q: string[] = []
  let i = 0
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('> ')) q.push(lines[i].slice(2))
    else if (lines[i].startsWith('>')) q.push(lines[i].slice(1))
    else break
  }
  if (q.length === 0) return null
  while (i < lines.length && lines[i].trim() === '') i++ // 跳过空行分隔
  return { quote: q.join('\n').trim(), body: lines.slice(i).join('\n') }
}

const splitAssistantContent = (content: string): string[] =>
  content
    .split(/\[NEXT\]/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

// Split an assistant reply into ordered text / voice segments. The model
// wraps spoken content in [voice]…[/voice]; those become WeChat-style voice
// bars (see VoiceBubble). Everything else is normal text, still subject to
// [NEXT] bubble splitting.
type MsgSegment = { type: 'text' | 'voice' | 'sticker'; text: string }

// Extract [sticker:名字] markers from a text chunk → sticker segments. Applies
// to both user and assistant messages (shared sticker set). `text` of a
// sticker segment is the sticker NAME.
const splitStickerSegments = (text: string): MsgSegment[] => {
  const re = /\[sticker:([^\]\n]{1,40})\]/gi
  if (!re.test(text)) return [{ type: 'text', text }]
  re.lastIndex = 0
  const out: MsgSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index)
    if (before.trim()) out.push({ type: 'text', text: before })
    out.push({ type: 'sticker', text: m[1].trim() })
    last = re.lastIndex
  }
  const tail = text.slice(last)
  if (tail.trim()) out.push({ type: 'text', text: tail })
  return out.length > 0 ? out : [{ type: 'text', text }]
}
const splitAssistantSegments = (content: string): MsgSegment[] => {
  const segs: MsgSegment[] = []
  const re = /\[voice\]([\s\S]*?)\[\/voice\]/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    for (const t of splitAssistantContent(content.slice(last, m.index))) {
      if (t.trim()) segs.push({ type: 'text', text: t })
    }
    const vt = m[1].trim()
    if (vt) segs.push({ type: 'voice', text: vt })
    last = re.lastIndex
  }
  for (const t of splitAssistantContent(content.slice(last))) {
    if (t.trim()) segs.push({ type: 'text', text: t })
  }
  if (segs.length > 0) return segs
  // A message that contains nothing but [NEXT] markers (stored as a standalone
  // DB row) should be invisible rather than rendering "[NEXT]" as text. Require
  // at least one actual [NEXT] — an EMPTY string must NOT match here, or an
  // empty/streaming/tool-only assistant turn would get hidden entirely.
  if (/^\s*(\[NEXT\]\s*)+$/i.test(content)) return []
  return [{ type: 'text', text: content }]
}

// Memoised single-message renderer. The chat history can be hundreds of
// messages; without this, every keystroke in the composer re-runs the
// map over all of them. With stable handler refs from the parent, memo
// bails for every unaffected row.
type MessageRowProps = {
  message: ChatMessage
  groupWithPrevious: boolean
  // Telegram 式表情回应：挂在这条（user）消息气泡上的 emoji，由 ChatPage 从
  // 后续 assistant 消息的 [react:…] 令牌归属而来。
  reaction?: string
  // 发送状态（仅最新一条 user 消息）：写云端期间显示转动的小时钟；
  // 落库后不再显示任何标记（✓✓ 已按用户要求移除）。
  tick?: 'sending'
  onStartLongPress: (event: ReactPointerEvent<HTMLDivElement>, messageId: string) => void
  onCancelLongPress: () => void
  onContextMenuOpen: (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => void
  // 📞 通话中的小机回复：整条当语音条渲染（通话里本来就是说出来的），
  // 而不是露出 [sighs] 这些标签的文字气泡。
  isCallTurn?: boolean
}

// 发送中的小时钟：两根指针绕表心转（SMIL，旋转中心写死 12,12，不依赖
// transform-box）。转 sent 后同位换成 ✓✓（Tidal Echo 的做法）。
const SendingClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.2" />
    <line x1="12" y1="12" x2="12" y2="7">
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite" />
    </line>
    <line x1="12" y1="12" x2="15.2" y2="12">
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="2.1s" repeatCount="indefinite" />
    </line>
  </svg>
)

const MessageRow = memo(function MessageRow({
  message,
  groupWithPrevious,
  reaction,
  tick,
  onStartLongPress,
  onCancelLongPress,
  onContextMenuOpen,
  isCallTurn,
}: MessageRowProps) {
  // 用户的表情回应消息（`[react:…] 「摘录」`）不渲染成气泡——emoji 已经以
  // 角标贴在目标 assistant 气泡上（见 ChatPage reactionByMessageId）。
  if (message.role === 'user' && isUserReactionMessage(message.content)) return null
  // 📞 通话事件行（未接/拒接/已接通/通话记录）：居中小灰条，不是用户气泡。
  if (message.role === 'user' && isCallEventMessage(message.content)) {
    return (
      <div className="call-event">
        <span>{message.content}</span>
      </div>
    )
  }
  const reasoningText =
    message.meta?.reasoning_text?.trim() ?? message.meta?.reasoning?.trim()
  // 📞 通话标记（[call:理由] / [hangup] / [dnd:…]）从正文剥掉；拨号和勿扰
  // 切换在气泡下方留一个小注，标记本体只给通话系统消费。
  const dialReason = message.role === 'assistant' ? extractDialRequest(message.content) : null
  const dndMark = message.role === 'assistant' ? extractDndMarker(message.content) : null
  // [react:…] 令牌原样存在 assistant content 里（模型重放历史能看到自己
  // 上轮的回应），但绝不作为文字渲染——emoji 以角标形式贴在目标 user 气泡上。
  // react-only 回复剥掉令牌后为空 → 整行隐藏：AI 这轮选择了不开口。
  const assistantText =
    message.role === 'assistant'
      ? stripCallMarkers(stripReactionTokens(message.content))
      : message.content
  // 📞 通话中的小机回复：整条清洗成"说出口的话"，当一条语音条渲染（复用
  // [voice] 语音条那套），而不是露标签的文字气泡。TTS 没配时 VoiceBubble
  // 自动降级回文字。
  const callSpoken =
    message.role === 'assistant' && isCallTurn ? sanitizeForSpeech(message.content) : ''
  const segments: MsgSegment[] = (
    message.role === 'assistant'
      ? callSpoken
        ? [{ type: 'voice' as const, text: callSpoken }]
        : assistantText.trim()
          ? splitAssistantSegments(assistantText)
          : []
      : [{ type: 'text' as const, text: message.content }]
  ).flatMap((seg) => (seg.type === 'text' ? splitStickerSegments(seg.text) : [seg]))
  const isOut = message.role === 'user'
  // 只贴表情的 AI 回复（剥掉令牌后没正文、但确实带了 [react:…]）：整条彻底
  // 隐藏。emoji 已经贴到目标 user 气泡上了，这条不该再占任何空间——连它这轮
  // 的思考链空壳也一并藏掉，否则两条消息之间会撑出一片「✦ thinking」空白。
  if (
    message.role === 'assistant' &&
    !assistantText.trim() &&
    !!extractReaction(message.content)
  ) {
    return null
  }
  // Only fully hide the row when there's genuinely nothing to show — i.e. a
  // standalone [NEXT] marker. If the turn still carries tool calls, reasoning,
  // or attachments, keep rendering so those aren't swallowed.
  const hasExtras =
    !!reasoningText ||
    (message.meta?.tool_calls?.length ?? 0) > 0 ||
    (message.meta?.flow?.length ?? 0) > 0 ||
    (message.meta?.attachments?.length ?? 0) > 0 ||
    !!dialReason ||
    !!dndMark
  if (segments.length === 0 && !hasExtras) return null
  return (
    <div
      className={`message ${isOut ? 'out' : 'in'} ${groupWithPrevious ? 'group-with-previous' : ''}`}
    >
      {segments.map((seg, chunkIdx) => {
        const isFirst = chunkIdx === 0
        const chunk = seg.text
        return (
          <div
            key={`${message.id}-${chunkIdx}`}
            className={`bubble ${segments.length > 1 ? 'bubble-stacked' : ''} ${seg.type === 'sticker' ? 'is-sticker' : ''}`}
            onPointerDown={(event) => onStartLongPress(event, message.id)}
            onPointerUp={onCancelLongPress}
            onPointerLeave={onCancelLongPress}
            onPointerCancel={onCancelLongPress}
            onPointerMove={onCancelLongPress}
            onContextMenu={(event) => onContextMenuOpen(event, message.id)}
          >
            {isFirst && (() => {
              const flow = message.meta?.flow
              const toolCalls = message.meta?.tool_calls as ToolCallRecord[] | undefined
              if (flow && flow.length > 0 && toolCalls) {
                // Interleaved thinking + tool cards (Claude-app style).
                // Group consecutive same-name tool events into one card.
                type GroupedEvent =
                  | { type: 'thinking'; content: string; key: number }
                  | { type: 'tool_group'; calls: ToolCallRecord[]; key: number }
                const groupedFlow: GroupedEvent[] = []
                for (const [ei, event] of flow.entries()) {
                  if (event.type === 'thinking') {
                    groupedFlow.push({ type: 'thinking', content: event.content, key: ei })
                  } else {
                    const tc = toolCalls[event.index]
                    if (!tc) continue
                    const last = groupedFlow[groupedFlow.length - 1]
                    if (last && last.type === 'tool_group' && last.calls[0].name === tc.name) {
                      last.calls.push(tc)
                    } else {
                      groupedFlow.push({ type: 'tool_group', calls: [tc], key: ei })
                    }
                  }
                }
                return (
                  <div className="message-flow">
                    {groupedFlow.map((event) =>
                      event.type === 'thinking' ? (
                        <ReasoningPanel key={event.key} reasoning={event.content} />
                      ) : (
                        <div key={event.key} className="tool-calls-section">
                          <ToolCallGroup calls={event.calls} />
                        </div>
                      )
                    )}
                  </div>
                )
              }
              // Fallback: single reasoning panel + all tool cards (grouped)
              return (
                <>
                  {reasoningText ? <ReasoningPanel reasoning={reasoningText} /> : null}
                  {toolCalls && toolCalls.length > 0 ? (
                    <div className="tool-calls-section">
                      {groupToolCalls(toolCalls).map((group, gi) => (
                        <ToolCallGroup key={gi} calls={group} />
                      ))}
                    </div>
                  ) : null}
                </>
              )
            })()}
            {isFirst && message.meta?.attachments && message.meta.attachments.length > 0 ? (
              <div className="message-attachments">
                {message.meta.attachments.map((att, attIdx) =>
                  att.type === 'image' ? (
                    <a
                      key={`${message.id}-att-${attIdx}`}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="message-attachment-image"
                    >
                      <img src={att.url} alt="附件图片" loading="lazy" />
                    </a>
                  ) : att.type === 'voice' ? (
                    <VoiceRecordBubble
                      key={`${message.id}-att-${attIdx}`}
                      url={att.url}
                      duration={att.duration}
                      transcription={att.transcription}
                      emotion={att.emotion}
                      waveform={att.waveform}
                    />
                  ) : null,
                )}
              </div>
            ) : null}
            {seg.type === 'sticker' ? (
              (() => {
                const st = findSticker(chunk)
                return st ? (
                  <img className="chat-sticker" src={st.dataUrl} alt={`[${chunk}]`} loading="lazy" />
                ) : (
                  <p className="sticker-missing">[贴纸:{chunk}]</p>
                )
              })()
            ) : seg.type === 'voice' ? (
              <VoiceBubble text={chunk} />
            ) : message.role === 'assistant' ? (
              <div className="assistant-markdown">
                <MarkdownRenderer
                  content={chunk}
                  artifactsLive={message.meta?.streaming !== true}
                />
              </div>
            ) : message.meta?.attachments?.some(a => a.type === 'voice') ? null : (
              (() => {
                // 引用回复：内容开头的 `> …` 块渲染成 Telegram 式引用卡片
                // （左侧色条 + 淡底），下面才是正文，而不是裸露的 > 符号。
                const q = extractLeadingQuote(chunk)
                if (!q) return <p>{chunk}</p>
                return (
                  <>
                    <div className="msg-quote">{q.quote}</div>
                    {q.body.trim() ? <p>{q.body}</p> : null}
                  </>
                )
              })()
            )}
          </div>
        )
      })}
      {dialReason ? (
        <div className="call-note">📞 想给你打电话：{dialReason}</div>
      ) : null}
      {dndMark ? (
        <div className="call-note">{dndMark === 'on' ? '🔕 已开启勿扰' : '🔔 已关闭勿扰'}</div>
      ) : null}
      {reaction ? (
        <div className="bubble-reaction" aria-label={`表情回应 ${reaction}`}>
          {reaction}
        </div>
      ) : null}
      {tick === 'sending' ? (
        <span className="msg-tick sending" aria-label="发送中">
          <SendingClock />
        </span>
      ) : null}
    </div>
  )
})

// Day/time separator shown above a message when there's a significant
// gap since the previous one. Centred and light, like WeChat.
const formatSeparatorTime = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const hhmm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (sameDay(d, now)) return hhmm
  if (sameDay(d, yesterday)) return `昨天 ${hhmm}`
  // Within the same calendar year: show "M月D日 HH:MM". Otherwise prepend year.
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
}

const TimeSeparator = memo(function TimeSeparator({ timestamp }: { timestamp: string }) {
  return <div className="time-separator">{formatSeparatorTime(timestamp)}</div>
})

const ChatPage = ({
  session,
  messages,
  onOpenDrawer,
  onSendMessage,
  onDeleteMessage,
  onRegenerate,
  onEditUserMessage,
  onReactToMessage,
  isStreaming,
  onStopStreaming,
  onComposerActivity,
  enabledModels,
  defaultModel,
  onSelectModel,
  defaultReasoning,
  highReasoningEnabled,
  onSelectReasoning,
  onManualCompress,
  contextUsage,
  keepaliveEnabled,
  onToggleKeepalive,
  toolStatus,
  remoteStickerPacks,
  onRefreshStickers,
  stickerNamingModel,
  stickerNamingProvider,
  shareDraft,
  onConsumeShare,
  user,
}: ChatPageProps) => {
  const [moodOpen, setMoodOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [openActionsId, setOpenActionsId] = useState<string | null>(null)
  // 🖼 手动收藏进相册（可靠路径，不经过会编瞎话的模型）：长按带图消息 →
  // 弹输入理由 → 直接写库。
  const [albumSave, setAlbumSave] = useState<{ url: string } | null>(null)
  const [albumNote, setAlbumNote] = useState('')
  const [albumSaveStatus, setAlbumSaveStatus] = useState<string | null>(null)
  // 🧸 收藏小玩具：长按带 artifact 的消息 → 起个名字 → 存进 toy_box
  // （直接存代码本体，聊天记录以后被压缩/清理也不影响玩）。
  const [toySave, setToySave] = useState<{ code: string } | null>(null)
  const [toyTitle, setToyTitle] = useState('')
  const [toySaveStatus, setToySaveStatus] = useState<string | null>(null)
  const handleSaveToy = useCallback(async () => {
    const target = toySave
    setToySave(null)
    if (!target || !user) return
    try {
      const res = await saveToy(user.id, toyTitle, target.code, null)
      setToySaveStatus(
        'already_saved' in res
          ? `这个玩具已经在玩具库里啦（${res.already_saved.title}）`
          : '已收进玩具库 ✓ 在记忆库抽屉的 🧸 玩具库里随时能玩',
      )
    } catch (e) {
      setToySaveStatus(`收藏失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [toySave, toyTitle, user])
  const handleSaveToAlbum = useCallback(async () => {
    const target = albumSave
    setAlbumSave(null)
    if (!target || !user) return
    try {
      const res = await saveToAlbum(user.id, target.url, albumNote.trim() || null, [])
      setAlbumSaveStatus(
        'updated' in res ? '已更新备注 ✓' : 'already_saved' in res ? '这张已经在相册里了' : '已收藏进相册 ✓',
      )
    } catch (e) {
      setAlbumSaveStatus(`收藏失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [albumSave, albumNote, user])
  const [actionsMenuPosition, setActionsMenuPosition] = useState<{ top: number; left: number } | null>(null)
  // Native Network plugin → small "已离线" banner above the composer.
  // Defaulted to true; the effect below flips it false if we boot offline.
  const [online, setOnline] = useState(true)
  const [openHeaderMenu, setOpenHeaderMenu] = useState(false)
  const [headerMenuPosition, setHeaderMenuPosition] = useState({ top: 0, right: 0 })
  // The "+" composer button used to be the model picker; per user
  // request it's now an attachment menu (拍照 / 从相册). State drives
  // the small popup that appears above the button.
  const [openAttachMenu, setOpenAttachMenu] = useState(false)
  const [showStickerTray, setShowStickerTray] = useState(false)
  const [activeStickerPack, setActiveStickerPack] = useState<string>('我的')
  const [stickers, setStickers] = useState<Sticker[]>(() => getStickers())
  // Read once on mount; the chat header reflects this for the title +
  // the proactive notification title. Renaming via the settings menu
  // updates both state and localStorage in one step.
  const [assistantName, setAssistantNameState] = useState<string>(
    () => getAssistantName(),
  )
  // Assistant avatar — pulled from the Claude / syzygy homepage where
  // the user can upload one. localStorage is read once; if it
  // changes mid-session (uploaded in another tab) the user can re-
  // enter chat to refresh.
  const assistantAvatar = useMemo(() => {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem('syzygy-homepage-avatar')
  }, [])
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null)
  const [compressionDialog, setCompressionDialog] = useState<string | null>(null)
  const [uploadErrorDialog, setUploadErrorDialog] = useState(false)
  const [renameDialog, setRenameDialog] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [stickerImport, setStickerImport] = useState<{ dataUrl: string; base: string } | null>(null)
  const [stickerNameDraft, setStickerNameDraft] = useState('')
  // 批量导入（登录后走云端）：naming = AI 看图起名中；review = 网格里改名/
  // 改包名；uploading = 逐张上传中。notice 汇报跳过的坏图/起名降级。
  const [stickerBatch, setStickerBatch] = useState<{
    items: PreparedSticker[]
    pack: string
    phase: 'naming' | 'review' | 'uploading'
    progress: { done: number; total: number } | null
    notice: string | null
  } | null>(null)
  // 贴纸导入/删除的失败原因——以前静默吞掉（localStorage 满、HEIC 解不了都
  // 毫无提示，"传不上去了"就是这么来的），现在一律弹出来。
  const [stickerError, setStickerError] = useState<string | null>(null)
  const [quoted, setQuoted] = useState<{ role: ChatMessage['role']; content: string } | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ type: 'image'; url: string; width?: number; height?: number; path?: string }>
  >([])
  const [uploading, setUploading] = useState(false)
  const [compressing, setCompressing] = useState(false)
  // 微信式：左键切换语音/文字模式；按住说话条录音后直发，不预填输入框
  const [voiceMode, setVoiceMode] = useState(false)
  type RecordState = 'idle' | 'recording' | 'sending'
  const [recordState, setRecordState] = useState<RecordState>('idle')
  const [recordDurationMs, setRecordDurationMs] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  const recordStartRef = useRef<number>(0)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const waveformSamplesRef = useRef<number[]>([])
  const [inCancelZone, setInCancelZone] = useState(false)
  const pointerStartXRef = useRef<number>(0)
  // Lazy load: only render the last N messages on entry. The full
  // history is in the prop, but rendering 500+ bubbles + their
  // markdown was the source of the "进入会卡" the user reported.
  const PAGE_SIZE = 30
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE)
  useEffect(() => {
    setDisplayLimit(PAGE_SIZE)
  }, [session.id])
  // When another app shares text to Nimbus, pre-fill the composer.
  useEffect(() => {
    if (shareDraft) {
      setDraft(shareDraft)
      onConsumeShare?.()
    }
    // Only fire when shareDraft actually changes to a new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareDraft])
  // Close sticky overlays on Android hardware back button before navigating away.
  useEffect(() => {
    const handler = (e: Event) => {
      if (showStickerTray) { setShowStickerTray(false); e.preventDefault(); return }
      if (openHeaderMenu) { setOpenHeaderMenu(false); e.preventDefault(); return }
      if (openActionsId) { setOpenActionsId(null); e.preventDefault(); return }
      if (openAttachMenu) { setOpenAttachMenu(false); e.preventDefault(); return }
    }
    window.addEventListener('nimbus:backbutton', handler)
    return () => window.removeEventListener('nimbus:backbutton', handler)
  }, [showStickerTray, openHeaderMenu, openActionsId, openAttachMenu])
  const displayedMessages = useMemo(
    () => (messages.length > displayLimit ? messages.slice(-displayLimit) : messages),
    [messages, displayLimit],
  )
  const hiddenCount = messages.length - displayedMessages.length
  // Telegram 式表情回应归属（双向）。基于完整 messages 算，窗口裁剪不影响：
  // - AI → 用户：带 [react:…] 令牌的 assistant 消息，emoji 挂到它前面最近
  //   一条**有文字**的 user 消息上（连发批次 = 批次最后一条；她的纯回应行
  //   不算目标，AI 的回贴才能落到她真正说话的那条上）。
  // - 用户 → AI：`[react:…] 「摘录」` 的 user 消息按 meta.reactTo.id 定位目标
  //   assistant 行（id/clientId 双匹配）；meta 缺失时兜底挂到前面最近一条
  //   有文字的 assistant 消息。
  // 同一条消息被多次回应时后者覆盖前者。
  const reactionByMessageId = useMemo(() => {
    const map = new Map<string, string>()
    const rowIdByKey = new Map<string, string>()
    for (const m of messages) {
      rowIdByKey.set(m.id, m.id)
      if (m.clientId) rowIdByKey.set(m.clientId, m.id)
    }
    let lastUserId: string | null = null
    let lastAssistantId: string | null = null
    for (const m of messages) {
      if (m.role === 'user') {
        if (isUserReactionMessage(m.content)) {
          const emoji = extractReaction(m.content)
          const targetId =
            (m.meta?.reactTo?.id ? rowIdByKey.get(m.meta.reactTo.id) : undefined) ??
            lastAssistantId
          if (emoji && targetId) map.set(targetId, emoji)
        } else {
          lastUserId = m.id
        }
      } else {
        const emoji = extractReaction(m.content)
        if (emoji && lastUserId) map.set(lastUserId, emoji)
        if (stripReactionTokens(m.content).trim()) lastAssistantId = m.id
      }
    }
    return map
  }, [messages])
  // 📞 通话回合归属：`📞 已接通` 到 `📞 通话结束` 之间的小机回复算"通话中"，
  // 整条渲染成语音条。走消息流一遍算 inCall 状态，稳、不靠单条标记。
  const callTurnIds = useMemo(() => {
    const set = new Set<string>()
    let inCall = false
    for (const m of messages) {
      if (m.role === 'user' && isCallEventMessage(m.content)) {
        if (m.content.startsWith('📞 已接通')) inCall = true
        else if (m.content.startsWith('📞 通话结束')) inCall = false
        continue
      }
      if (inCall && m.role === 'assistant') set.add(m.id)
    }
    return set
  }, [messages])
  // 氛围偏好：聊天壁纸 + 消息音效（storage/chatFeel.ts，localStorage 持久化）。
  const [wallpaper, setWallpaperState] = useState<WallpaperId>(() => getWallpaper())
  const [soundEnabled, setSoundEnabledState] = useState(() => getSoundEnabled())
  const cycleWallpaper = useCallback(() => {
    setWallpaperState((current) => {
      const idx = WALLPAPERS.findIndex((w) => w.id === current)
      const next = WALLPAPERS[(idx + 1) % WALLPAPERS.length].id
      setWallpaper(next)
      return next
    })
  }, [])
  // 送达状态只画在最新一条真实 user 消息上（纯回应行不算），避免整列 ✓✓ 噪音。
  const lastUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && !isUserReactionMessage(m.content)) return m.id
    }
    return null
  }, [messages])
  // "正在输入…" should show from the instant the user sends — not only once
  // streaming actually starts. The optimistic assistant bubble is empty +
  // pending during the async pre-flight (compression / request build) before
  // isStreaming flips; show the indicator (and keep that empty bubble hidden)
  // for that whole window so there's no blank-bubble gap.
  const awaitingReply = useMemo(() => {
    if (isStreaming) return true
    const last = displayedMessages[displayedMessages.length - 1]
    return Boolean(
      last && last.role === 'assistant' && last.pending && !last.content?.trim(),
    )
  }, [isStreaming, displayedMessages])
  // Preserve the user's visible content when "加载更早" expands the window
  // upward — without this, the new older messages would shove the scroll
  // position downward and the user's current view would jump.
  const scrollPreservationRef = useRef<number | null>(null)
  const handleLoadEarlier = useCallback(() => {
    const container = messagesRef.current
    if (container) {
      // Distance from bottom is invariant across the expansion: after the
      // older batch renders we just set scrollTop = scrollHeight - dist.
      scrollPreservationRef.current = container.scrollHeight - container.scrollTop
    }
    setDisplayLimit((current) => current + PAGE_SIZE)
  }, [])
  useLayoutEffect(() => {
    if (scrollPreservationRef.current === null) return
    const container = messagesRef.current
    if (!container) {
      scrollPreservationRef.current = null
      return
    }
    container.scrollTop = container.scrollHeight - scrollPreservationRef.current
    scrollPreservationRef.current = null
  }, [displayedMessages])
  const handleManualCompress = useCallback(async () => {
    if (compressing) return
    setCompressing(true)
    setOpenHeaderMenu(false)
    try {
      const result = await onManualCompress()
      setCompressionDialog(result.message)
    } finally {
      setCompressing(false)
    }
  }, [compressing, onManualCompress])
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Separate input with capture="environment" so tapping the 拍照 button
  // jumps straight into the camera on Android instead of routing through
  // the system chooser (which would let the user pick "Files" / "Photos"
  // and defeat the point of having a dedicated camera shortcut).
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const stickerInputRef = useRef<HTMLInputElement | null>(null)

  // 开始录音（按住说话 pointerDown）
  const startRecording = async () => {
    if (recordState !== 'idle') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const { getBestMimeType } = await import('../storage/voiceRecorder')
      const mimeType = getBestMimeType()
      const mr = new MediaRecorder(stream, { mimeType })
      recordChunksRef.current = []
      waveformSamplesRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data) }
      mediaRecorderRef.current = mr
      recordStartRef.current = Date.now()
      mr.start(200)

      // 实时振幅采样（每 200ms 一次，与 MediaRecorder timeslice 对齐）
      try {
        const audioCtx = new AudioContext()
        audioContextRef.current = audioCtx
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        analyserRef.current = analyser
      } catch {
        // AudioContext 不可用时静默降级为伪随机波形
      }

      setRecordState('recording')
      setRecordDurationMs(0)
      recordTimerRef.current = setInterval(() => {
        setRecordDurationMs(Date.now() - recordStartRef.current)
        // 采样 RMS 振幅，归一化到 0-100
        if (analyserRef.current) {
          const data = new Uint8Array(analyserRef.current.frequencyBinCount)
          analyserRef.current.getByteTimeDomainData(data)
          const rms = Math.sqrt(data.reduce((s, v) => s + (v - 128) ** 2, 0) / data.length)
          waveformSamplesRef.current.push(Math.min(100, Math.round(rms * 2.2)))
        }
      }, 200)
    } catch {
      // 权限拒绝或无麦克风
    }
  }

  // 停止并直接发送（松手）
  const stopAndSend = () => {
    const mr = mediaRecorderRef.current
    if (!mr || recordState !== 'recording') return
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
    // 关闭 AudioContext
    void audioContextRef.current?.close()
    audioContextRef.current = null
    analyserRef.current = null
    // 降采样到 22 根柱，保持最小高度 12
    const raw = waveformSamplesRef.current
    const waveform: number[] | undefined = raw.length >= 2
      ? Array.from({ length: 22 }, (_, i) => {
          const idx = Math.round((i / 21) * (raw.length - 1))
          return Math.max(12, raw[idx])
        })
      : undefined
    waveformSamplesRef.current = []

    mr.onstop = async () => {
      const durationMs = Date.now() - recordStartRef.current
      mr.stream.getTracks().forEach((t) => t.stop())
      const mimeType = mr.mimeType || 'audio/webm'
      const blob = new Blob(recordChunksRef.current, { type: mimeType })
      mediaRecorderRef.current = null
      recordChunksRef.current = []

      // 太短（< 0.8s）= 手滑，忽略
      if (!blob.size || durationMs < 800) {
        setRecordState('idle')
        setRecordDurationMs(0)
        return
      }

      setRecordState('sending')
      try {
        const { uploadVoiceRecording, transcribeVoice } = await import('../storage/voiceRecorder')
        const userId = user?.id
        if (!userId) throw new Error('未登录')

        // 上传（失败直接报错给用户）
        const { url } = await uploadVoiceRecording({ blob, durationMs, mimeType }, userId)

        // 转录（失败不阻断发送，降级为空文字）
        let text = ''
        let emotion: string | null = null
        try {
          const t = await transcribeVoice(url)
          text = t.text
          emotion = t.emotion
        } catch (transcribeErr) {
          console.warn('语音转录失败，继续发送', transcribeErr)
        }

        await onSendMessage(text || '[语音消息]', {
          attachments: [{ type: 'voice' as const, url, duration: durationMs, transcription: text || undefined, emotion: emotion ?? undefined, waveform }],
          ...(emotion ? { voiceEmotion: emotion } : {}),
        })
      } catch (err) {
        console.error('语音发送失败', err)
        setUploadErrorDialog(true)
      } finally {
        setRecordState('idle')
        setRecordDurationMs(0)
      }
    }
    mr.stop()
  }

  // 取消录音（上滑或 pointerCancel）
  const cancelRecording = () => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
    void audioContextRef.current?.close()
    audioContextRef.current = null
    analyserRef.current = null
    waveformSamplesRef.current = []
    mr.onstop = () => {
      mr.stream.getTracks().forEach((t) => t.stop())
      mediaRecorderRef.current = null
      recordChunksRef.current = []
    }
    mr.stop()
    setRecordState('idle')
    setRecordDurationMs(0)
  }

  // ---- 📞 语音通话（callhome）----
  // AI 在回复里嵌 [call:理由] → 这里检测到就全屏响铃；接听后进入轮次制
  // 通话（CallOverlay 负责按住说话 + 自动 TTS 播报 + [hangup] 停留窗口）。
  type CallState = { phase: 'ringing' | 'active'; reason?: string; startedAt: number; inviteId?: string } | null
  const [call, setCall] = useState<CallState>(null)
  const callRef = useRef<CallState>(null)
  callRef.current = call
  const callReady = isCallReady()
  // onSendMessage 每次渲染都是新箭头（闭包含当前会话 id），通话回调用 ref
  // 取最新值，既保持回调身份稳定（CallOverlay 的定时器 effect 不会被重置），
  // 又不会把消息发进旧会话。
  const sendMessageRef = useRef(onSendMessage)
  sendMessageRef.current = onSendMessage

  // 检测新完成的 assistant 消息里的拨号 / 勿扰标记。freshness 3 分钟 +
  // localStorage 已处理清单，保证重载/回看历史不会把旧 [call:] 再响一遍。
  useEffect(() => {
    for (const m of messages.slice(-6)) {
      if (m.role !== 'assistant' || m.meta?.streaming || m.pending || !m.content) continue
      const key = m.clientId ?? m.id
      const created = new Date(m.clientCreatedAt ?? m.createdAt).getTime()
      const fresh = Date.now() - created < 3 * 60_000
      if (!fresh) continue
      const dnd = extractDndMarker(m.content)
      if (dnd && !isInviteHandled(`dnd-${key}`)) {
        markInviteHandled(`dnd-${key}`)
        saveCallConfig({ dnd: dnd === 'on' })
      }
      const reason = extractDialRequest(m.content)
      if (!reason || isInviteHandled(key) || !isCallReady()) continue
      markInviteHandled(key)
      if (getCallConfig().dnd) continue // 勿扰：拨号被拦下（静默）
      if (callRef.current) continue // 已在通话/响铃中
      setCall({ phase: 'ringing', reason, startedAt: Date.now() })
      if (document.visibilityState === 'hidden') void notifyIncomingCall(reason)
    }
  }, [messages])

  // 服务端来电邀请（升级拨号写 call_invites）：8s 轮询认领。
  //   pending 未过期 → 抢占成 ringing → 全屏响铃
  //   pending/ringing 已过期（App 关着没接到）→ 认领成 missed → 触发语音留言
  useEffect(() => {
    if (!callReady || !user) return
    // 让服务端知道功能开了 + 勿扰/时区（call_state 行是升级拨号的开关）
    void syncCallStateToServer()
    const tick = async () => {
      try {
        const rows = await fetchLiveCallInvites()
        for (const row of rows) {
          if (callRef.current?.inviteId === row.id) continue // 正在响的这通
          const expired = Date.now() > new Date(row.expires_at).getTime()
          if (expired) {
            if (await claimCallInvite(row.id, row.status, 'missed')) {
              void sendMessageRef.current(CALL_EVENT.missed)
            }
            continue
          }
          if (row.status !== 'pending' || callRef.current || getCallConfig().dnd) continue
          // 用户从通知的「接听」进来 → 直接接通,跳过响铃页
          if (consumeAutoAnswer() === row.id) {
            if (!(await claimCallInvite(row.id, 'pending', 'accepted'))) continue
            setCall({ phase: 'active', startedAt: Date.now(), inviteId: row.id })
            void sendMessageRef.current(CALL_EVENT.connectedIn)
            continue
          }
          if (!(await claimCallInvite(row.id, 'pending', 'ringing'))) continue
          setCall({ phase: 'ringing', reason: row.reason, startedAt: Date.now(), inviteId: row.id })
          if (document.visibilityState === 'hidden') void notifyIncomingCall(row.reason)
        }
      } catch { /* 未建表/离线：下一拍再试 */ }
    }
    void tick()
    const t = setInterval(tick, 8000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callReady, user?.id])

  const handleAcceptCall = useCallback(() => {
    void cancelIncomingCallNotification()
    const inviteId = callRef.current?.inviteId
    if (inviteId) updateCallInviteStatus(inviteId, 'accepted')
    setCall({ phase: 'active', startedAt: Date.now() })
    void sendMessageRef.current(CALL_EVENT.connectedIn)
  }, [])

  const handleDeclineCall = useCallback((declineReason: string | null) => {
    void cancelIncomingCallNotification()
    const inviteId = callRef.current?.inviteId
    if (inviteId) updateCallInviteStatus(inviteId, 'declined')
    setCall(null)
    void sendMessageRef.current(CALL_EVENT.declined(declineReason))
  }, [])

  const handleMissedCall = useCallback(() => {
    void cancelIncomingCallNotification()
    const inviteId = callRef.current?.inviteId
    if (inviteId) updateCallInviteStatus(inviteId, 'missed')
    setCall(null)
    // 未接 → AI 按系统提示的约定用 [voice] 留一条语音留言
    void sendMessageRef.current(CALL_EVENT.missed)
  }, [])

  const handleEndCall = useCallback((durationMs: number, endedBy: 'user' | 'assistant') => {
    setCall(null)
    // 通话记录只落库，不触发回复（silent）
    void sendMessageRef.current(CALL_EVENT.ended(durationMs, endedBy), { silent: true })
  }, [])

  const handleUserDial = useCallback(() => {
    if (callRef.current) return
    setCall({ phase: 'active', startedAt: Date.now() })
    void sendMessageRef.current(CALL_EVENT.connectedOut)
  }, [])

  const handleCallVoiceTurn = useCallback(
    async (
      text: string,
      options: { attachments?: MessageAttachment[]; voiceEmotion?: string; tones?: string[] },
    ) => {
      await sendMessageRef.current(text, { ...options, callMode: true })
    },
    [],
  )

  // 输入框为空 → 点贴纸直接发（保留一键快发）；输入框有内容 → 把
  // [sticker:名字] 标记追加进草稿，跟文字一起随发送键发出（混合发送）。
  // 渲染端 splitStickerSegments 本来就支持文字+贴纸混排，标记随文字
  // 落进同一条消息即可。托盘保持打开，方便连选多个贴纸。
  const handleSendSticker = (name: string) => {
    const marker = `[sticker:${name}]`
    if (draft.trim()) {
      setDraft((prev) => `${prev.endsWith(' ') || prev.endsWith('\n') || !prev ? prev : `${prev} `}${marker}`)
      return
    }
    setShowStickerTray(false)
    void onSendMessage(marker)
  }

  // All sticker names already in use — remote packs + local — so batch
  // imports never collide with UNIQUE(user_id, name) or shadow a local one.
  const takenStickerNames = () => {
    const taken = new Set<string>(getStickers().map((s) => s.name))
    for (const entries of remoteStickerPacks?.values() ?? []) {
      for (const e of entries) taken.add(e.name)
    }
    return taken
  }

  const handleImportSticker = async (files: FileList | null) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    // 未登录/无 Supabase：退回单张本地导入（localStorage），但失败要说话。
    if (!user) {
      try {
        const dataUrl = await fileToStickerDataUrl(list[0])
        const base = sanitizeStickerName(list[0].name.replace(/\.[^.]+$/, '')) || '贴纸'
        setStickerNameDraft(base)
        setStickerImport({ dataUrl, base })
      } catch {
        setStickerError('无法读取这张图片（可能是 HEIC 等 WebView 不支持的格式），换成 PNG/JPG/WebP 再试试')
      }
      return
    }
    // 登录后：批量导入到自己的 Supabase（贴纸桶 + stickers 表），跨设备同步，
    // AI 的 search_stickers 也搜得到，还不占 localStorage 配额。
    const { items, failures } = await prepareStickerFiles(list)
    if (items.length === 0) {
      setStickerError('一张都没读出来——可能全是 HEIC 等不支持的格式，换成 PNG/JPG/WebP 再试试')
      return
    }
    let notice = failures.length > 0 ? `${failures.length} 张读取失败已跳过。` : ''
    setStickerBatch({ items, pack: '我的表情', phase: 'naming', progress: null, notice: notice || null })
    if (stickerNamingModel?.trim()) {
      try {
        const names = await suggestStickerNames(items, stickerNamingModel, stickerNamingProvider ?? 'openrouter')
        items.forEach((it, i) => { it.name = names[i] })
      } catch (error) {
        console.warn('贴纸 AI 起名失败，退回文件名', error)
        notice += 'AI 起名没成功，先用了默认名，点名字可以改。'
      }
    }
    const deduped = dedupeStickerNames(items.map((it) => it.name), takenStickerNames())
    items.forEach((it, i) => { it.name = deduped[i] })
    // 起名期间用户可能已把对话框关了（cancel 置 null）——别把它顶回来。
    setStickerBatch((prev) =>
      prev ? { ...prev, items: [...items], phase: 'review', notice: notice || null } : null)
  }

  const handleConfirmStickerBatch = async () => {
    if (!stickerBatch || stickerBatch.phase !== 'review') return
    const pack = sanitizeStickerName(stickerBatch.pack) || '我的表情'
    // 手动改名后再去一次重：改成已存在的名字会撞 UNIQUE 约束整行失败。
    const names = dedupeStickerNames(stickerBatch.items.map((it) => it.name), takenStickerNames())
    const items = stickerBatch.items.map((it, i) => ({ ...it, name: names[i] }))
    setStickerBatch((prev) =>
      prev ? { ...prev, items, pack, phase: 'uploading', progress: { done: 0, total: items.length } } : null)
    try {
      const outcome = await uploadStickerPack(items, pack, (done, total) =>
        setStickerBatch((prev) => (prev ? { ...prev, progress: { done, total } } : null)))
      await onRefreshStickers?.()
      setStickerBatch(null)
      setActiveStickerPack(pack)
      if (outcome.failures.length > 0) {
        setStickerError(
          `导入完成：成功 ${outcome.uploaded} 张，失败 ${outcome.failures.length} 张（${outcome.failures[0].reason}）`,
        )
      }
    } catch (error) {
      setStickerBatch((prev) => (prev ? { ...prev, phase: 'review', progress: null } : null))
      setStickerError(`上传失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleDeleteSticker = (name: string) => {
    deleteSticker(name)
  }

  const handleDeleteRemoteSticker = async (entry: RemoteStickerEntry) => {
    try {
      await deleteRemoteSticker(entry.name, entry.url)
      await onRefreshStickers?.()
    } catch (error) {
      setStickerError(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLElement | null>(null)
  const lastSessionIdRef = useRef<string | null>(null)
  const lastMessagesLengthRef = useRef(0)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  // The header menu is rendered via createPortal into document.body, so
  // it's NOT a DOM descendant of headerMenuRef (the .header-actions
  // wrap). Click-outside has to test both refs or taps on items inside
  // the portal close the menu — and worse, for native <select> elements
  // the menu unmounts before the system picker has bound to the select,
  // so the picker silently cancels and the dropdown can't be opened at all.
  const headerMenuPortalRef = useRef<HTMLDivElement | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressTargetRef = useRef<{ id: string; element: HTMLElement | null } | null>(null)
  const headerMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const actionsMenuRef = useRef<HTMLDivElement | null>(null)
  // Rect of the bubble that opened the menu — used by the layout-flip
  // effect below to decide above vs below placement. Ref rather than
  // state because we only need it during the post-render measurement.
  const actionsAnchorRef = useRef<DOMRect | null>(null)
  // TG 式长按抬起：被按气泡的 DOM 节点 + 打开瞬间的位置，portal 里克隆浮起。
  const liftedBubbleRef = useRef<{ element: HTMLElement; rect: DOMRect } | null>(null)
  const navigate = useNavigate()

  // Grow the composer textarea to fit its content (reset to auto first so it
  // also shrinks back when text is deleted or the draft is cleared on send).
  // The visible cap comes from CSS max-height; past that it scrolls.
  useLayoutEffect(() => {
    const el = composerInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  const submitDraft = async () => {
    const trimmed = draft.trim()
    if (!trimmed && pendingAttachments.length === 0) {
      return
    }
    buzz()
    // 自己发消息永远回到底部——即使刚才翻在旧记录里。
    nearBottomRef.current = true
    setShowNewMsgPill(false)
    setShowStickerTray(false)
    let payload = trimmed
    if (quoted) {
      const quoteBlock = quoted.content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      payload = payload ? `${quoteBlock}\n\n${payload}` : quoteBlock
    }
    const imageAttachments: MessageAttachment[] = pendingAttachments.map(({ type, url, width, height }) => ({
      type,
      url,
      width,
      height,
    }))
    setQuoted(null)
    setPendingAttachments([])
    setDraft('')
    if (editingMessageId) {
      const idToEdit = editingMessageId
      setEditingMessageId(null)
      await onEditUserMessage(idToEdit, payload)
      return
    }
    const hasContent = payload || imageAttachments.length > 0
    if (!hasContent) return
    await onSendMessage(
      payload || '（已附图）',
      imageAttachments.length > 0 ? { attachments: imageAttachments } : undefined,
    )
  }

  const handleEdit = (message: ChatMessage) => {
    setDraft(message.content)
    setEditingMessageId(message.id)
    setQuoted(null)
    setOpenActionsId(null)
  }

  const cancelEdit = () => {
    setEditingMessageId(null)
    setDraft('')
  }

  const handleShareMessage = useCallback(async (message: ChatMessage) => {
    setOpenActionsId(null)
    try {
      await Share.share({ text: message.content })
    } catch {
      // User canceled the sheet, or web with no Web Share — ignore.
    }
  }, [])

  const handleFilePick = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const { uploadChatImage } = await import('../storage/imageUpload')
      const uploads = await Promise.all(Array.from(files).map((file) => uploadChatImage(file)))
      setPendingAttachments((prev) => [
        ...prev,
        ...uploads.map((u) => ({
          type: 'image' as const,
          url: u.url,
          width: u.width,
          height: u.height,
          path: u.path,
        })),
      ])
    } catch (uploadError) {
      console.warn('图片上传失败', uploadError)
      setUploadErrorDialog(true)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (cameraInputRef.current) cameraInputRef.current.value = ''
    }
  }

  // Use @capacitor/camera on native (opens the real camera app via Intent),
  // fall back to the hidden file input on web/PWA where the plugin is a no-op.
  const openNativeCamera = async () => {
    setOpenAttachMenu(false)
    if (Capacitor.getPlatform() === 'android') {
      try {
        const { Camera } = await import('@capacitor/camera')
        // takePhoto replaces the deprecated getPhoto in @capacitor/camera v8
        const media = await Camera.takePhoto({ quality: 90 })
        const src = media.webPath ?? media.uri
        if (!src) return
        const res = await fetch(src)
        const blob = await res.blob()
        const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' })
        const dt = new DataTransfer()
        dt.items.add(file)
        void handleFilePick(dt.files)
        return
      } catch {
        // user cancelled — do nothing
        return
      }
    }
    // Web fallback: in-app camera modal via getUserMedia
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      cameraStreamRef.current = stream
      setShowCameraModal(true)
    } catch {
      cameraInputRef.current?.click()
    }
  }

  // On Android, use Camera.chooseFromGallery() so the native multi-select
  // gallery intent fires. Triggering the HTML <input multiple> via .click()
  // goes through Android's file chooser but Capacitor doesn't forward the
  // multiple-file selection correctly — only one image comes back.
  const openNativeGallery = async () => {
    setOpenAttachMenu(false)
    if (Capacitor.getPlatform() === 'android') {
      try {
        const { Camera } = await import('@capacitor/camera')
        // chooseFromGallery replaces the deprecated pickImages in @capacitor/camera v8
        const result = await Camera.chooseFromGallery({ allowMultipleSelection: true, quality: 90 })
        if (!result.results.length) return
        const dt = new DataTransfer()
        for (let i = 0; i < result.results.length; i++) {
          const media = result.results[i]
          // webPath is served by Capacitor's local WebView handler
          // (capacitor://localhost/_capacitor_file_/...) — fetch works because
          // CapacitorHttp only patches http/https, not the capacitor:// scheme.
          const src = media.webPath ?? media.uri
          if (!src) continue
          const res = await fetch(src)
          const blob = await res.blob()
          dt.items.add(new File([blob], `pick_${Date.now()}_${i}.jpg`, { type: 'image/jpeg' }))
        }
        if (dt.files.length) void handleFilePick(dt.files)
      } catch {
        // User cancelled or fetch failed — fall back to HTML file input.
        fileInputRef.current?.click()
      }
      return
    }
    fileInputRef.current?.click()
  }

  // Web-only in-app camera (used as fallback when @capacitor/camera unavailable)
  const [showCameraModal, setShowCameraModal] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (showCameraModal && videoRef.current && cameraStreamRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current
    }
  }, [showCameraModal])

  const closeCameraModal = () => {
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current = null
    setShowCameraModal(false)
  }

  const capturePhoto = () => {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' })
        const dt = new DataTransfer()
        dt.items.add(file)
        void handleFilePick(dt.files)
        closeCameraModal()
      },
      'image/jpeg',
      0.92,
    )
  }

  const removePendingAttachment = (index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const handleQuote = (message: ChatMessage) => {
    setQuoted({ role: message.role, content: message.content })
    setOpenActionsId(null)
  }

  const handleRegenerate = (message: ChatMessage) => {
    setOpenActionsId(null)
    void onRegenerate(message.id)
  }

  // useCallback for handlers passed into MessageRow — keep refs stable
  // so the memoised row doesn't churn on every parent render.
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressTargetRef.current = null
  }, [])

  const startLongPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, messageId: string) => {
      if (event.pointerType === 'mouse') return
      const element = event.currentTarget
      longPressTargetRef.current = { id: messageId, element }
      longPressTimerRef.current = window.setTimeout(() => {
        const target = longPressTargetRef.current
        longPressTimerRef.current = null
        if (!target || target.id !== messageId) return
        const rect = target.element?.getBoundingClientRect()
        if (rect) {
          actionsAnchorRef.current = rect
          // TG 式抬起：记住被按的气泡，portal 里克隆一份浮在遮罩上。
          liftedBubbleRef.current = target.element ? { element: target.element, rect } : null
          // Initial guess — the layout effect refines this once the menu
          // is in the DOM and we know its actual height.
          setActionsMenuPosition({ top: rect.bottom + 4, left: rect.left })
        }
        buzz()
        setOpenActionsId(messageId)
      }, 500)
    },
    [],
  )

  const handleContextMenuOpen = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      actionsAnchorRef.current = rect
      liftedBubbleRef.current = { element: event.currentTarget, rect }
      setActionsMenuPosition({ top: rect.bottom + 4, left: rect.left })
      setOpenActionsId(messageId)
    },
    [],
  )

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    await submitDraft()
  }

  const handleCopy = async (message: ChatMessage) => {
    // Native Clipboard plugin first — navigator.clipboard is unreliable in the
    // Android WebView (silently no-ops without a real secure context / gesture),
    // which is why copy "didn't reach the clipboard". Fall back to the web API.
    try {
      await Clipboard.write({ string: message.content })
      buzz()
    } catch {
      try {
        await navigator.clipboard.writeText(message.content)
        buzz()
      } catch (error) {
        console.warn('Unable to copy message', error)
      }
    } finally {
      setOpenActionsId(null)
    }
  }

  const handleDelete = (message: ChatMessage) => {
    setPendingDelete(message)
    setOpenActionsId(null)
  }

  const handleConfirmDelete = () => {
    if (!pendingDelete) {
      return
    }
    onDeleteMessage(pendingDelete.id)
    setPendingDelete(null)
  }

  const sessionOverride = session.overrideModel?.trim() || null
  const selectedModel = sessionOverride ?? defaultModel
  const sessionOverrideReasoning = session.overrideReasoning ?? null
  const reasoningEnabled = sessionOverrideReasoning ?? defaultReasoning
  const reasoningHint = sessionOverrideReasoning === null ? '（默认）' : '（会话覆盖）'

  // Explain when 思考链 is toggled ON but the current model + provider combo
  // means no reasoning will actually come back, so the switch isn't a
  // silent no-op. Mirrors the two real gates:
  //   1. App.tsx only attaches `reasoning` for Claude models, or for any
  //      model when the global "高触发 Thinking" setting is on.
  //   2. openrouter.ts only routes Claude through the native /v1/messages
  //      path (where thinking is honored) when the active provider isn't in
  //      OpenAI-compat format. An OpenAI-format relay silently drops it.
  // Recomputed each render off localStorage-backed provider settings; the
  // header menu is opened on demand so it always reflects the latest format.
  const reasoningInactiveHint = useMemo(() => {
    if (!reasoningEnabled) return null
    const isClaude = /claude|anthropic/i.test(selectedModel)
    if (!isClaude) {
      return highReasoningEnabled
        ? null
        : '当前模型不是 Claude，思考链需在「设置 → 思考链」打开「高触发 Thinking」才会附加。'
    }
    const provider = getActiveProvider()
    const format = provider === 'openrouter' ? getOpenRouterFormat() : getMsuicodeFormat()
    const userPickedOpenAi = provider === 'openrouter' && format === 'openai'
    const useAnthropicNative =
      !userPickedOpenAi && (format === 'anthropic' || provider === 'openrouter')
    if (!useAnthropicNative) {
      return '当前 API 提供方是「OpenAI 兼容」格式，Claude 思考链不会生效。到「设置 → API 提供方」切到「Anthropic 兼容」即可。'
    }
    return null
  }, [reasoningEnabled, selectedModel, highReasoningEnabled, openHeaderMenu])
  const modelOptions = useMemo(() => {
    const unique = new Set<string>()
    enabledModels.forEach((model) => unique.add(model))
    unique.add(defaultModel)
    if (sessionOverride) {
      unique.add(sessionOverride)
    }
    return Array.from(unique)
  }, [defaultModel, enabledModels, sessionOverride])

  // 「回到最新消息」胶囊：翻旧消息时来了新消息不再硬拽回底部，浮出胶囊让
  // 用户自己点回去（借鉴 Tidal Echo newmsg-pill）。贴底状态用 ref 存，滚动
  // 监听维护；贴底容差 140px。
  const nearBottomRef = useRef(true)
  const [showNewMsgPill, setShowNewMsgPill] = useState(false)
  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    const onScroll = () => {
      const dist = container.scrollHeight - container.scrollTop - container.clientHeight
      const near = dist < 140
      nearBottomRef.current = near
      if (near) setShowNewMsgPill(false)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])
  const scrollToLatest = useCallback((smooth: boolean) => {
    const container = messagesRef.current
    if (!container) return
    nearBottomRef.current = true
    setShowNewMsgPill(false)
    if (smooth) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
    else container.scrollTop = container.scrollHeight
  }, [])
  useEffect(() => {
    const container = messagesRef.current
    if (!container) {
      return
    }
    const isSessionSwitch = lastSessionIdRef.current !== session.id
    const isInitialLoad = lastMessagesLengthRef.current === 0 && messages.length > 0
    const grew = messages.length > lastMessagesLengthRef.current
    const shouldJump = isSessionSwitch || isInitialLoad
    lastSessionIdRef.current = session.id
    lastMessagesLengthRef.current = messages.length
    if (messages.length === 0) {
      return
    }
    // Scroll only the messages container; never let scrollIntoView walk up to
    // window/body and push the sticky header off-screen on mobile.
    if (shouldJump) {
      scrollToLatest(false)
    } else if (nearBottomRef.current) {
      scrollToLatest(true)
    } else if (grew) {
      // 用户正在上面翻记录：不打断，浮出「回到最新」胶囊。
      setShowNewMsgPill(true)
    }
  }, [messages.length, session.id, scrollToLatest])

  useEffect(() => {
    document.body.classList.add('chat-page-active')
    return () => {
      document.body.classList.remove('chat-page-active')
    }
  }, [])

  // Network status banner. getStatus is one-shot (boot value); listener
  // covers transitions. We treat any connected:true as online, even
  // captive-portal'd wifi, because the only thing we use this for is
  // "should the user trust that send will work" — and the chat path
  // already retries on failure.
  useEffect(() => {
    let cancelled = false
    void Network.getStatus()
      .then((status) => {
        if (!cancelled) setOnline(status.connected)
      })
      .catch(() => {})
    const listenerPromise = Network.addListener('networkStatusChange', (status) => {
      setOnline(status.connected)
    })
    return () => {
      cancelled = true
      void listenerPromise.then((handle) => handle.remove()).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!openActionsId) {
      setActionsMenuPosition(null)
      return
    }
    // Position is captured at open-time by startLongPress / handleContextMenuOpen.
    // On scroll or resize the menu would drift off the originating bubble — closing
    // it is the cleanest behaviour (also matches iOS native action menus).
    const closeOnViewportChange = () => setOpenActionsId(null)
    window.addEventListener('resize', closeOnViewportChange)
    window.addEventListener('scroll', closeOnViewportChange, true)
    return () => {
      window.removeEventListener('resize', closeOnViewportChange)
      window.removeEventListener('scroll', closeOnViewportChange, true)
    }
  }, [openActionsId])

  // After the menu renders, measure it and flip above the bubble if there's
  // no room below. Without this the menu sat off-screen / under the input
  // when the user long-pressed a bubble near the bottom (her 17:41 screenshot).
  // Runs synchronously before paint via useLayoutEffect so there's no flash.
  useLayoutEffect(() => {
    if (!openActionsId) return
    const anchor = actionsAnchorRef.current
    const menu = actionsMenuRef.current
    if (!anchor || !menu) return
    const menuH = menu.offsetHeight
    const menuW = menu.offsetWidth
    const vh = window.innerHeight
    const vw = window.innerWidth
    const margin = 8
    let top = anchor.bottom + 4
    if (top + menuH > vh - margin) {
      const above = anchor.top - menuH - 4
      top = above >= margin ? above : Math.max(margin, vh - menuH - margin)
    }
    let left = anchor.left
    if (left + menuW > vw - margin) left = vw - menuW - margin
    if (left < margin) left = margin
    setActionsMenuPosition({ top, left })
  }, [openActionsId])

  useEffect(() => {
    if (!openActionsId) {
      return
    }

    const handleClick = (event: MouseEvent) => {
      if (actionsMenuRef.current?.contains(event.target as Node)) {
        return
      }
      setOpenActionsId(null)
    }

    document.addEventListener('click', handleClick)
    return () => {
      document.removeEventListener('click', handleClick)
    }
  }, [openActionsId])

  useEffect(() => {
    if (!openHeaderMenu) {
      return
    }

    const updateHeaderMenuPosition = () => {
      const triggerRect = headerMenuButtonRef.current?.getBoundingClientRect()
      if (!triggerRect) {
        return
      }
      setHeaderMenuPosition({
        top: triggerRect.bottom + 6,
        right: Math.max(window.innerWidth - triggerRect.right, 12),
      })
    }

    updateHeaderMenuPosition()
    window.addEventListener('resize', updateHeaderMenuPosition)
    window.addEventListener('scroll', updateHeaderMenuPosition, true)

    return () => {
      window.removeEventListener('resize', updateHeaderMenuPosition)
      window.removeEventListener('scroll', updateHeaderMenuPosition, true)
    }
  }, [openHeaderMenu])

  useEffect(() => {
    if (!openHeaderMenu) {
      return
    }
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (headerMenuRef.current?.contains(target)) return
      if (headerMenuPortalRef.current?.contains(target)) return
      setOpenHeaderMenu(false)
    }
    document.addEventListener('click', handleClick)
    return () => {
      document.removeEventListener('click', handleClick)
    }
  }, [openHeaderMenu])

  return (
    <div className={`chat-page ${WALLPAPERS.find((w) => w.id === wallpaper)?.className ?? 'chat-polka-dots'}`}>
      <header className="chat-header top-nav app-shell__header">
        <button
          type="button"
          className="page-back-btn"
          aria-label="返回首页"
          onClick={() => navigate('/')}
        >
          ‹
        </button>
        {assistantAvatar ? (
          <img
            className="chat-header-avatar"
            src={assistantAvatar}
            alt={assistantName}
          />
        ) : null}
        <div className="header-title">
          <h1 className="ui-title">{assistantName}</h1>
          {awaitingReply ? (
            <span className="chat-typing-subtitle" aria-live="polite">
              正在输入<span className="chat-typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </span>
          ) : null}
        </div>
        <div className="header-actions" ref={headerMenuRef}>
          {callReady ? (
            <button
              type="button"
              className="ghost chat-header-icon"
              aria-label="打电话"
              onClick={handleUserDial}
            >
              📞
            </button>
          ) : null}
          <button
            type="button"
            className="ghost chat-header-icon"
            aria-label="沈暮的心"
            onClick={() => setMoodOpen(true)}
          >
            💗
          </button>
          <button
            ref={headerMenuButtonRef}
            type="button"
            className="ghost chat-header-icon"
            aria-label="设置 / 菜单"
            onClick={(event) => {
              event.stopPropagation()
              setOpenHeaderMenu((current) => !current)
            }}
          >
            ⚙️
          </button>
          <button
            type="button"
            className="ghost chat-header-icon"
            aria-label="会话列表"
            onClick={onOpenDrawer}
          >
            ≡
          </button>
          {openHeaderMenu
            ? createPortal(
                <div
                  className="header-menu"
                  ref={headerMenuPortalRef}
                  style={{ top: `${headerMenuPosition.top}px`, right: `${headerMenuPosition.right}px` }}
                >
                  <label className="header-menu-toggle">
                    <input
                      type="checkbox"
                      checked={reasoningEnabled}
                      onChange={(event) => onSelectReasoning(event.target.checked)}
                    />
                    <span>🧠 思考链 {reasoningHint}</span>
                  </label>
                  {reasoningInactiveHint ? (
                    <p className="header-menu-warning">⚠️ {reasoningInactiveHint}</p>
                  ) : null}
                  <label className="header-menu-select">
                    <span>🤖 模型</span>
                    <select
                      value={selectedModel}
                      onChange={(event) => {
                        const next = event.target.value
                        onSelectModel(next === defaultModel ? null : next)
                      }}
                    >
                      {modelOptions.map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {modelId === defaultModel ? `默认：${modelId}` : modelId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={handleManualCompress}
                    disabled={compressing}
                  >
                    {compressing ? '⏳ 压缩中…' : '📦 手动压缩对话'}
                  </button>
                  {contextUsage && contextUsage.trigger > 0 && (() => {
                    const { current, trigger } = contextUsage
                    const pct = current > 0 ? Math.min(100, Math.round((current / trigger) * 100)) : 0
                    const level = pct >= 100 ? 'full' : pct >= 80 ? 'high' : 'ok'
                    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`)
                    return (
                      <div className={`ctx-meter ctx-meter--${level}`}>
                        <div className="ctx-meter__labels">
                          <span>上下文容量</span>
                          <span className="ctx-meter__nums">
                            {current > 0 ? `${fmt(current)} / ${fmt(trigger)}` : '发一条消息后显示'}
                          </span>
                        </div>
                        <div className="ctx-meter__track">
                          <div className="ctx-meter__fill" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="ctx-meter__hint">
                          {current <= 0
                            ? '满格后自动压缩，把上下文压回精简'
                            : level === 'full'
                            ? '已满格 · 下一条会自动压缩'
                            : level === 'high'
                            ? `${pct}% · 快满了，接近自动压缩`
                            : `${pct}% · 到 100% 自动压缩`}
                        </p>
                      </div>
                    )
                  })()}
                  <label className="header-menu-toggle">
                    <input
                      type="checkbox"
                      checked={keepaliveEnabled}
                      onChange={onToggleKeepalive}
                    />
                    <span>🔥 缓存保活</span>
                  </label>
                  <button type="button" onClick={cycleWallpaper}>
                    🎨 聊天背景：{WALLPAPERS.find((w) => w.id === wallpaper)?.label}
                  </button>
                  <label className="header-menu-toggle">
                    <input
                      type="checkbox"
                      checked={soundEnabled}
                      onChange={(event) => {
                        setSoundEnabledState(event.target.checked)
                        setSoundEnabled(event.target.checked)
                      }}
                    />
                    <span>🔔 消息音效</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setRenameDraft(assistantName)
                      setRenameDialog(true)
                      setOpenHeaderMenu(false)
                    }}
                  >
                    ✏️ 修改名称
                  </button>
                </div>,
                document.body,
              )
            : null}
        </div>
      </header>
      <main
        className="chat-messages glass-panel"
        ref={messagesRef}
      >
        {hiddenCount > 0 ? (
          <button type="button" className="load-earlier" onClick={handleLoadEarlier}>
            加载更早（剩余 {hiddenCount} 条）
          </button>
        ) : null}
        {displayedMessages.length === 0 ? (
          <div className="empty-state">
            <p>暂无消息，开始聊点什么吧。</p>
          </div>
        ) : (
          displayedMessages.map((message, index) => {
            const prev = index > 0 ? displayedMessages[index - 1] : null
            const gapMs = prev
              ? new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime()
              : Infinity
            // Show a centred timestamp when the very first displayed message
            // arrives or when there's a noticeable gap (>5min) from previous.
            const showSeparator = !prev || gapMs > 5 * 60 * 1000
            // Same-sender messages within 1 min hug each other tight.
            const groupWithPrevious =
              !!prev && prev.role === message.role && !showSeparator && gapMs < 60 * 1000
            // Skip empty streaming placeholders — the typing indicator
            // handles this state visually. Keyed off the placeholder's
            // OWN streaming/pending flags, not just the global isStreaming:
            // the optimistic assistant bubble is inserted the moment you hit
            // send, but isStreaming only flips true after the async pre-flight
            // (compression, request build) finishes — so relying on isStreaming
            // alone left a blank bubble showing during that gap.
            // NOT limited to the last message: with 连发批处理, a user message
            // sent while a reply is already generating lands AFTER the pending
            // placeholder, which then sat mid-list as a naked empty bubble for
            // the whole generation (the "发了表情包之后有个空气泡" bug).
            if (
              message.role === 'assistant' &&
              !message.content?.trim() &&
              (message.meta?.streaming ||
                message.pending ||
                (isStreaming && index === displayedMessages.length - 1))
            ) {
              return showSeparator ? (
                <TimeSeparator key={message.id} timestamp={message.createdAt} />
              ) : null
            }
            return (
              <Fragment key={message.id}>
                {showSeparator ? <TimeSeparator timestamp={message.createdAt} /> : null}
                <MessageRow
                  message={message}
                  groupWithPrevious={groupWithPrevious}
                  reaction={reactionByMessageId.get(message.id)}
                  tick={
                    user &&
                    message.role === 'user' &&
                    message.id === lastUserMessageId &&
                    (message.pending || message.id === message.clientId)
                      ? 'sending'
                      : undefined
                  }
                  onStartLongPress={startLongPress}
                  onCancelLongPress={cancelLongPress}
                  onContextMenuOpen={handleContextMenuOpen}
                  isCallTurn={callTurnIds.has(message.id)}
                />
              </Fragment>
            )
          })
        )}
        {/* Typing indicator moved to header subtitle (.chat-typing-subtitle)
            so the message stream stays clean. The same isStreaming + empty
            assistant skip above already prevents an empty bubble from
            appearing while we wait for the first token. */}
        <div ref={bottomRef} />
        {/* 「回到最新消息」胶囊：零高 sticky 锚点钉在滚动容器可视区底部
            （不占消息流空间），翻旧消息时来了新消息才浮出，点了平滑回底。 */}
        <div className="newmsg-pill-anchor" aria-hidden={!showNewMsgPill}>
          <button
            type="button"
            className={`newmsg-pill${showNewMsgPill ? ' show' : ''}`}
            tabIndex={showNewMsgPill ? 0 : -1}
            onClick={() => scrollToLatest(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
            回到最新消息
          </button>
        </div>
      </main>
      {toolStatus ? (
        <div className="tool-status-bar" aria-live="polite">
          <span className="tool-status-spinner" aria-hidden="true" />
          <span>{toolStatus}</span>
        </div>
      ) : null}
      <form className="chat-composer glass-card" onSubmit={handleSubmit}>
        {editingMessageId ? (
          <div className="quote-preview">
            <span className="quote-preview-label">✏️ 编辑中</span>
            <span className="quote-preview-content">提交后会重新生成此条之后的全部回复</span>
            <button
              type="button"
              className="quote-preview-close"
              aria-label="取消编辑"
              onClick={cancelEdit}
            >
              ✕
            </button>
          </div>
        ) : null}
        {quoted ? (
          <div className="quote-preview">
            <span className="quote-preview-label">{quoted.role === 'assistant' ? assistantName : '我'}</span>
            <span className="quote-preview-content">{quoted.content}</span>
            <button
              type="button"
              className="quote-preview-close"
              aria-label="取消引用"
              onClick={() => setQuoted(null)}
            >
              ✕
            </button>
          </div>
        ) : null}
        {pendingAttachments.length > 0 ? (
          <div className="attachment-preview-row">
            {pendingAttachments.map((att, index) => (
              <div key={`${att.url}-${index}`} className="attachment-preview-item">
                <img src={att.url} alt="待发送图片" />
                <button
                  type="button"
                  className="attachment-preview-remove"
                  aria-label="移除图片"
                  onClick={() => removePendingAttachment(index)}
                >
                  ✕
                </button>
              </div>
            ))}
            {uploading ? <div className="attachment-preview-uploading">上传中…</div> : null}
          </div>
        ) : uploading ? (
          <div className="attachment-preview-row">
            <div className="attachment-preview-uploading">上传中…</div>
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => void handleFilePick(event.target.files)}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(event) => void handleFilePick(event.target.files)}
        />
        <input
          ref={stickerInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => {
            void handleImportSticker(event.target.files)
            event.target.value = ''
          }}
        />
        {(showStickerTray || openAttachMenu) ? (
          <div
            className="panel-backdrop"
            onClick={() => { setShowStickerTray(false); setOpenAttachMenu(false) }}
          />
        ) : null}
        {showStickerTray ? (
          <div className="sticker-panel">
            <div className="panel-handle" />
            {/* Pack tabs */}
            <div className="sticker-panel__tabs">
              <button
                type="button"
                className={`sticker-panel__tab${activeStickerPack === '我的' ? ' sticker-panel__tab--active' : ''}`}
                onClick={() => setActiveStickerPack('我的')}
              >我的</button>
              {remoteStickerPacks && Array.from(remoteStickerPacks.keys()).map((pack) => (
                <button
                  key={pack}
                  type="button"
                  className={`sticker-panel__tab${activeStickerPack === pack ? ' sticker-panel__tab--active' : ''}`}
                  onClick={() => setActiveStickerPack(pack)}
                >
                  {pack}
                </button>
              ))}
            </div>
            {/* Sticker grid */}
            <div className="sticker-panel__grid">
              {activeStickerPack === '我的' ? (
                <>
                  {stickers.map((s) => (
                    <div key={s.name} className="sticker-panel__item">
                      <button type="button" className="sticker-panel__send" onClick={() => handleSendSticker(s.name)} title={s.name}>
                        <img src={s.dataUrl} alt={s.name} loading="lazy" />
                      </button>
                      <button type="button" className="sticker-panel__del" aria-label="删除" onClick={() => handleDeleteSticker(s.name)}>×</button>
                    </div>
                  ))}
                  <button type="button" className="sticker-panel__add" onClick={() => stickerInputRef.current?.click()}>
                    <span className="sticker-panel__add-icon">＋</span>
                    <span className="sticker-panel__add-label">导入</span>
                  </button>
                </>
              ) : (
                <>
                  {(remoteStickerPacks?.get(activeStickerPack) ?? []).map((s: RemoteStickerEntry) => (
                    <div key={s.name} className="sticker-panel__item">
                      <button type="button" className="sticker-panel__send" onClick={() => handleSendSticker(s.name)} title={s.name}>
                        <img src={s.url} alt={s.name} loading="lazy" />
                      </button>
                      <button type="button" className="sticker-panel__del" aria-label="删除" onClick={() => void handleDeleteRemoteSticker(s)}>×</button>
                    </div>
                  ))}
                  <button type="button" className="sticker-panel__add" onClick={() => stickerInputRef.current?.click()}>
                    <span className="sticker-panel__add-icon">＋</span>
                    <span className="sticker-panel__add-label">导入</span>
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}
        {openAttachMenu ? (
          <div className="attach-panel">
            <div className="panel-handle" />
            <div className="attach-panel__grid">
              <button
                type="button"
                className="attach-panel__tile"
                onClick={() => void openNativeCamera()}
              >
                <span className="attach-panel__tile-icon">📷</span>
                <span className="attach-panel__tile-label">拍照</span>
              </button>
              <button
                type="button"
                className="attach-panel__tile"
                onClick={() => void openNativeGallery()}
              >
                <span className="attach-panel__tile-icon">🖼</span>
                <span className="attach-panel__tile-label">从相册</span>
              </button>
            </div>
          </div>
        ) : null}
        {!online ? (
          <div className="offline-banner" role="status">📡 已离线 — 发送会等到网络恢复后再尝试</div>
        ) : null}
        <div className="composer-row composer-line-row">
          {/* 左侧：语音/文字模式切换 */}
          <button
            type="button"
            className="composer-icon-btn"
            aria-label={voiceMode ? '切换到文字输入' : '切换到语音输入'}
            title={voiceMode ? '切换到文字' : '切换到语音'}
            onClick={() => {
              setVoiceMode((v) => !v)
              setShowStickerTray(false)
              setOpenAttachMenu(false)
            }}
            disabled={recordState !== 'idle'}
          >
            <span aria-hidden="true">{voiceMode ? '⌨️' : '🔊'}</span>
          </button>
          {/* 中间：按住说话条（语音模式）或文字输入框（文字模式） */}
          {voiceMode ? (
            // 保持同一个 div 不销毁，只换 class 和内容，确保 pointer capture 不断。
            // 事件函数始终挂着（不做条件赋值），避免 Android WebView re-render 时
            // 浏览器移除 listener 导致 pointerup/touchend 丢失。
            <div
              className={`composer-hold-bar${recordState === 'recording' ? (inCancelZone ? ' composer-hold-bar--cancel' : ' composer-hold-bar--recording') : recordState === 'sending' ? ' composer-hold-bar--sending' : ''}`}
              onPointerDown={(e) => {
                if (recordState === 'idle') {
                  pointerStartXRef.current = e.clientX
                  setInCancelZone(false)
                  void startRecording()
                }
              }}
              onPointerMove={(e) => {
                if (recordState === 'recording') {
                  setInCancelZone(e.clientX - pointerStartXRef.current < -60)
                }
              }}
              onPointerUp={() => {
                if (recordState === 'recording') {
                  if (inCancelZone) { setInCancelZone(false); cancelRecording() }
                  else stopAndSend()
                }
              }}
              onPointerCancel={() => { if (recordState === 'recording') { setInCancelZone(false); cancelRecording() } }}
              role="button"
              aria-label={recordState === 'idle' ? '按住说话' : recordState === 'recording' ? (inCancelZone ? '松开取消' : '松手发送') : '发送中'}
              tabIndex={0}
            >
              {recordState === 'recording' ? (
                <>
                  <span className="composer-recording-dot" aria-hidden="true" />
                  <span className="composer-hold-bar-text">
                    {inCancelZone ? '← 松开取消' : `${Math.floor(recordDurationMs / 1000)}″ · 松手发送`}
                  </span>
                </>
              ) : recordState === 'sending' ? (
                <span className="composer-hold-bar-text">发送中…</span>
              ) : (
                <span className="composer-hold-bar-text">按住说话 · 左滑取消</span>
              )}
            </div>
          ) : (
            <textarea
              ref={composerInputRef}
              className="composer-line-input"
              placeholder="输入你的消息"
              rows={1}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                onComposerActivity?.()
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void submitDraft()
                }
              }}
            />
          )}
          {/* 贴纸按钮仅文字模式显示 */}
          {!voiceMode && (
            <button
              type="button"
              className={`composer-icon-btn${showStickerTray ? ' composer-icon-btn--active' : ''}`}
              aria-label="表情包"
              title="表情包"
              onClick={() => { setShowStickerTray((v) => !v); setOpenAttachMenu(false) }}
            >
              <span aria-hidden="true">🧷</span>
            </button>
          )}
          {/* 右侧：AI停止 > 取消录音 > 发送中 > 发送 > 附件 */}
          {isStreaming ? (
            <button
              type="button"
              className="composer-send-btn composer-send-btn--stop"
              aria-label="停止生成"
              onClick={onStopStreaming}
            >
              <span aria-hidden="true">■</span>
            </button>
          ) : recordState === 'recording' ? (
            <button
              type="button"
              className="composer-icon-btn"
              aria-label="取消录音"
              onClick={cancelRecording}
            >
              <span aria-hidden="true">✕</span>
            </button>
          ) : recordState === 'sending' ? (
            <button type="button" className="composer-send-btn" disabled aria-label="发送中">
              <span aria-hidden="true">⌛</span>
            </button>
          ) : !voiceMode && (draft.trim().length > 0 || pendingAttachments.length > 0) ? (
            <button
              type="submit"
              className="composer-send-btn"
              aria-label="发送"
              disabled={uploading}
            >
              <span aria-hidden="true">➤</span>
            </button>
          ) : !voiceMode ? (
            <button
              type="button"
              className={`composer-icon-btn${openAttachMenu ? ' composer-icon-btn--active' : ''}`}
              aria-label="附加图片"
              title="附加图片"
              onClick={() => { setOpenAttachMenu((v) => !v); setShowStickerTray(false) }}
              disabled={uploading}
            >
              <span aria-hidden="true">➕</span>
            </button>
          ) : null}
        </div>
      </form>
      {openActionsId && actionsMenuPosition
        ? createPortal(
            <div className="msg-menu">
              <div className="msg-menu-scrim" onClick={() => setOpenActionsId(null)} />
              {liftedBubbleRef.current ? (
                <div
                  className="msg-menu-clone"
                  aria-hidden="true"
                  style={{
                    top: liftedBubbleRef.current.rect.top,
                    left: liftedBubbleRef.current.rect.left,
                    width: liftedBubbleRef.current.rect.width,
                    height: liftedBubbleRef.current.rect.height,
                  }}
                  ref={(node) => {
                    // 命令式克隆被按的气泡 DOM——它带着全局 .bubble 样式，
                    // 浮在遮罩上就是「抬起」效果。portal 关闭即整体卸载。
                    const src = liftedBubbleRef.current?.element
                    if (node && src && node.childElementCount === 0) {
                      const clone = src.cloneNode(true) as HTMLElement
                      clone.style.margin = '0'
                      clone.style.width = '100%'
                      clone.style.maxWidth = 'none'
                      node.appendChild(clone)
                    }
                  }}
                />
              ) : null}
              <div
                className="actions-menu actions-menu-portal"
                role="menu"
                style={{ top: actionsMenuPosition.top, left: actionsMenuPosition.left }}
                ref={actionsMenuRef}
              >
              {(() => {
                const message = messages.find((item) => item.id === openActionsId)
                if (!message) {
                  return null
                }
                return (
                  <>
                    {message.role === 'assistant' ? (
                      <div className="reaction-picker" role="group" aria-label="表情回应">
                        {QUICK_REACTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className={`reaction-picker-btn${
                              reactionByMessageId.get(message.id) === emoji ? ' active' : ''
                            }`}
                            aria-label={`回应 ${emoji}`}
                            onClick={() => {
                              buzz()
                              setOpenActionsId(null)
                              void onReactToMessage(message.id, emoji)
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <button type="button" role="menuitem" onClick={() => handleCopy(message)}>
                      复制
                    </button>
                    <button type="button" role="menuitem" onClick={() => handleQuote(message)}>
                      引用
                    </button>
                    <button type="button" role="menuitem" onClick={() => void handleShareMessage(message)}>
                      分享
                    </button>
                    {message.meta?.attachments?.some((a) => a.type === 'image') ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const img = message.meta?.attachments?.find((a) => a.type === 'image')
                          if (img && 'url' in img && img.url) {
                            setAlbumSave({ url: img.url })
                            setAlbumNote('')
                            setOpenActionsId(null)
                          }
                        }}
                      >
                        🖼 收藏进相册
                      </button>
                    ) : null}
                    {message.role === 'assistant' &&
                    message.meta?.streaming !== true &&
                    extractArtifactCode(message.content) ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const code = extractArtifactCode(message.content)
                          if (code) {
                            setToySave({ code })
                            setToyTitle('')
                            setOpenActionsId(null)
                          }
                        }}
                      >
                        🧸 收进玩具库
                      </button>
                    ) : null}
                    {message.role === 'assistant' ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => handleRegenerate(message)}
                      >
                        重新生成
                      </button>
                    ) : null}
                    {message.role === 'user' ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          handleEdit(message)
                        }}
                      >
                        编辑
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => handleDelete(message)}
                    >
                      删除
                    </button>
                  </>
                )
              })()}
              </div>
            </div>,
            document.body,
          )
        : null}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这条消息？"
        description="此操作会从当前会话中移除这条消息。"
        confirmLabel="删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleConfirmDelete}
      />
      <ConfirmDialog
        open={albumSave !== null}
        title="🖼 收藏进相册"
        description="给这张图写点想留住它的理由（可留空）。"
        confirmLabel="收藏"
        onConfirm={() => void handleSaveToAlbum()}
        onCancel={() => setAlbumSave(null)}
      >
        <textarea
          className="rename-input"
          rows={3}
          value={albumNote}
          onChange={(e) => setAlbumNote((e.target as HTMLTextAreaElement).value)}
          placeholder="比如：你那天笑得眼睛都弯了，想留住"
          autoFocus
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={albumSaveStatus !== null}
        title="相册"
        description={albumSaveStatus ?? ''}
        confirmLabel="好"
        cancelLabel=""
        onConfirm={() => setAlbumSaveStatus(null)}
        onCancel={() => setAlbumSaveStatus(null)}
      />
      <ConfirmDialog
        open={toySave !== null}
        title="🧸 收进玩具库"
        description="给这个小玩具起个名字，存进玩具库以后随时能玩。"
        confirmLabel="收藏"
        onConfirm={() => void handleSaveToy()}
        onCancel={() => setToySave(null)}
      >
        <input
          className="rename-input"
          type="text"
          value={toyTitle}
          onChange={(e) => setToyTitle((e.target as HTMLInputElement).value)}
          placeholder="比如：戳猫猫、生日贺卡、抽签转盘"
          autoFocus
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={toySaveStatus !== null}
        title="玩具库"
        description={toySaveStatus ?? ''}
        confirmLabel="好"
        cancelLabel=""
        onConfirm={() => setToySaveStatus(null)}
        onCancel={() => setToySaveStatus(null)}
      />
      <ConfirmDialog
        open={compressionDialog !== null}
        title="压缩完成"
        description={compressionDialog ?? ""}
        confirmLabel="确定"
        cancelLabel=""
        onConfirm={() => setCompressionDialog(null)}
        onCancel={() => setCompressionDialog(null)}
      />
      <ConfirmDialog
        open={uploadErrorDialog}
        title="上传失败"
        description="发送失败，请检查网络或 Supabase 配置后重试"
        confirmLabel="确定"
        cancelLabel=""
        onConfirm={() => setUploadErrorDialog(false)}
        onCancel={() => setUploadErrorDialog(false)}
      />
      <ConfirmDialog
        open={renameDialog}
        title="修改名称"
        confirmLabel="确认"
        onConfirm={() => { const t = renameDraft.trim(); if (t) { setAssistantName(t); setAssistantNameState(t); } setRenameDialog(false); }}
        onCancel={() => setRenameDialog(false)}
      >
        <input
          type="text"
          className="rename-input"
          value={renameDraft}
          onChange={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
          autoFocus
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={stickerImport !== null}
        title="导入表情"
        description="AI 也会按这个名字发送"
        confirmLabel="确认"
        onConfirm={() => {
          if (!stickerImport) return
          const t = stickerNameDraft.trim() || stickerImport.base
          const name = sanitizeStickerName(t)
          if (name) {
            upsertSticker({ name, desc: '', dataUrl: stickerImport.dataUrl })
            const saved = getStickers()
            setStickers(saved)
            // localStorage 写入在配额满时静默失败（write() 吞掉异常）——
            // 写完读回来核对，丢了就明说，别再让"传不上去"毫无声息。
            if (!saved.some((s) => s.name === name)) {
              setStickerError('本地存储空间满了，这张没存进去。登录后导入会存到云端，不受此限制。')
            }
          }
          setStickerImport(null)
        }}
        onCancel={() => setStickerImport(null)}
      >
        <input
          type="text"
          className="rename-input"
          value={stickerNameDraft}
          onChange={(e) => setStickerNameDraft((e.target as HTMLInputElement).value)}
          autoFocus
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={stickerBatch !== null}
        title={
          stickerBatch?.phase === 'naming'
            ? `导入 ${stickerBatch.items.length} 张表情`
            : stickerBatch?.phase === 'uploading'
              ? '正在上传…'
              : `导入 ${stickerBatch?.items.length ?? 0} 张表情`
        }
        description={
          stickerBatch?.phase === 'naming'
            ? 'AI 正在看图起名，稍等几秒…（名字之后可以改）'
            : 'AI 按名字搜索和发送，改成"想你了/无语"这类情绪短语最好用'
        }
        confirmLabel={
          stickerBatch?.phase === 'uploading'
            ? `上传中 ${stickerBatch.progress?.done ?? 0}/${stickerBatch.progress?.total ?? 0}`
            : '导入'
        }
        confirmDisabled={stickerBatch?.phase !== 'review'}
        cancelDisabled={stickerBatch?.phase === 'uploading'}
        onConfirm={() => void handleConfirmStickerBatch()}
        onCancel={() => {
          if (stickerBatch?.phase !== 'uploading') setStickerBatch(null)
        }}
      >
        {stickerBatch ? (
          <div className="sticker-batch">
            {stickerBatch.notice ? <p className="sticker-batch__notice">{stickerBatch.notice}</p> : null}
            <label className="sticker-batch__pack">
              <span>表情包名</span>
              <input
                type="text"
                value={stickerBatch.pack}
                disabled={stickerBatch.phase === 'uploading'}
                onChange={(e) => {
                  const pack = (e.target as HTMLInputElement).value
                  setStickerBatch((prev) => (prev ? { ...prev, pack } : null))
                }}
              />
            </label>
            <div className="sticker-batch__list">
              {stickerBatch.items.map((item, idx) => (
                <div key={idx} className="sticker-batch__row">
                  <img src={item.dataUrl} alt="" />
                  <input
                    type="text"
                    value={item.name}
                    placeholder={stickerBatch.phase === 'naming' ? '起名中…' : '名字'}
                    disabled={stickerBatch.phase !== 'review'}
                    onChange={(e) => {
                      const name = (e.target as HTMLInputElement).value
                      setStickerBatch((prev) => {
                        if (!prev) return null
                        const items = [...prev.items]
                        items[idx] = { ...items[idx], name }
                        return { ...prev, items }
                      })
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={stickerError !== null}
        title="表情包"
        description={stickerError ?? ''}
        confirmLabel="确定"
        cancelLabel=""
        onConfirm={() => setStickerError(null)}
        onCancel={() => setStickerError(null)}
      />

      <MoodOverlay
        open={moodOpen}
        onClose={() => setMoodOpen(false)}
        userId={user?.id ?? null}
      />

      {call ? (
        <CallOverlay
          phase={call.phase}
          reason={call.reason}
          startedAt={call.startedAt}
          assistantName={assistantName}
          assistantAvatar={assistantAvatar}
          userId={user?.id ?? null}
          messages={messages}
          isStreaming={isStreaming}
          onAccept={handleAcceptCall}
          onDecline={handleDeclineCall}
          onMissed={handleMissedCall}
          onEnd={handleEndCall}
          onSendVoiceTurn={handleCallVoiceTurn}
        />
      ) : null}

      {showCameraModal && createPortal(
        <div className="camera-modal" onClick={closeCameraModal}>
          <video
            ref={videoRef}
            className="camera-preview"
            autoPlay
            playsInline
            muted
            onClick={(e) => e.stopPropagation()}
          />
          <div className="camera-controls" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="camera-close"
              aria-label="关闭"
              onClick={closeCameraModal}
            >✕</button>
            <button
              type="button"
              className="camera-shutter"
              aria-label="拍照"
              onClick={capturePhoto}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

export default ChatPage
