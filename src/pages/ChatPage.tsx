import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import type { ChatMessage, ChatSession } from '../types'
import ConfirmDialog from '../components/ConfirmDialog'
import MarkdownRenderer from '../components/MarkdownRenderer'
import ReasoningPanel from '../components/ReasoningPanel'
import ToolCallCard from '../components/ToolCallCard'
import type { ToolCallRecord } from '../components/ToolCallCard'
import './ChatPage.css'

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
  enabledModels: string[]
  defaultModel: string
  onSelectModel: (model: string | null) => void
  defaultReasoning: boolean
  onSelectReasoning: (reasoning: boolean | null) => void
  onManualCompress: () => Promise<{ ok: boolean; message: string }>
  user: User | null
}

// Split an assistant message into multiple "WeChat-style" bubbles ONLY when
// Claude explicitly emits the [NEXT] marker. Paragraph breaks inside the
// reply stay as paragraphs within a single bubble — same behaviour as the
// Claude desktop/web app: long replies = one long bubble, short replies =
// one short bubble. If you want a multi-bubble feel, instruct Claude to
// drop [NEXT] between bubbles (case-insensitive).
const splitAssistantContent = (content: string): string[] => {
  if (!content) return ['']
  const parts = content
    .split(/\[NEXT\]/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : [content]
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
  const chunks =
    message.role === 'assistant' ? splitAssistantContent(message.content) : [message.content]
  const isOut = message.role === 'user'
  return (
    <div
      className={`message ${isOut ? 'out' : 'in'} ${groupWithPrevious ? 'group-with-previous' : ''}`}
    >
      {chunks.map((chunk, chunkIdx) => {
        const isFirst = chunkIdx === 0
        return (
          <div
            key={`${message.id}-${chunkIdx}`}
            className={`bubble ${chunks.length > 1 ? 'bubble-stacked' : ''}`}
            onPointerDown={(event) => onStartLongPress(event, message.id)}
            onPointerUp={onCancelLongPress}
            onPointerLeave={onCancelLongPress}
            onPointerCancel={onCancelLongPress}
            onPointerMove={onCancelLongPress}
            onContextMenu={(event) => onContextMenuOpen(event, message.id)}
          >
            {isFirst && reasoningText ? <ReasoningPanel reasoning={reasoningText} /> : null}
            {isFirst && Array.isArray(message.meta?.tool_calls) && (message.meta.tool_calls as ToolCallRecord[]).length > 0 ? (
              <div className="tool-calls-section">
                {(message.meta.tool_calls as ToolCallRecord[]).map((tc, tci) => (
                  <ToolCallCard key={tci} name={tc.name} args={tc.args} result={tc.result} duration_ms={tc.duration_ms} />
                ))}
              </div>
            ) : null}
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
            {message.role === 'assistant' ? (
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
  enabledModels,
  defaultModel,
  onSelectModel,
  defaultReasoning,
  onSelectReasoning,
  onManualCompress,
}: ChatPageProps) => {
  const [draft, setDraft] = useState('')
  const [openActionsId, setOpenActionsId] = useState<string | null>(null)
  const [actionsMenuPosition, setActionsMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [openHeaderMenu, setOpenHeaderMenu] = useState(false)
  const [headerMenuPosition, setHeaderMenuPosition] = useState({ top: 0, right: 0 })
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null)
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
      window.alert(result.message)
    } finally {
      setCompressing(false)
    }
  }, [compressing, onManualCompress])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLElement | null>(null)
  const lastSessionIdRef = useRef<string | null>(null)
  const lastMessagesLengthRef = useRef(0)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressTargetRef = useRef<{ id: string; element: HTMLElement | null } | null>(null)
  const headerMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const actionsMenuRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()

  const submitDraft = async () => {
    const trimmed = draft.trim()
    if (!trimmed && pendingAttachments.length === 0) {
      return
    }
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
      window.alert('图片上传失败，请重试')
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
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
          setActionsMenuPosition({ top: rect.bottom + 4, left: rect.left })
        }
        setOpenActionsId(messageId)
      }, 500)
    },
    [],
  )

  const handleContextMenuOpen = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
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
    try {
      await navigator.clipboard.writeText(message.content)
    } catch (error) {
      console.warn('Unable to copy message', error)
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
      if (!headerMenuRef.current) {
        return
      }
      if (headerMenuRef.current.contains(event.target as Node)) {
        return
      }
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
        <button type="button" className="ghost" onClick={onOpenDrawer}>
          会话
        </button>
        <div className="header-title">
          <h1 className="ui-title">哥哥</h1>
        </div>
        <div className="header-actions" ref={headerMenuRef}>
          <button
            ref={headerMenuButtonRef}
            type="button"
            className="ghost"
            onClick={(event) => {
              event.stopPropagation()
              setOpenHeaderMenu((current) => !current)
            }}
          >
            聊天操作
          </button>
          {openHeaderMenu
            ? createPortal(
                <div
                  className="header-menu"
                  style={{ top: `${headerMenuPosition.top}px`, right: `${headerMenuPosition.right}px` }}
                >
                  <div className="header-menu-section-label">本对话</div>
                  <label className="header-menu-toggle">
                    <input
                      type="checkbox"
                      checked={reasoningEnabled}
                      onChange={(event) => onSelectReasoning(event.target.checked)}
                    />
                    <span>🧠 思考链 {reasoningHint}</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleManualCompress}
                    disabled={compressing}
                  >
                    {compressing ? '⏳ 压缩中…' : '📦 手动压缩对话'}
                  </button>
                  <div className="header-menu-divider" />
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHeaderMenu(false)
                      navigate('/snacks')
                    }}
                  >
                    我的主页
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setOpenHeaderMenu(false)
                      navigate('/syzygy')
                    }}
                  >
                    TA的主页
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHeaderMenu(false)
                      navigate('/memory-vault')
                    }}
                  >
                    记忆库
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHeaderMenu(false)
                      navigate('/checkin')
                    }}
                  >
                    打卡
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHeaderMenu(false)
                      navigate('/usage')
                    }}
                  >
                    用量统计
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHeaderMenu(false)
                      navigate('/settings')
                    }}
                  >
                    设置
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHeaderMenu(false)
                      navigate('/export')
                    }}
                  >
                    数据导出
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
        {isStreaming &&
          displayedMessages.length > 0 &&
          displayedMessages[displayedMessages.length - 1]?.role === 'assistant' &&
          !displayedMessages[displayedMessages.length - 1]?.content?.trim() ? (
            <div className="message in">
              <div className="bubble typing-indicator">
                <span /><span /><span />
              </div>
            </div>
          ) : null}
        <div ref={bottomRef} />
      </main>
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
        {isStreaming ? (
          <div className="streaming-status">
            <span>生成中…</span>
            <button type="button" className="ghost stop-button" onClick={onStopStreaming}>
              停止生成
            </button>
          </div>
        ) : null}
        <div className="composer-toolbar">
          <label className="model-selector">
            <span className="chip-label">模型</span>
            <span className="chip-value" title={selectedModel}>
              {selectedModel}
            </span>
            <span className="chip-chevron" aria-hidden="true">
              ˅
            </span>
            <select
              aria-label="选择模型"
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
            className="attach-button toolbar-attach"
            aria-label="发送图片"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            📎 图片
          </button>
        </div>
        <div className="composer-row">
          <textarea
            className="textarea-glass"
            placeholder="输入你的消息"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
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
          <button type="submit" className="btn-primary" disabled={uploading}>
            发送
          </button>
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
    </div>
  )
}

export default ChatPage
