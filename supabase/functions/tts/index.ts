import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { encodeBase64 } from 'jsr:@std/encoding/base64'

// MiniMax T2A v2 proxy. The client (settings page) sends the MiniMax api_key
// + group_id + voice_id with each request — we never store the key server-side
// or in the repo. This function exists to (a) dodge the WebView CORS wall and
// (b) decode MiniMax's hex audio into something the client can play directly.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  let p: {
    text?: string; voice_id?: string; api_key?: string; group_id?: string
    base_url?: string; model?: string; speed?: number
  }
  try { p = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }

  const text = (p.text ?? '').toString().trim()
  const apiKey = (p.api_key ?? '').toString().trim()
  const voiceId = (p.voice_id ?? '').toString().trim()
  const groupId = (p.group_id ?? '').toString().trim()
  const baseUrl = ((p.base_url ?? 'https://api.minimax.io').toString().trim()).replace(/\/+$/, '')
  const model = (p.model ?? 'speech-02-turbo').toString().trim()
  const speed = typeof p.speed === 'number' && p.speed > 0 ? p.speed : 1.0
  if (!text) return json({ error: 'text required' }, 400)
  if (!apiKey || !voiceId) return json({ error: 'api_key and voice_id required' }, 400)

  const url = groupId
    ? `${baseUrl}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`
    : `${baseUrl}/v1/t2a_v2`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        voice_setting: { voice_id: voiceId, speed, vol: 1.0, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
    })
    const data = await res.json().catch(() => null) as
      | { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string } }
      | null
    if (!res.ok || !data) {
      return json({ error: `minimax ${res.status}`, detail: data?.base_resp ?? null }, 502)
    }
    const hex = data.data?.audio
    if (!hex) {
      return json({ error: 'no audio', detail: data.base_resp ?? null }, 502)
    }
    // MiniMax returns audio as a hex string → bytes → base64 for the client.
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return json({ audio_base64: encodeBase64(bytes), mime: 'audio/mp3' })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})
