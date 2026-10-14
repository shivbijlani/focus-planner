import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Google's token endpoint rejects this app's "Web application" OAuth client
// without a client_secret ("client_secret is missing."), even with PKCE, so the
// auth-code flow could never complete on the static site. The provider uses
// the token model instead: no token endpoint, no refresh token, and a silent
// `prompt=none` redirect to renew.

const store = new Map()
vi.mock('../auth/tokenStore.js', () => ({
  getTokens: vi.fn(async (id) => store.get(id) || null),
  setTokens: vi.fn(async (id, rec) => { store.set(id, { ...rec, providerId: id }) }),
  clearTokens: vi.fn(async (id) => { store.delete(id) }),
  isExpired: (rec, skewMs = 60_000) => !rec?.expiresAt || Date.now() >= rec.expiresAt - skewMs,
}))

const { buildAuthUrl, completeAuth, googleDriveProvider } = await import('./googleDrive.js')

const CLIENT_ID = 'client.apps.googleusercontent.com'
const REDIRECT = 'https://plannermd.com/'

function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('sessionStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('buildAuthUrl', () => {
  it('requests a browser-safe token grant, never an auth code', () => {
    const url = new URL(buildAuthUrl(CLIENT_ID, REDIRECT, { state: 's1' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = url.searchParams
    expect(p.get('response_type')).toBe('token')
    expect(p.get('redirect_uri')).toBe(REDIRECT)
    expect(p.get('scope')).toBe('https://www.googleapis.com/auth/drive.appdata')
    expect(p.get('state')).toBe('s1')
    expect(p.has('code_challenge')).toBe(false)
    expect(p.has('access_type')).toBe(false)
    expect(p.has('prompt')).toBe(false)
  })

  it('renews silently with prompt=none and the remembered account', () => {
    const p = new URL(buildAuthUrl(CLIENT_ID, REDIRECT, { state: 's', silent: true, loginHint: 'me@example.com' })).searchParams
    expect(p.get('prompt')).toBe('none')
    expect(p.get('login_hint')).toBe('me@example.com')
  })
})

describe('completeAuth', () => {
  it('ignores a response whose state is not ours', async () => {
    sessionStorage.setItem('google-drive_state', 'mine')
    const ok = await completeAuth(new URLSearchParams('access_token=t&state=other'))
    expect(ok).toBe(false)
    expect(store.size).toBe(0)
  })

  it('stores the fragment access token with its expiry and account email', async () => {
    sessionStorage.setItem('google-drive_state', 'st')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ user: { emailAddress: 'me@example.com' } }) })))
    const before = Date.now()
    const ok = await completeAuth(new URLSearchParams('access_token=tok&token_type=Bearer&expires_in=3599&state=st'))
    expect(ok).toBe(true)
    const rec = store.get('google-drive')
    expect(rec.accessToken).toBe('tok')
    expect(rec.refreshToken).toBeNull()
    expect(rec.expiresAt).toBeGreaterThanOrEqual(before + 3599_000)
    expect(rec.meta).toEqual({ email: 'me@example.com' })
    expect(sessionStorage.getItem('google-drive_state')).toBeNull()
  })

  it('surfaces a failed (e.g. silent) sign-in as an error and clears the state', async () => {
    sessionStorage.setItem('google-drive_state', 'st')
    await expect(completeAuth(new URLSearchParams('error=interaction_required&state=st')))
      .rejects.toThrow('interaction_required')
    expect(sessionStorage.getItem('google-drive_state')).toBeNull()
    expect(store.size).toBe(0)
  })
})

describe('token expiry', () => {
  it('reports reconnect-required for an expired token without calling Google', async () => {
    store.set('google-drive', { accessToken: 'old', refreshToken: null, expiresAt: Date.now() - 1 })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const p = googleDriveProvider({ clientId: CLIENT_ID })
    await expect(p.listRemote(p)).rejects.toThrow('reconnect-required')
    expect(fetchMock).not.toHaveBeenCalled()
    // The record is kept so the connection stays intended and the hint survives.
    expect(store.has('google-drive')).toBe(true)
  })

  it('treats a 401 from Drive as reconnect-required', async () => {
    store.set('google-drive', { accessToken: 'tok', expiresAt: Date.now() + 3600_000 })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    const p = googleDriveProvider({ clientId: CLIENT_ID })
    await expect(p.listRemote(p)).rejects.toThrow('reconnect-required')
  })

  it('never has a refresh-token grant to fall back on', async () => {
    const p = googleDriveProvider({ clientId: CLIENT_ID })
    expect(p.supportsSilentAuth).toBe(true)
    await expect(p.refresh('anything')).rejects.toThrow('reconnect-required')
  })
})
