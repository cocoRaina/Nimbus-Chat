import { memo, useRef, useState } from 'react'
import { isTtsReady } from '../storage/ttsConfig'
import { synthesizeSpeech } from '../storage/ttsClient'
import MarkdownRenderer from './MarkdownRenderer'
import './VoiceBubble.css'

// Rough duration estimate before the first play: Chinese ~4.5 chars/sec,
// latin words longer. Good enough for the "0:07" hint pre-load.
const estimateSeconds = (text: string): number => {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  const other = text.length - cjk
  return Math.max(1, Math.round(cjk / 4.5 + other / 12))
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

type Props = { text: string }

const VoiceBubble = memo(function VoiceBubble({ text }: Props) {
  const [showText, setShowText] = useState(false)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dur, setDur] = useState<number>(() => estimateSeconds(text))
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // TTS not set up → just show the text, no broken player.
  if (!isTtsReady()) {
    return <div className="voice-fallback"><MarkdownRenderer content={text} /></div>
  }

  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    let url: string
    setLoading(true)
    setError(null)
    try {
      url = await synthesizeSpeech(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : '合成失败')
      return null
    } finally {
      setLoading(false)
    }
    if (!audioRef.current) {
      const a = new Audio(url)
      a.onloadedmetadata = () => {
        if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration)
      }
      a.onended = () => setPlaying(false)
      a.onpause = () => setPlaying(false)
      audioRef.current = a
    }
    return audioRef.current
  }

  const toggle = async () => {
    const a = audioRef.current
    if (playing && a) {
      a.pause()
      setPlaying(false)
      return
    }
    const audio = await ensureAudio()
    if (!audio) return
    audio.currentTime = 0
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }

  return (
    <div className="voice-bubble-wrap">
      <button
        type="button"
        className={`voice-bar ${playing ? 'is-playing' : ''}`}
        onClick={() => void toggle()}
        aria-label={playing ? '暂停' : '播放语音'}
      >
        <span className="voice-bar__icon">{loading ? '…' : playing ? '⏸' : '▶'}</span>
        <span className="voice-bar__wave" aria-hidden="true">
          {Array.from({ length: 9 }).map((_, i) => (
            <i key={i} style={{ animationDelay: `${i * 0.09}s` }} />
          ))}
        </span>
        <span className="voice-bar__dur">{fmt(dur)}</span>
      </button>
      <button type="button" className="voice-bar__txt-toggle" onClick={() => setShowText((v) => !v)}>
        {showText ? '收起' : '转文字'}
      </button>
      {error ? <span className="voice-bar__err">{error}</span> : null}
      {showText ? (
        <div className="voice-bar__transcript"><MarkdownRenderer content={text} /></div>
      ) : null}
    </div>
  )
})

export default VoiceBubble
