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
import {
  getActiveProvider,
  getMsuicodeFormat,
  getOpenRouterFormat,
} from '../storage/apiProvider'
import type { ChatMessage, ChatSession } from '../types'
import ConfirmDialog from '../components/ConfirmDialog'
import MarkdownRenderer from '../components/MarkdownRenderer'
import VoiceBubble from '../components/VoiceBubble'
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
import ReasoningPanel from '../components/ReasoningPanel'
import { ToolCallGroup, groupToolCalls } from '../components/ToolCallCard'
import type { ToolCallRecord } from '../components/ToolCallCard'
import './ChatPage.css'

// Haptics swallow errors silently — on web / dev / cameraless emulators
// the plugin throws and we'd rather drop the buzz than the click.
const buzz = (style: ImpactStyle = ImpactStyle.Light) => {
  void Haptics.impact({ style }).catch(() => {})
}

export type ChatPageProps = {
  session: ChatSession
  messages: ChatMessage[]
  onOpenDrawer: () => void
  onSendMessage: (
    text: string,
    options?: { attachments?: Array<{ type: 'image'; url: string; width?: number; height?: number }> },
  ) => Promise<void>
  onDeleteMessage: (messageId: string) => void | Promise<void>
  onRegenerate: (assistantMessageId: string) => void | Promise<void>
  onEditUserMessage: (userMessageId: string, newContent: string) => void | Promise<void>
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
  keepaliveEnabled: boolean
  onToggleKeepalive: () => void
  user: User | null
  toolStatus?: string
  remoteStickerPacks?: RemotePackMap
  shareDraft?: string
  onConsumeShare?: () => void
}

// Split an assistant message into multiple "WeChat-style" bubbles ONLY when
// Claude explicitly emits the [NEXT] marker. Paragraph breaks inside the
// reply stay as paragraphs within a single bubble — same behaviour as the
// Claude desktop/web app: long replies = one long bubble, short replies =
// one short bubble. If you want a multi-bubble feel, instruct Claude to
// drop [NEXT] between bubbles (case-insensitive).
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
  onStartLongPress: (event: ReactPointerEvent<HTMLDivElement>, messageId: string) => void
  onCancelLongPress: () => void
  onContextMenuOpen: (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => void
}

