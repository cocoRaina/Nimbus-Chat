import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage, MessageAttachment } from '../types'
import {
  chunkForSpeech,
  getHandsFree,
  hasHangupMarker,
  isCallEventMessage,
  sanitizeForSpeech,
  setHandsFree,
  startRingtone,
  stopRingtone,
} from '../storage/callConfig'
import { synthesizeSpeech } from '../storage/ttsClient'
import './CallOverlay.css'

// 📞 全屏通话层（callhome）。两个阶段：
//   ringing — TA 主动拨号：铃声 + 接听/拒接（可带理由），90s 无人接 → 未接
//   active  — 通话中：按住说话（录音→转写→发送），TA 的回复自动 TTS 播报；
//             回复带 [hangup] 时播完开「停留窗口」，倒计时内开口就留住 TA
// 轮次制通话：不是全双工流式，但契合 Nimbus 的无常驻服务端架构。

const RING_TIMEOUT_MS = 90_000
const LINGER_SECONDS = 18
const DECLINE_CHIPS = ['现在不方便', '在忙，晚点打给你', '想打字聊']

type Props = {
  phase: 'ringing' | 'active'
  reason?: string
  startedAt: number
  assistantName: string
  assistantAvatar?: string | null
  userId: string | null
  messages: ChatMessage[]
  isStreaming: boolean
  onAccept: () => void
  onDecline: (reason: string | null) => void
  onMissed: () => void
  onEnd: (durationMs: number, endedBy: 'user' | 'assistant') => void
  onSendVoiceTurn: (
    text: string,
    options: { attachments?: MessageAttachment[]; voiceEmotion?: string; soft?: boolean },
  ) => Promise<void>
}

const fmtClock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// 装饰波形线（callhome ui-concept 的那根线）：20 个正弦波周期，svg 宽 200%，
// 平移一半自身宽度 = 整数个周期，无缝循环滚动；说话/收音时提速提亮。
const WAVE_D = 'M0 12 ' + 'q6 -9 12 0 q6 9 12 0 '.repeat(20)

// 通话页的实时字幕行（callhome ui-concept 的样子）：
//   me  — 你说的话的转写（带语气小标签）
//   ta  — TA 的回复文字（流式时也实时长出来）
//   sys — 系统小字（接通提示等）
type CallLine = { key: string; who: 'me' | 'ta' | 'sys'; text: string; emotion?: string }

const buildCallLines = (messages: ChatMessage[], startedAt: number): CallLine[] => {
  const lines: CallLine[] = []
  for (const m of messages) {
    const created = new Date(m.clientCreatedAt ?? m.createdAt).getTime()
    if (created < startedAt) continue
    const key = m.clientId ?? m.id
    if (m.role === 'user') {
      if (isCallEventMessage(m.content)) {
        // 事件行原文是写给模型看的，字幕里换成人话
        if (m.content.startsWith('📞 已接通')) lines.push({ key, who: 'sys', text: '接通了 · 直接说话就行' })
        continue
      }
      if (!m.content.startsWith('[通话中]')) continue
      let text = m.content.replace(/^\[通话中\]\s*/, '')
      let emotion: string | undefined
      const em = /（语气：([^）]{1,8})）\s*$/.exec(text)
      if (em) { emotion = em[1]; text = text.slice(0, em.index) }
      if (text.trim()) {
        lines.push({ key, who: 'me', text: text.trim(), emotion })
        // 轻声说话 → 插一条系统小字（TA 的播报音量也真的降了）
        if (emotion?.includes('轻声')) lines.push({ key: `${key}-soft`, who: 'sys', text: '轻声模式 · TA 也放低了声音' })
      }
    } else {
      const text = sanitizeForSpeech(m.content)
      if (text) lines.push({ key, who: 'ta', text })
    }
  }
  return lines
}

