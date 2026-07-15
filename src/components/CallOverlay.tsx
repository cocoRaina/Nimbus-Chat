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
    options: { attachments?: MessageAttachment[]; voiceEmotion?: string; tones?: string[] },
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
      const em = /（语气：([^）]{1,24})）\s*$/.exec(text)
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
  // 半流式播报状态：不再等整段生成完，写完一句就念一句。
  const spokenCharsRef = useRef<Map<string, number>>(new Map()) // 每条消息已入队播报的（清洗后）字符数
  const hangupDoneRef = useRef<Set<string>>(new Set())          // 挂断意图已处理的消息
  const abandonedRef = useRef<Set<string>>(new Set())           // 被打断、剩余不再念的消息
  const speakingKeyRef = useRef<string | null>(null)            // 当前在念哪条
  const speakCountRef = useRef(0)                               // 队列里还没念完的段数（驱动"对方说话中"）
  const speakChainRef = useRef<Promise<void>>(Promise.resolve())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lingerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recStartRef = useRef(0)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 语调检测（轻声/停顿多/语速慢）：录音时按帧采 RMS——
  //   轻声   = 有声帧平均 norm < 22 → TA 播报降 0.5×，标签带「轻声」
  //   停顿多 = 有声时长占比 < 45%（≥3s 的话才算，短句不评）
  //   语速慢 = 转写字数 ÷ 有声秒数 < 2.8（≥2s 有声才算）
  const voicedSumRef = useRef(0)
  const voicedCntRef = useRef(0)
  const voicedMsRef = useRef(0)
  const totalMsRef = useRef(0)
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

  // ---- 通话阶段：半流式播报 TA 的回复 ----
  // 不等整段生成完：这个 effect 在每次流式增量（messages 变化）时跑，把"已
  // 经写完的整句"排进播报队列，写完第一句就开口，后面几句边生成边接上。
  const bumpSpeaking = (delta: number) => {
    speakCountRef.current = Math.max(0, speakCountRef.current + delta)
    setSpeaking(speakCountRef.current > 0)
  }
  // 把一段（≥1 个完整句子）排进播报链：合成 + 播放，播时预取下一块。
  const enqueueSpeech = (key: string, text: string) => {
    const clean = text.trim()
    if (!clean) return
    speakingKeyRef.current = key
    bumpSpeaking(1)
    speakChainRef.current = speakChainRef.current.then(async () => {
      if (endedRef.current || interruptRef.current || abandonedRef.current.has(key)) { bumpSpeaking(-1); return }
      setSpeakError(null)
      try {
        const chunks = chunkForSpeech(clean)
        let pending: Promise<string> | null = synthesizeSpeech(chunks[0])
        for (let i = 0; i < chunks.length; i++) {
          if (endedRef.current || interruptRef.current || abandonedRef.current.has(key)) break
          const url = await (pending as Promise<string>)
          pending = i + 1 < chunks.length ? synthesizeSpeech(chunks[i + 1]) : null
          if (endedRef.current || interruptRef.current || abandonedRef.current.has(key)) break
          await new Promise<void>((resolve) => {
            const a = new Audio(url)
            a.volume = softModeRef.current ? 0.5 : 1
            audioRef.current = a
            a.onended = () => resolve()
            a.onpause = () => resolve() // barge-in
            a.onerror = () => resolve()
            void a.play().catch(() => resolve())
          })
        }
      } catch (e) {
        setSpeakError(e instanceof Error ? e.message : '语音合成失败')
      }
      bumpSpeaking(-1)
    })
  }

  useEffect(() => {
    if (phase !== 'active') return
    // 找到本通话内最后一条 assistant 消息（正在流式或刚完成的那条）
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      const created = new Date(m.clientCreatedAt ?? m.createdAt).getTime()
      if (created < startedAt) continue
      const key = m.clientId ?? m.id
      if (abandonedRef.current.has(key)) continue
      const done = !(m.meta?.streaming || m.pending)
      // 第一次见到这条（新回合）→ 复位打断标记，让它能开口
      if (!spokenCharsRef.current.has(key)) {
        spokenCharsRef.current.set(key, 0)
        interruptRef.current = false
      }
      const sanitized = sanitizeForSpeech(m.content)
      const already = spokenCharsRef.current.get(key) ?? 0
      const pendingText = already <= sanitized.length ? sanitized.slice(already) : ''
      // 取到"最后一个完整句子结束"为止；没写完的半句先等（除非整条已完成）
      let ready = ''
      if (done) {
        ready = pendingText
      } else {
        const re = /[。！？!?…]|\.(?=\s|$)|\n/g
        let idx = -1
        let mm: RegExpExecArray | null
        while ((mm = re.exec(pendingText)) !== null) idx = mm.index + mm[0].length
        ready = idx > 0 ? pendingText.slice(0, idx) : ''
      }
      if (ready.trim()) {
        spokenCharsRef.current.set(key, already + ready.length)
        enqueueSpeech(key, ready)
      }
      // 整条完成后处理挂断意图（排在所有语音之后，播完再倒计时）
      if (done && !hangupDoneRef.current.has(key)) {
        hangupDoneRef.current.add(key)
        spokenCharsRef.current.set(key, sanitized.length)
        const content = m.content
        speakChainRef.current = speakChainRef.current.then(async () => {
          if (endedRef.current || interruptRef.current || abandonedRef.current.has(key)) return
          if (hasHangupMarker(content)) {
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
    }
  }, [phase, messages, startedAt])

  useEffect(() => () => { clearLinger(); stopPlayback() }, [clearLinger, stopPlayback])

  // ---- 按住说话 ----
  const startRec = useCallback(async () => {
    if (recState !== 'idle' || phase !== 'active') return
    clearLinger() // 开口 = 留住 TA
    interruptRef.current = true // 剩余分块不再播（barge-in）
    if (speakingKeyRef.current) abandonedRef.current.add(speakingKeyRef.current) // 这条剩余的句子也别念了
    speakCountRef.current = 0
    setSpeaking(false)
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
      voicedMsRef.current = 0
      totalMsRef.current = 0
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
          totalMsRef.current += 200
          if (norm >= 10) {
            voicedSumRef.current += norm
            voicedCntRef.current += 1
            voicedMsRef.current += 200
          }
        }
      }, 200)
    } catch { /* 无权限/无麦克风 */ }
  }, [recState, phase, clearLinger, stopPlayback])

  // 录音 blob → 上传 → 转写（带情绪）→ 发送为通话轮次。PTT 和 VAD 共用。
  // stats 来自录音期间的 RMS 采样，转写完成后合成语调标签。
  const sendRecordingBlob = useCallback(async (
    blob: Blob,
    durationMs: number,
    mimeType: string,
    stats: { voicedAvg: number; voicedMs: number; totalMs: number },
  ) => {
    const soft = stats.voicedAvg < 22
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
      const tones: string[] = []
      if (soft) tones.push('轻声')
      const effTotal = Math.max(stats.voicedMs, stats.totalMs)
      if (effTotal >= 3000 && stats.voicedMs / effTotal < 0.45) tones.push('停顿多')
      const chars = (text.match(/[一-鿿a-zA-Z0-9]/g) ?? []).length
      if (chars > 0 && stats.voicedMs >= 2000 && chars / (stats.voicedMs / 1000) < 2.8) tones.push('语速慢')
      await onSendVoiceTurn(text || '[语音消息]', {
        attachments: [{
          type: 'voice' as const,
          url,
          duration: durationMs,
          transcription: text || undefined,
          emotion: emotion ?? undefined,
        }],
        ...(emotion ? { voiceEmotion: emotion } : {}),
        ...(tones.length ? { tones } : {}),
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
    const stats = {
      voicedAvg: voicedCntRef.current > 0 ? voicedSumRef.current / voicedCntRef.current : 99,
      voicedMs: voicedMsRef.current,
      totalMs: totalMsRef.current,
    }
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
      void sendRecordingBlob(blob, durationMs, mimeType, stats)
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
      const stats = {
        voicedAvg: voicedCntRef.current > 0 ? voicedSumRef.current / voicedCntRef.current : 99,
        voicedMs: voicedMsRef.current,
        // 免提靠 1.2s 尾部静默判停，这段不该算成「停顿」
        totalMs: Math.max(voicedMsRef.current, totalMsRef.current - 900),
      }
      rec.onstop = () => {
        const durationMs = Date.now() - startAt
        const mimeType = rec.mimeType || 'audio/webm'
        const blob = new Blob(chunks, { type: mimeType })
        chunks = []
        if (!send || cancelled || !blob.size || durationMs < 500) {
          setRecState('idle')
          return
        }
        void sendRecordingBlob(blob, durationMs, mimeType, stats)
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
          if (speakingKeyRef.current) abandonedRef.current.add(speakingKeyRef.current)
          speakCountRef.current = 0
          setSpeaking(false)
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
          voicedMsRef.current = 0
          totalMsRef.current = 0
          mr.start(200)
          setRecState('recording')
          setRecMs(0)
          recTimerRef.current = setInterval(() => setRecMs(Date.now() - startAt), 200)
        } else {
          totalMsRef.current += 100
          if (norm >= 10) {
            lastVoiceAt = Date.now()
            voicedSumRef.current += norm
            voicedCntRef.current += 1
            voicedMsRef.current += 100
          }
          // 停顿 0.9s 就当说完、自动发（原 1.2s）——更跟手、更像真通话
          if (Date.now() - lastVoiceAt > 900 || Date.now() - startAt > 60_000) stopRecorder(true)
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