const MessageRow = memo(function MessageRow({
  message,
  groupWithPrevious,
  onStartLongPress,
  onCancelLongPress,
  onContextMenuOpen,
}: MessageRowProps) {
  const reasoningText =
    message.meta?.reasoning_text?.trim() ?? message.meta?.reasoning?.trim()
  const segments: MsgSegment[] = (
    message.role === 'assistant'
      ? splitAssistantSegments(message.content)
      : [{ type: 'text' as const, text: message.content }]
  ).flatMap((seg) => (seg.type === 'text' ? splitStickerSegments(seg.text) : [seg]))
  const isOut = message.role === 'user'
  // Only fully hide the row when there's genuinely nothing to show — i.e. a
  // standalone [NEXT] marker. If the turn still carries tool calls, reasoning,
  // or attachments, keep rendering so those aren't swallowed.
  const hasExtras =
    !!reasoningText ||
    (message.meta?.tool_calls?.length ?? 0) > 0 ||
    (message.meta?.flow?.length ?? 0) > 0 ||
    (message.meta?.attachments?.length ?? 0) > 0
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
                {message.meta.attachments
                  .filter((att) => att.type === 'image')
                  .map((att, attIdx) => (
                    <a
                      key={`${message.id}-att-${attIdx}`}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="message-attachment-image"
                    >
                      <img src={att.url} alt="附件图片" loading="lazy" />
                    </a>
                  ))}
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
                <MarkdownRenderer content={chunk} />
              </div>
            ) : (
              <p>{chunk}</p>
            )}
          </div>
        )
      })}
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
  keepaliveEnabled,
  onToggleKeepalive,
  toolStatus,
  remoteStickerPacks,
  shareDraft,
  onConsumeShare,
}: ChatPageProps) => {
  const [draft, setDraft] = useState('')
  const [openActionsId, setOpenActionsId] = useState<string | null>(null)
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
  const [quoted, setQuoted] = useState<{ role: ChatMessage['role']; content: string } | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ type: 'image'; url: string; width?: number; height?: number; path?: string }>
  >([])
  const [uploading, setUploading] = useState(false)
  const [compressing, setCompressing] = useState(false)
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
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Separate input with capture="environment" so tapping the 拍照 button
  // jumps straight into the camera on Android instead of routing through
  // the system chooser (which would let the user pick "Files" / "Photos"
  // and defeat the point of having a dedicated camera shortcut).
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const stickerInputRef = useRef<HTMLInputElement | null>(null)

  const handleSendSticker = (name: string) => {
    setShowStickerTray(false)
    void onSendMessage(`[sticker:${name}]`)
  }

  const handleImportSticker = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    try {
      const dataUrl = await fileToStickerDataUrl(file)
      // [ ] 换行会弄坏 [sticker:名字] 标记（解析正则是 [^\]\n]{1,40}），名字里不能出现
      const sanitize = (s: string) => s.replace(/[[\]\n\r]/g, '').trim().slice(0, 20)
      const base = sanitize(file.name.replace(/\.[^.]+$/, '')) || '贴纸'
      setStickerNameDraft(base)
      setStickerImport({ dataUrl, base })
    } catch {
      // ignore bad image
    }
  }

  const handleDeleteSticker = (name: string) => {
    deleteSticker(name)
  }
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLElement | null>(null)
  // Composer textarea: auto-grows with content up to the CSS max-height.
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
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
    let payload = trimmed
    if (quoted) {
      const quoteBlock = quoted.content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      payload = payload ? `${quoteBlock}\n\n${payload}` : quoteBlock
    }
    const attachments = pendingAttachments.map(({ type, url, width, height }) => ({
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
    await onSendMessage(payload || '（已附图）', attachments.length > 0 ? { attachments } : undefined)
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
        const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
        const photo = await Camera.getPhoto({
          quality: 90,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Camera,
        })
        if (!photo.dataUrl) return
        const res = await fetch(photo.dataUrl)
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

  useEffect(() => {
    const container = messagesRef.current
    if (!container) {
      return
    }
    const isSessionSwitch = lastSessionIdRef.current !== session.id
    const isInitialLoad = lastMessagesLengthRef.current === 0 && messages.length > 0
    const shouldJump = isSessionSwitch || isInitialLoad
    lastSessionIdRef.current = session.id
    lastMessagesLengthRef.current = messages.length
    if (messages.length === 0) {
      return
    }
    // Scroll only the messages container; never let scrollIntoView walk up to
    // window/body and push the sticky header off-screen on mobile.
    const top = container.scrollHeight
    if (shouldJump) {
      container.scrollTop = top
    } else {
      container.scrollTo({ top, behavior: 'smooth' })
    }
  }, [messages.length, session.id])

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
    <div className="chat-page chat-polka-dots">
      <header className="chat-header top-nav app-shell__header">
        <button
          type="button"
          className="ghost chat-header-icon"
          aria-label="返回首页"
          onClick={() => navigate('/')}
        >
          ←
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
          {isStreaming ? (
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
                  <label className="header-menu-toggle">
                    <input
                      type="checkbox"
                      checked={keepaliveEnabled}
                      onChange={onToggleKeepalive}
                    />
                    <span>🔥 缓存保活</span>
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
            // Skip the empty streaming placeholder — the typing
            // indicator below handles this state visually.
            if (
              isStreaming &&
              index === displayedMessages.length - 1 &&
              message.role === 'assistant' &&
              !message.content?.trim()
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
                  onStartLongPress={startLongPress}
                  onCancelLongPress={cancelLongPress}
                  onContextMenuOpen={handleContextMenuOpen}
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
            <span className="quote-preview-label">{quoted.role === 'assistant' ? 'AI' : '我'}：</span>
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
                (remoteStickerPacks?.get(activeStickerPack) ?? []).map((s: RemoteStickerEntry) => (
                  <div key={s.name} className="sticker-panel__item">
                    <button type="button" className="sticker-panel__send" onClick={() => handleSendSticker(s.name)} title={s.name}>
                      <img src={s.url} alt={s.name} loading="lazy" />
                    </button>
                  </div>
                ))
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
                onClick={() => {
                  setOpenAttachMenu(false)
                  fileInputRef.current?.click()
                }}
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
          {/* The "+" used to wrap a hidden <select> for model switching;
              that moved into the header gear menu (less crowding, model
              switching is a session-level thing rather than per-tap).
              Now "+" pops a small two-item sheet — 拍照 vs 从相册 —
              triggering the corresponding hidden file input. The sheet
              auto-closes on click-outside via the effect below. */}
          <button
            type="button"
            className={`composer-icon-btn${openAttachMenu ? ' composer-icon-btn--active' : ''}`}
            aria-label="附加图片"
            title="附加图片"
            onClick={() => { setOpenAttachMenu((v) => !v); setShowStickerTray(false) }}
            disabled={uploading}
          >
            <span aria-hidden="true">＋</span>
          </button>
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
          <button
            type="button"
            className={`composer-icon-btn${showStickerTray ? ' composer-icon-btn--active' : ''}`}
            aria-label="表情包"
            title="表情包"
            onClick={() => { setShowStickerTray((v) => !v); setOpenAttachMenu(false) }}
          >
            <span aria-hidden="true">🧷</span>
          </button>
          {isStreaming ? (
            <button
              type="button"
              className="composer-send-btn composer-send-btn--stop"
              aria-label="停止生成"
              onClick={onStopStreaming}
            >
              <span aria-hidden="true">■</span>
            </button>
          ) : (
            <button
              type="submit"
              className="composer-send-btn"
              aria-label="发送"
              disabled={uploading || (draft.trim().length === 0 && pendingAttachments.length === 0)}
            >
              <span aria-hidden="true">➤</span>
            </button>
          )}
        </div>
      </form>
      {openActionsId && actionsMenuPosition
        ? createPortal(
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
                    <button type="button" role="menuitem" onClick={() => handleCopy(message)}>
                      复制
                    </button>
                    <button type="button" role="menuitem" onClick={() => handleQuote(message)}>
                      引用
                    </button>
                    <button type="button" role="menuitem" onClick={() => void handleShareMessage(message)}>
                      分享
                    </button>
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
        description="图片上传失败，请重试"
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
          const sanitize = (s: string) => s.replace(/[[\]\n\r]/g, '').trim().slice(0, 20)
          const name = sanitize(t)
          if (name) {
            upsertSticker({ name, desc: '', dataUrl: stickerImport.dataUrl })
            setStickers(getStickers())
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
