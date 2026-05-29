// Shared OAuth helpers (PKCE).
// Used by providers on the main thread to build auth URLs and exchange codes.

export function generateCodeVerifier() {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return base64UrlEncode(arr)
}

export async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}

export function generateState() {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return base64UrlEncode(arr).replace(/[^a-zA-Z0-9]/g, '').slice(0, 22)
}

export function base64UrlEncode(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