const CallOverlay = ({
  phase,
  reason,
  startedAt,
  assistantName,
  assistantAvatar,
  userId,
  messages,
  isStreaming,
  onAccept,
  onDecline,
  onMissed,
  onEnd,
  onSendVoiceTurn,
}: Props) => {
  const [now, setNow] = useState(() => Date.now())
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [speakError, setSpeakError] = useState<string | null>(null)
  const [lingerLeft, setLingerLeft] = useState<number | null>(null)
  const [recState, setRecState] = useState<'idle' | 'recording' | 'sending'>('idle')
  const [recMs, setRecMs] = useState(0)
  const [showDecline, setShowDecline] = useState(false)
  const [declineDraft, setDeclineDraft] = useState('')
  // 免提（VAD）：开着就常听，检测到说话自动录、停顿 1.2s 自动发
  const [handsFree, setHandsFreeState] = useState(() => getHandsFree())

  const endedRef = useRef(false)
  const spokenRef = useRef<Set<string>>(new Set())
  const speakChainRef = useRef<Promise<void>>(Promise.resolve())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lingerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recStartRef = useRef(0)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 轻声检测：整句有声帧的平均 RMS 低于阈值 → 轻声（TA 播报降到 0.5×，
  // 语气标签带上「轻声」让 TA 也压低声音回）
  const voicedSumRef = useRef(0)
  const voicedCntRef = useRef(0)
  const softModeRef = useRef(false)
  const pttAudioCtxRef = useRef<AudioContext | null>(null)
  const pttAnalyserRef = useRef<AnalyserNode | null>(null)
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd
  const onMissedRef = useRef(onMissed)
  onMissedRef.current = onMissed
  const interruptRef = useRef(false)
  // VAD 采样闭包里要读最新状态，用 ref 镜像（interval 每 100ms 一拍，
  // 不能吃陈旧闭包）
  const recStateRef = useRef(recState)
  recStateRef.current = recState
  const speakingRef = useRef(speaking)
  speakingRef.current = speaking

  // 秒针：响铃页显示「响铃中」，通话页显示时长
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => () => { endedRef.current = true }, [])

  const stopPlayback = useCallback(() => {
    const a = audioRef.current
    if (a) { a.pause(); audioRef.current = null }
  }, [])

  const clearLinger = useCallback(() => {
    if (lingerTimerRef.current) { clearInterval(lingerTimerRef.current); lingerTimerRef.current = null }
    setLingerLeft(null)
  }, [])

  // ---- 响铃阶段：铃声 + 90s 超时 → 未接 ----
  // 依赖只有 phase：回调经 ref 取最新值，父组件重渲染不会重置铃声/定时器。
  useEffect(() => {
    if (phase !== 'ringing') return
    startRingtone()
    const t = setTimeout(() => onMissedRef.current(), RING_TIMEOUT_MS)
    return () => { stopRingtone(); clearTimeout(t) }
  }, [phase])

  // ---- 通话阶段：自动播报 TA 的新回复 ----
  useEffect(() => {
    if (phase !== 'active') return
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      if (m.meta?.streaming || m.pending) continue
      if (!m.content.trim()) continue
      const created = new Date(m.clientCreatedAt ?? m.createdAt).getTime()
      if (created < startedAt) continue
      const key = m.clientId ?? m.id
      if (spokenRef.current.has(key)) continue
      spokenRef.current.add(key)
      const content = m.content
      speakChainRef.current = speakChainRef.current.then(async () => {
        if (endedRef.current) return
        interruptRef.current = false
        const text = sanitizeForSpeech(content)
        if (text) {
          setSpeaking(true)
          setSpeakError(null)
          try {
            // 首块合成完立刻播，播的同时预取下一块（缩短句间空档）
            const chunks = chunkForSpeech(text)
            let pending: Promise<string> | null = synthesizeSpeech(chunks[0])
            for (let i = 0; i < chunks.length; i++) {
              if (endedRef.current || interruptRef.current) break
              const url = await (pending as Promise<string>)
              pending = i + 1 < chunks.length ? synthesizeSpeech(chunks[i + 1]) : null
              if (endedRef.current || interruptRef.current) break
              await new Promise<void>((resolve) => {
                const a = new Audio(url)
                a.volume = softModeRef.current ? 0.5 : 1
                audioRef.current = a
                a.onended = () => resolve()
                a.onpause = () => resolve() // 用户按住说话打断（barge-in）
                a.onerror = () => resolve()
                void a.play().catch(() => resolve())
              })
            }
          } catch (e) {
            setSpeakError(e instanceof Error ? e.message : '语音合成失败')
          }
          setSpeaking(false)
        }
        // 播完这条后 TA 想挂 → 停留窗口倒计时，开口即留住。用户中途按住
        // 说话（interrupt）说明还想聊，这条的挂断意图作废。
        if (!endedRef.current && !interruptRef.current && hasHangupMarker(content)) {
          setLingerLeft(LINGER_SECONDS)
          if (lingerTimerRef.current) clearInterval(lingerTimerRef.current)
          lingerTimerRef.current = setInterval(() => {
            setLingerLeft((left) => {
              if (left === null) return null
              if (left <= 1) {
                if (lingerTimerRef.current) { clearInterval(lingerTimerRef.current); lingerTimerRef.current = null }
                if (!endedRef.current) {
                  endedRef.current = true
                  onEndRef.current(Date.now() - startedAt, 'assistant')
                }
                return null
              }
              return left - 1
            })
          }, 1000)
        }
      })
    }
  }, [phase, messages, startedAt])

  useEffect(() => () => { clearLinger(); stopPlayback() }, [clearLinger, stopPlayback])

  // ---- 按住说话 ----
  const startRec = useCallback(async () => {
    if (recState !== 'idle' || phase !== 'active') return
    clearLinger() // 开口 = 留住 TA
    interruptRef.current = true // 剩余分块不再播（barge-in）
    stopPlayback() // 打断正在播的话
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const { getBestMimeType } = await import('../storage/voiceRecorder')
      const mr = new MediaRecorder(stream, { mimeType: getBestMimeType() })
      recChunksRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) recChunksRef.current.push(e.data) }
      mediaRecorderRef.current = mr
      recStartRef.current = Date.now()
      mr.start(200)
      voicedSumRef.current = 0
      voicedCntRef.current = 0
      try {
        const ctx = new AudioContext()
        pttAudioCtxRef.current = ctx
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        ctx.createMediaStreamSource(stream).connect(analyser)
        pttAnalyserRef.current = analyser
      } catch { /* 采不到就当正常音量 */ }
      setRecState('recording')
      setRecMs(0)
      recTimerRef.current = setInterval(() => {
        setRecMs(Date.now() - recStartRef.current)
        const an = pttAnalyserRef.current
        if (an) {
          const data = new Uint8Array(an.frequencyBinCount)
          an.getByteTimeDomainData(data)
          const rms = Math.sqrt(data.reduce((sum, v) => sum + (v - 128) ** 2, 0) / data.length)
          const norm = Math.min(100, rms * 2.2)
          if (norm >= 10) { voicedSumRef.current += norm; voicedCntRef.current += 1 }
        }
      }, 200)
    } catch { /* 无权限/无麦克风 */ }
  }, [recState, phase, clearLinger, stopPlayback])

  // 录音 blob → 上传 → 转写（带情绪）→ 发送为通话轮次。PTT 和 VAD 共用。
  const sendRecordingBlob = useCallback(async (blob: Blob, durationMs: number, mimeType: string, soft: boolean) => {
    softModeRef.current = soft
    setRecState('sending')
    try {
      const { uploadVoiceRecording, transcribeVoice } = await import('../storage/voiceRecorder')
      if (!userId) throw new Error('未登录')
      const { url } = await uploadVoiceRecording({ blob, durationMs, mimeType }, userId)
      let text = ''
      let emotion: string | null = null
      try {
        const t = await transcribeVoice(url)
        text = t.text
        emotion = t.emotion
      } catch (err) {
        console.warn('通话转写失败，按语音消息发送', err)
      }
      await onSendVoiceTurn(text || '[语音消息]', {
        attachments: [{
          type: 'voice' as const,
          url,
          duration: durationMs,
          transcription: text || undefined,
          emotion: emotion ?? undefined,
        }],
        ...(emotion ? { voiceEmotion: emotion } : {}),
        ...(soft ? { soft: true } : {}),
      })
    } catch (err) {
      console.error('通话语音发送失败', err)
      setSpeakError('这句没发出去，再试一次')
    } finally {
      setRecState('idle')
    }
  }, [userId, onSendVoiceTurn])

  const finishRec = useCallback((send: boolean) => {
    const mr = mediaRecorderRef.current
    if (!mr || recState !== 'recording') return
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
    void pttAudioCtxRef.current?.close().catch(() => {})
    pttAudioCtxRef.current = null
    pttAnalyserRef.current = null
    const voicedAvg = voicedCntRef.current > 0 ? voicedSumRef.current / voicedCntRef.current : 99
    const soft = voicedAvg < 22
    mr.onstop = () => {
      const durationMs = Date.now() - recStartRef.current
      mr.stream.getTracks().forEach((t) => t.stop())
      const mimeType = mr.mimeType || 'audio/webm'
      const blob = new Blob(recChunksRef.current, { type: mimeType })
      mediaRecorderRef.current = null
      recChunksRef.current = []
      if (!send || !blob.size || durationMs < 500) {
        setRecState('idle')
        return
      }
      void sendRecordingBlob(blob, durationMs, mimeType, soft)
    }
    mr.stop()
  }, [recState, sendRecordingBlob])

  // ---- 免提（VAD 自动收音）----
  // 常驻一条 mic 流（echoCancellation 抑制外放回声），每 100ms 采一次 RMS：
  //   空闲 → 音量连续 2 拍（200ms）过说话阈值 → 开录。TA 播报时用更高的
  //          barge-in 阈值，免得残余回声/环境音把 TA 的话打断。
  //   录音中 → 低于保持阈值持续 1.2s（或录满 60s）→ 停录发送；<500ms 丢弃。
  // 阈值与聊天页波形同一标定（rms*2.2 → 0-100）。
  useEffect(() => {
    if (phase !== 'active' || !handsFree) return
    let cancelled = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let mr: MediaRecorder | null = null
    let chunks: Blob[] = []
    let voiceRun = 0
    let lastVoiceAt = 0
    let startAt = 0

    const stopRecorder = (send: boolean) => {
      const rec = mr
      mr = null
      if (!rec) return
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
      const voicedAvg = voicedCntRef.current > 0 ? voicedSumRef.current / voicedCntRef.current : 99
      const soft = voicedAvg < 22
      rec.onstop = () => {
        const durationMs = Date.now() - startAt
        const mimeType = rec.mimeType || 'audio/webm'
        const blob = new Blob(chunks, { type: mimeType })
        chunks = []
        if (!send || cancelled || !blob.size || durationMs < 500) {
          setRecState('idle')
          return
        }
        void sendRecordingBlob(blob, durationMs, mimeType, soft)
      }
      rec.stop()
    }

    const setup = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        })
      } catch {
        setSpeakError('免提需要麦克风权限')
        setHandsFreeState(false)
        setHandsFree(false)
        return
      }
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
      const { getBestMimeType } = await import('../storage/voiceRecorder')
      const mimeType = getBestMimeType()
      try {
        ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        src.connect(analyser)
      } catch {
        setSpeakError('这台设备不支持免提检测，已切回按住说话')
        setHandsFreeState(false)
        setHandsFree(false)
        stream.getTracks().forEach((t) => t.stop())
        stream = null
        return
      }
      const data = new Uint8Array(analyser.frequencyBinCount)
      timer = setInterval(() => {
        if (cancelled || !analyser || !stream) return
        analyser.getByteTimeDomainData(data)
        const rms = Math.sqrt(data.reduce((s, v) => s + (v - 128) ** 2, 0) / data.length)
        const norm = Math.min(100, rms * 2.2)
        if (!mr) {
          if (recStateRef.current === 'sending') { voiceRun = 0; return }
          const startThreshold = speakingRef.current ? 30 : 16
          voiceRun = norm >= startThreshold ? voiceRun + 1 : 0
          if (voiceRun < 2) return
          voiceRun = 0
          clearLinger() // 开口 = 留住 TA
          interruptRef.current = true
          stopPlayback()
          try {
            mr = new MediaRecorder(stream, { mimeType })
          } catch { return }
          chunks = []
          mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
          startAt = Date.now()
          lastVoiceAt = startAt
          voicedSumRef.current = 0
          voicedCntRef.current = 0
          mr.start(200)
          setRecState('recording')
          setRecMs(0)
          recTimerRef.current = setInterval(() => setRecMs(Date.now() - startAt), 200)
        } else {
          if (norm >= 10) {
            lastVoiceAt = Date.now()
            voicedSumRef.current += norm
            voicedCntRef.current += 1
          }
          if (Date.now() - lastVoiceAt > 1200 || Date.now() - startAt > 60_000) stopRecorder(true)
        }
      }, 100)
    }
    void setup()
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      stopRecorder(false)
      if (ctx) void ctx.close().catch(() => {})
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [phase, handsFree, sendRecordingBlob, clearLinger, stopPlayback])

  const handleEndByUser = useCallback(() => {
    if (endedRef.current) return
    endedRef.current = true
    clearLinger()
    stopPlayback()
    onEnd(Date.now() - startedAt, 'user')
  }, [clearLinger, stopPlayback, onEnd, startedAt])

  // 实时字幕：通话内消息（含流式中的 TA 回复）渲染在通话页上
  const callLines = phase === 'active' ? buildCallLines(messages, startedAt) : []

  // 新字幕/流式增量时贴底滚动
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const statusLine = phase === 'ringing'
    ? '来电响铃中…'
    : recState === 'recording'
      ? `${handsFree ? '在听你说' : '松开发送'} · ${fmtClock(recMs)}`
      : recState === 'sending'
        ? '正在送过去…'
        : speaking
          ? '对方说话中…'
          : isStreaming
            ? '对方在想…'
            : fmtClock(now - startedAt)

  return createPortal(
    <div className="call-overlay" role="dialog" aria-label="语音通话">
      <div className="call-overlay__body">
        {assistantAvatar ? (
          <img className={`call-avatar ${phase === 'ringing' ? 'is-ringing' : ''} ${speaking ? 'is-speaking' : ''}`} src={assistantAvatar} alt={assistantName} />
        ) : (
          <div className={`call-avatar call-avatar--placeholder ${phase === 'ringing' ? 'is-ringing' : ''} ${speaking ? 'is-speaking' : ''}`}>📞</div>
        )}
        <h2 className="call-name">{assistantName}</h2>
        <p className="call-status" aria-live="polite">{statusLine}</p>
        <div className={`call-wave ${speaking || recState === 'recording' ? 'is-live' : ''}`} aria-hidden="true">
          <svg viewBox="0 0 480 24" preserveAspectRatio="none"><path d={WAVE_D} /></svg>
        </div>
        {phase === 'ringing' && reason ? <p className="call-reason">「{reason}」</p> : null}
        {lingerLeft !== null ? (
          <p className="call-linger">TA 想挂了…开口说话可以留住 TA（{lingerLeft}s）</p>
        ) : null}
        {speakError ? <p className="call-error">{speakError}</p> : null}
      </div>

      {phase === 'active' ? (
        <div className="call-transcript" ref={transcriptRef}>
          {callLines.map((line) =>
            line.who === 'sys' ? (
              <p key={line.key} className="call-line-sys">{line.text}</p>
            ) : (
              <div key={line.key} className={`call-line ${line.who === 'me' ? 'is-me' : 'is-ta'}`}>
                {line.text}
                {line.emotion ? <span className="call-line-emo">{line.emotion}</span> : null}
              </div>
            ),
          )}
        </div>
      ) : null}

      {phase === 'ringing' ? (
        showDecline ? (
          <div className="call-decline-panel">
            <p className="call-decline-title">跟 TA 说一声？</p>
            {DECLINE_CHIPS.map((chip) => (
              <button key={chip} type="button" className="call-decline-chip" onClick={() => onDecline(chip)}>
                {chip}
              </button>
            ))}
            <div className="call-decline-custom">
              <input
                type="text"
                value={declineDraft}
                maxLength={60}
                placeholder="或者自己说一句…"
                onChange={(e) => setDeclineDraft(e.target.value)}
              />
              <button
                type="button"
                disabled={!declineDraft.trim()}
                onClick={() => onDecline(declineDraft.trim())}
              >
                发送
              </button>
            </div>
            <button type="button" className="call-decline-silent" onClick={() => onDecline(null)}>
              直接挂断
            </button>
          </div>
        ) : (
          <div className="call-actions">
            <button type="button" className="call-btn call-btn--decline" aria-label="拒接" onClick={() => setShowDecline(true)}>
              ✕
            </button>
            <button type="button" className="call-btn call-btn--accept" aria-label="接听" onClick={onAccept}>
              📞
            </button>
          </div>
        )
      ) : (
        <div className="call-actions call-actions--active">
          <button type="button" className="call-btn call-btn--decline" aria-label="挂断" onClick={handleEndByUser}>
            ✕
          </button>
          {handsFree ? (
            <div className={`call-vad-pill ${recState === 'recording' ? 'is-recording' : ''}`} aria-live="polite">
              {recState === 'recording'
                ? `在听你说… ${fmtClock(recMs)}`
                : recState === 'sending'
                  ? '正在送过去…'
                  : '🎙 免提听着呢，直接说'}
            </div>
          ) : (
            <button
              type="button"
              className={`call-talk-btn ${recState === 'recording' ? 'is-recording' : ''}`}
              disabled={recState === 'sending'}
              onPointerDown={(e) => { e.preventDefault(); void startRec() }}
              onPointerUp={() => finishRec(true)}
              onPointerCancel={() => finishRec(false)}
              onContextMenu={(e) => e.preventDefault()}
            >
              {recState === 'recording' ? '松开 发送' : recState === 'sending' ? '…' : '按住 说话'}
            </button>
          )}
          <button
            type="button"
            className="call-btn call-btn--mode"
            aria-label={handsFree ? '切回按住说话' : '切到免提'}
            title={handsFree ? '切回按住说话' : '免提：说完自动发送'}
            onClick={() => {
              const v = !handsFree
              setHandsFreeState(v)
              setHandsFree(v)
            }}
          >
            {handsFree ? '✋' : '🎙'}
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}

export default CallOverlay
