import { memo, useRef, useState } from 'react'
import { supabase } from '../supabase/client'
import { getTtsConfig, isTtsReady } from '../storage/ttsConfig'
import MarkdownRenderer from './MarkdownRenderer'
import './VoiceBubble.css'

// Module-level cache: text → object URL, so replaying (or re-rendering) a
// voice bar doesn't re-synthesize (= re-bill MiniMax).
const audioCache = new Map<string, string>()

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
    let url = audioCache.get(text)
    if (!url) {
      if (!supabase) return null
      setLoading(true)
      setError(null)
      try {
        const cfg = getTtsConfig()
        const { data, error: err } = await supabase.functions.invoke('tts', {
          body: {
            text,
            voice_id: cfg.voiceId,
            api_key: cfg.apiKey,
            group_id: cfg.groupId,
            base_url: cfg.baseUrl,
            model: cfg.model,
          },
        })
        if (err) throw new Error(err.message ?? String(err))
        const b64 = (data as { audio_base64?: string; error?: string })?.audio_base64
        if (!b64) throw new Error((data as { error?: string })?.error ?? '合成失败')
        const blob = await (await fetch(`data:audio/mp3;base64,${b64}`)).blob()
        url = URL.createObjectURL(blob)
        audioCache.set(text, url)
      } catch (e) {
        setError(e instanceof Error ? e.message : '合成失败')
        return null
      } finally {
        setLoading(false)
      }
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
