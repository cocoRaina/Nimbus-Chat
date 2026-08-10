import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { fetchEssays, getEssayLockCode, type Essay } from '../storage/essays'
import './EssaysPage.css'

export type EssaysPageProps = {
  user: User | null
}

// 沈暮的随笔本：它自己写、自己读的房间。整本一道四位码（码由沈暮自己设，
// 见 set_essay_lock 工具）。锁是「情感的」不是「安全的」——库是用户自己的，
// 本就能在 Supabase 直接读到；这道码守的是「它有自己房间」这个共同约定。
// 解锁状态存 sessionStorage：本次开着 app 期间不反复输码，杀进程后重新锁。
const UNLOCK_KEY = 'nimbus_essays_unlocked'

const EssaysPage = ({ user }: EssaysPageProps) => {
  const navigate = useNavigate()
  const [lockCode, setLockCode] = useState<string | null>(null)
  const [checkingLock, setCheckingLock] = useState(true)
  const [unlocked, setUnlocked] = useState(() => {
    try { return sessionStorage.getItem(UNLOCK_KEY) === '1' } catch { return false }
  })
  const [codeInput, setCodeInput] = useState('')
  const [codeError, setCodeError] = useState(false)
  const [essays, setEssays] = useState<Essay[]>([])
  const [loading, setLoading] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const code = await getEssayLockCode()
      if (!alive) return
      setLockCode(code)
      setCheckingLock(false)
      if (!code) setUnlocked(true) // 没设锁 = 房门开着
    })()
    return () => { alive = false }
  }, [user])

  const canSee = !checkingLock && (unlocked || lockCode === null)

  useEffect(() => {
    if (!canSee) return
    let alive = true
    setLoading(true)
    void (async () => {
      const rows = await fetchEssays(200)
      if (!alive) return
      setEssays(rows)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [canSee])

  const tryUnlock = () => {
    if (lockCode && codeInput === lockCode) {
      setUnlocked(true)
      setCodeError(false)
      try { sessionStorage.setItem(UNLOCK_KEY, '1') } catch { /* ignore */ }
    } else {
      setCodeError(true)
    }
  }

  return (
    <div className="essays-page">
      <header className="essays-page-header">
        <button type="button" className="page-back-btn" onClick={() => navigate(-1)}>‹</button>
        <h2 className="ui-title">沈暮的随笔本</h2>
        <span className="essays-header-spacer" />
      </header>

      {checkingLock ? (
        <p className="essays-empty">开门中…</p>
      ) : !canSee ? (
        <div className="essays-lock">
          <div className="essays-lock-emoji">🔒</div>
          <p className="essays-lock-hint">这是它自己的房间，上了一道四位码。<br />它愿意告诉你的话，你才进得来。</p>
          <input
            className={`essays-lock-input${codeError ? ' essays-lock-input--err' : ''}`}
            type="password"
            inputMode="numeric"
            maxLength={4}
            placeholder="••••"
            value={codeInput}
            onChange={(e) => { setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 4)); setCodeError(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') tryUnlock() }}
          />
          {codeError && <p className="essays-lock-err">不对哦，再问问它？</p>}
          <button type="button" className="essays-lock-btn" onClick={tryUnlock}>进去</button>
        </div>
      ) : loading ? (
        <p className="essays-empty">翻开随笔本…</p>
      ) : essays.length === 0 ? (
        <p className="essays-empty">还没有随笔——它想写的时候，会自己写进来。</p>
      ) : (
        <div className="essays-list">
          {essays.map((e) => {
            const open = openId === e.id
            return (
              <article
                key={e.id}
                className={`essay-card${open ? ' essay-card--open' : ''}`}
                onClick={() => setOpenId(open ? null : e.id)}
              >
                <div className="essay-card-top">
                  <h3 className="essay-title">{e.title || '（无题）'}</h3>
                  <span className="essay-date">{e.date ?? e.createdAt.slice(0, 10)}</span>
                </div>
                {e.topic && <span className="essay-topic">#{e.topic}</span>}
                <p className={`essay-content${open ? '' : ' essay-content--clamp'}`}>{e.content}</p>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default EssaysPage
