import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  EMOTIONS,
  getMood,
  getMoodEnabled,
  setMoodEnabled,
  decayMoodToNow,
  fetchMoodHistory,
  type MoodKey,
  type MoodState,
  type MoodHistoryRow,
} from '../storage/moodSystem'
import './MoodOverlay.css'

// 聊天页点开的小机情绪浮层：tone + 情绪条 + 「距满足」+ 没说出口的历史。
// 只读——小机的心你只能看。

// 和蓝色系搭：两蓝（痴靛 + 念天使蓝）+ 暖沙（贪）+ 柔玫（嗔），都压低饱和。
const MOOD_COLORS: Record<MoodKey, string> = {
  chi: '#8E86C8', tan: '#CDA37E', nian: '#789EC8', chen: '#D58A8A',
}
// 展示顺序：先痴（底色），再贪、念、嗔。
const ORDER: MoodKey[] = ['chi', 'tan', 'nian', 'chen']
const LABEL = new Map(EMOTIONS.map((e) => [e.key, e.label]))

const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

const snapshotLine = (h: MoodHistoryRow): string =>
  ORDER.map((k) => `${LABEL.get(k)}${Math.round((h as unknown as Record<string, number>)[k] ?? 0)}`).join(' · ')

type Props = {
  open: boolean
  onClose: () => void
  userId: string | null
}

const MoodOverlay = ({ open, onClose, userId }: Props) => {
  const [mood, setMood] = useState<MoodState | null>(null)
  const [history, setHistory] = useState<MoodHistoryRow[]>([])
  const [on, setOn] = useState(getMoodEnabled())

  useEffect(() => {
    if (!open) return
    setOn(getMoodEnabled())
    setMood(decayMoodToNow(getMood()))
    if (userId) void fetchMoodHistory(userId, 10).then(setHistory)
    // 打开期间每 20s 衰减刷新一下当前值。
    const id = window.setInterval(() => setMood(decayMoodToNow(getMood())), 20_000)
    return () => window.clearInterval(id)
  }, [open, userId])

  if (!open) return null

  const toggle = () => setOn((prev) => { const next = !prev; setMoodEnabled(next); return next })
  const daysSinceSatisfied = mood ? Math.max(0, (Date.now() - mood.lastSatisfiedAt) / 86_400_000) : 0

  const overlay = (
    <div className="mood-ov__backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mood-ov__card" onClick={(e) => e.stopPropagation()}>
        <div className="mood-ov__head">
          <span className="mood-ov__title">🐺 沈暮的心 · 只你看得见</span>
          <button type="button" className="mood-ov__close" aria-label="关闭" onClick={onClose}>×</button>
        </div>

        {on && mood ? (
          <>
            {mood.tone ? <p className="mood-ov__tone">「{mood.tone}」</p> : null}

            <div className="mood-ov__bars">
              {ORDER.map((k) => {
                const v = Math.round(mood[k])
                return (
                  <div className="mood-ov__row" key={k}>
                    <span className="mood-ov__label">{LABEL.get(k)}</span>
                    <span className="mood-ov__track">
                      <span className="mood-ov__fill" style={{ width: `${v}%`, background: MOOD_COLORS[k] }} />
                    </span>
                    <span className="mood-ov__num">{v}</span>
                  </div>
                )
              })}
            </div>

            <p className="mood-ov__satisfied">距上次满足 · {daysSinceSatisfied.toFixed(1)} 天</p>

            {history.length > 0 ? (
              <div className="mood-ov__history">
                <p className="mood-ov__hist-title">近 {history.length} 条 · 他没说出口的</p>
                {history.map((h, i) => (
                  <div className="mood-ov__hist-item" key={i}>
                    <p className="mood-ov__hist-meta">
                      <span className="mood-ov__hist-time">{timeAgo(h.createdAt)}</span>
                      {h.tone ? <span className="mood-ov__hist-tone">「{h.tone}」</span> : null}
                    </p>
                    {h.note ? <p className="mood-ov__hist-note">{h.note}</p> : null}
                    <p className="mood-ov__hist-snap">{snapshotLine(h)}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="mood-ov__off">情绪系统已关闭 — 打开后沈暮才会感知贪嗔痴念</p>
        )}

        <div className="mood-ov__footer">
          <span>情绪系统</span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`mood-ov__switch${on ? ' is-on' : ''}`}
            onClick={toggle}
          >
            <span className="mood-ov__switch-knob" />
          </button>
        </div>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return overlay
  return createPortal(overlay, document.body)
}

export default MoodOverlay
