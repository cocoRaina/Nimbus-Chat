import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import type { ChatMessage, ChatSession } from '../types'
import ConfirmDialog from '../components/ConfirmDialog'
import MarkdownRenderer from '../components/MarkdownRenderer'
import ReasoningPanel from '../components/ReasoningPanel'
import './ChatPage.css'

export type ChatPageProps = {
  session: ChatSession
  messages: ChatMessage[]
  onOpenDrawer: () => void
  onSendMessage: (text: string) => Promise<void>
  onDeleteMessage: (messageId: string) => void | Promise<void>
  onRegenerate: (assistantMessageId: string) => void | Promise<void>
  isStreaming: boolean
  onStopStreaming: () => void
  enabledModels: string[]
  defaultModel: string
  onSelectModel: (model: string | null) => void
  defaultReasoning: boolean
  onSelectReasoning: (reasoning: boolean | null) => void
  user: User | null
}

// Split an assistant message into multiple "WeChat-style" bubbles.
// Splits on 2+ consecutive newlines (Claude's natural paragraph breaks) or an
// explicit `[NEXT]` marker (case-insensitive). User messages stay as one bubble.
const splitAssistantContent = (content: string): string[] => {
  if (!content) return ['']
  const parts = content
    .split(/\[NEXT\]|\n{2,}/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : [content]
}

const formatTime = (timestamp: string) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

const ChatPage = ({
  session,
  messages,
  onOpenDrawer,
  onSendMessage,
  onDeleteMessage,
  onRegenerate,
  isStreaming,
  onStopStreaming,
  enabledModels,
  defaultModel,
  onSelectModel,
  defaultReasoning,
  onSelectReasoning,
}: ChatPageProps) => {
  const [draft, setDraft] = useState('')
  const [openActionsId, setOpenActionsId] = useState<string | null>(null)
  const [actionsMenuPosition, setActionsMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [openHeaderMenu, setOpenHeaderMenu] = useState(false)
  const [headerMenuPosition, setHeaderMenuPosition] = useState({ top: 0, right: 0 })
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null)
  const [quoted, setQuoted] = useState<{ role: ChatMessage['role']; content: string } | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLElement | null>(null)
  const lastSessionIdRef = useRef<string | null>(null)
  const lastMessagesLengthRef = useRef(0)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressTargetRef = useRef<{ id: string; element: HTMLElement | null } | null>(null)
  const headerMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const actionTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const actionsMenuRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()

  const submitDraft = async () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }
    let payload = trimmed
    if (quoted) {
      const quoteBlock = quoted.content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      payload = `${quoteBlock}\n\n${trimmed}`
    }
    setQuoted(null)
    await onSendMessage(payload)
    setDraft('')
  }

  const handleQuote = (message: ChatMessage) => {
    setQuoted({ role: message.role, content: message.content })
    setOpenActionsId(null)
  }

  const handleRegenerate = (message: ChatMessage) => {
    setOpenActionsId(null)
    void onRegenerate(message.id)
  }

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressTargetRef.current = null
  }

  const startLongPress = (event: React.PointerEvent<HTMLDivElement>, messageId: string) => {
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
  }

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

  const actionsLabel = useMemo(() => {
    return openActionsId ? '关闭操作菜单' : '打开操作菜单'
  }, [openActionsId])

  const sessionOverride = session.overrideModel?.trim() || null
  const selectedModel = sessionOverride ?? defaultModel
  const hasOverride = Boolean(sessionOverride && sessionOverride !== defaultModel)
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

    const updateActionsMenuPosition = () => {
      const trigger = actionTriggerRefs.current[openActionsId]
      if (!trigger) {
        return
      }
      const rect = trigger.getBoundingClientRect()
      const menuWidth = 160
      const viewportPadding = 12
      const left = Math.min(
        Math.max(rect.right - menuWidth, viewportPadding),
        window.innerWidth - menuWidth - viewportPadding,
      )
      const top = Math.min(rect.bottom + 6, window.innerHeight - 96)
      setActionsMenuPosition({ top, left })
    }

    updateActionsMenuPosition()
    window.addEventListener('resize', updateActionsMenuPosition)
    window.addEventListener('scroll', updateActionsMenuPosition, true)

    return () => {
      window.removeEventListener('resize', updateActionsMenuPosition)
      window.removeEventListener('scroll', updateActionsMenuPosition, true)
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
      const trigger = actionTriggerRefs.current[openActionsId]
      if (trigger?.contains(event.target as Node)) {
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
          <h1 className="ui-title">{session.title}</h1>
          <span className="subtitle">单聊</span>
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
      <main className="chat-messages glass-panel" ref={messagesRef}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <p>暂无消息，开始聊点什么吧。</p>
          </div>
        ) : (
          messages.map((message) => {
            const reasoningText =
              message.meta?.reasoning_text?.trim() ?? message.meta?.reasoning?.trim()
            const chunks =
              message.role === 'assistant'
                ? splitAssistantContent(message.content)
                : [message.content]
            return (
              <div
                key={message.id}
                className={`message ${message.role === 'user' ? 'out' : 'in'}`}
              >
                {chunks.map((chunk, chunkIdx) => {
                  const isFirst = chunkIdx === 0
                  return (
                    <div
                      key={`${message.id}-${chunkIdx}`}
                      className={`bubble ${chunks.length > 1 ? 'bubble-stacked' : ''}`}
                      onPointerDown={(event) => startLongPress(event, message.id)}
                      onPointerUp={cancelLongPress}
                      onPointerLeave={cancelLongPress}
                      onPointerCancel={cancelLongPress}
                      onPointerMove={cancelLongPress}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        const rect = event.currentTarget.getBoundingClientRect()
                        setActionsMenuPosition({ top: rect.bottom + 4, left: rect.left })
                        setOpenActionsId(message.id)
                      }}
                    >
                      {isFirst && reasoningText ? (
                        <ReasoningPanel reasoning={reasoningText} />
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
              <div className="bubble-meta">
                <span className="timestamp">{formatTime(message.createdAt)}</span>
                <div className="message-actions">
                  <button
                    type="button"
                    className="ghost action-trigger"
                    aria-expanded={openActionsId === message.id}
                    aria-label={actionsLabel}
                    ref={(element) => {
                      actionTriggerRefs.current[message.id] = element
                    }}
                    onClick={() =>
                      setOpenActionsId((current) =>
                        current === message.id ? null : message.id,
                      )
                    }
                  >
                    •••
                  </button>
                </div>
              </div>
            </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </main>
      <form className="chat-composer glass-card" onSubmit={handleSubmit}>
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
          <label className="composer-toggle">
            <input
              type="checkbox"
              checked={reasoningEnabled}
              onChange={(event) => onSelectReasoning(event.target.checked)}
            />
            <span>思考链</span>
            <span className="toggle-hint">{reasoningHint}</span>
          </label>
        </div>
        <span className="model-hint">
          当前模型：{selectedModel}
          {hasOverride ? '（会话覆盖）' : '（默认）'}
        </span>
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
          <button type="submit" className="btn-primary">
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
