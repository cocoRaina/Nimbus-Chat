import { useRef, useState } from 'react'
import './VoiceRecordBubble.css'

// Fallback: deterministic waveform seeded by URL (used when no real amplitude data)
function makeWaveBars(seed: string, count = 22): number[] {
  let h = 0
  return Array.from({ length: count }, (_, i) => {
    const code = seed.charCodeAt(i % seed.length) || 50
    h = ((h * 31 + code + i * 13) % 60) + 18
    return h
  })
}

// Map real amplitude samples (0-100) to bar height percentages (18-90)
function realWaveBars(samples: number[]): number[] {
  return samples.map((v) => Math.round(18 + (v / 100) * 72))
}

export type VoiceRecordBubbleProps = {
  url: string
  duration?: number    // ms
  transcription?: string
  emotion?: string
  waveform?: number[]  // real amplitude data captured during recording (22 values, 0-100)
}

export default function VoiceRecordBubble({ url, duration, transcription, waveform }: VoiceRecordBubbleProps) {
  const [playing, setPlaying] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const bars = waveform ? realWaveBars(waveform) : makeWaveBars(url)

  const durationSec = duration ? Math.round(duration / 1000) : null

  const togglePlay = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(url)
      audioRef.current.onended = () => setPlaying(false)
      audioRef.current.onerror = () => setPlaying(false)
    }
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
    } else {
      void audioRef.current.play()
      setPlaying(true)
    }
  }

  return (
    <div className="vrb">
      <button className="vrb-play" onClick={togglePlay} aria-label={playing ? '暂停' : '播放录音'}>
        <span aria-hidden="true">{playing ? '⏸' : '▶'}</span>
      </button>
      <div className="vrb-waveform" aria-hidden="true">
        {bars.map((h, i) => (
          <div
            key={i}
            className={`vrb-bar${playing ? ' vrb-bar--playing' : ''}`}
            style={{ height: `${h}%`, animationDelay: `${(i * 0.06).toFixed(2)}s` }}
          />
        ))}
      </div>
      <div className="vrb-info">
        {durationSec !== null && <span className="vrb-duration">{durationSec}″</span>}
        {transcription && (
          <button
            className="vrb-transcript-btn"
            onClick={() => setShowTranscript((v) => !v)}
            aria-label={showTranscript ? '隐藏文字' : '转文字'}
          >
            {showTranscript ? '收起' : '转文字'}
          </button>
        )}
      </div>
      {showTranscript && transcription && <p className="vrb-transcript">{transcription}</p>}
    </div>
  )
}
