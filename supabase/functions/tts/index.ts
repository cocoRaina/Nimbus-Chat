import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { encodeBase64 } from 'jsr:@std/encoding/base64'
import { createClient } from 'jsr:@supabase/supabase-js@2'

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

  // JWT 校验，和其他 edge function 对齐：虽然 MiniMax key 由客户端自带、
  // 不烧服务端钱，但开放代理仍应只对已登录用户开放。
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization')
  const apikey = req.headers.get('apikey')
  if (!supabaseUrl || !supabaseAnonKey) return json({ error: 'Supabase env vars not configured' }, 500)
  if (!authHeader || !apikey) return json({ error: 'missing auth headers' }, 401)
  {
    const sb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader, apikey } },
    })
    const { data: { user }, error: userError } = await sb.auth.getUser()
    if (userError || !user) return json({ error: 'invalid auth token' }, 401)
  }

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
    const msg = data?.base_resp?.status_msg ?? ''
    // Return 200 even on failure so supabase.functions.invoke surfaces the
    // real reason (it collapses any non-2xx into a generic message otherwise).
    if (!res.ok || !data) {
      return json({ error: `MiniMax ${res.status}${msg ? ': ' + msg : ''}`, detail: data?.base_resp ?? null })
    }
    const hex = data.data?.audio
    if (!hex) {
      return json({ error: `MiniMax 无音频${msg ? ': ' + msg : ''}`, detail: data.base_resp ?? null })
    }
    // MiniMax returns audio as a hex string → bytes → base64 for the client.
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return json({ audio_base64: encodeBase64(bytes), mime: 'audio/mp3' })
  } catch (err) {
    return json({ error: String(err) })
  }
})
