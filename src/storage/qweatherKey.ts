const KEY_PREFIX = 'nimbus_qweather_v2_'

export type QWeatherCredential = {
  privateKeyPem: string  // Ed25519 private key PEM from console "API KEY" field
  credentialId: string   // 凭据ID (kid in JWT header)
  projectId: string      // 项目ID (sub in JWT payload)
}

const load = (): QWeatherCredential | null => {
  if (typeof window === 'undefined') return null
  const pem = window.localStorage.getItem(KEY_PREFIX + 'pem') ?? ''
  if (!pem) return null
  const kid = window.localStorage.getItem(KEY_PREFIX + 'kid') ?? ''
  const sub = window.localStorage.getItem(KEY_PREFIX + 'sub') ?? ''
  return { privateKeyPem: pem, credentialId: kid, projectId: sub }
}

// Returns true if the stored key is a plain hex API key (not an Ed25519 PEM).
// Plain hex keys use ?key= URL param auth; PEM keys use JWT Bearer auth.
export const isHexApiKey = (s: string): boolean =>
  /^[0-9a-fA-F]+$/.test(s.trim()) && s.trim().length <= 64

export const getQWeatherCredential = (): QWeatherCredential | null => load()

export const hasQWeatherCredential = (): boolean => load() !== null

export const saveQWeatherCredential = (c: QWeatherCredential) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY_PREFIX + 'pem', c.privateKeyPem.trim())
  window.localStorage.setItem(KEY_PREFIX + 'kid', c.credentialId.trim())
  window.localStorage.setItem(KEY_PREFIX + 'sub', c.projectId.trim())
}

export const clearQWeatherCredential = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY_PREFIX + 'pem')
  window.localStorage.removeItem(KEY_PREFIX + 'kid')
  window.localStorage.removeItem(KEY_PREFIX + 'sub')
  // also clear old v1 key if present
  window.localStorage.removeItem('nimbus_qweather_key_v1')
}

// Generate a short-lived Ed25519 JWT for QWeather API calls.
// Uses @noble/ed25519 (pure JS) for Android WebView compatibility —
// WebCrypto Ed25519 is only available in Chrome 113+; older WebViews throw NotSupportedError.
export const generateQWeatherJWT = async (c: QWeatherCredential): Promise<string> => {
  const { sign } = await import('@noble/ed25519')

  // Strip any PEM header/footer (handles BEGIN PRIVATE KEY, BEGIN OPENSSH PRIVATE KEY, etc.)
  const b64 = c.privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')
  const der = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))

  // Extract Ed25519 seed from PKCS8 DER:
  // Scan for OCTET STRING tag (0x04) with length 0x20 (32), take the 32 bytes following.
  // Standard PKCS8 Ed25519 (48 bytes): bytes 14-15 are "04 20", seed at bytes 16-47.
  let seed: Uint8Array | null = null
  for (let i = 0; i <= der.length - 34; i++) {
    if (der[i] === 0x04 && der[i + 1] === 0x20) {
      seed = der.slice(i + 2, i + 34)
      break
    }
  }
  // Fallback: if decoded bytes are exactly 32, assume raw seed (no PKCS8 wrapper).
  if (!seed && der.length === 32) seed = der

  if (!seed) {
    throw new Error(
      `私钥格式错误：解码后 ${der.length} 字节，找不到 32 字节 Ed25519 seed。` +
      `请粘贴完整 PEM 文件内容（含 -----BEGIN PRIVATE KEY----- 头尾行）。`
    )
  }

  const b64url = (source: Uint8Array | string): string => {
    const encoded = typeof source === 'string'
      ? btoa(unescape(encodeURIComponent(source)))
      : btoa(String.fromCharCode(...source))
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: c.credentialId }))
  const payload = b64url(JSON.stringify({ sub: c.projectId, iat: now, exp: now + 300 }))
  const message = `${header}.${payload}`
  const sig = await sign(new TextEncoder().encode(message), seed)
  return `${message}.${b64url(sig)}`
}
