// Google Drive provider — Drive API v3, OAuth 2.0 token model (implicit grant).
// Mirror of oneDrive.js. Uses appDataFolder so files are sandboxed to the app.
//
// Why the token model and not auth-code + PKCE: Google's token endpoint
// rejects a "Web application" client without its client_secret, even with
// PKCE ("invalid_request: client_secret is missing."), and this app is a
// static site with no backend to hold a secret. Google's browser-safe option
// is the token model: the access token (≈1h) comes back in the redirect URL
// fragment and there is no refresh token. When it expires the SW reports
// `reconnect-required` and the engine renews it with a silent redirect
// (`prompt=none`), which returns immediately while the user is still signed
// in to Google and has already granted consent.

import { generateState } from '../auth/pkce.js'
import { getTokens, setTokens, isExpired } from '../auth/tokenStore.js'

const PROVIDER_ID = 'google-drive'
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata'
const SPACES = 'appDataFolder'
const STATE_KEY = `${PROVIDER_ID}_state`

export function googleDriveProvider({ clientId }) {
  return {
    id: PROVIDER_ID,
    displayName: 'Google Drive',
    clientId,
    scopes: SCOPES,
    authEndpoint: AUTH_ENDPOINT,
    supportsSilentAuth: true,
    startAuth: (redirectUri, opts) => startAuth(clientId, redirectUri, opts),
    completeAuth: (params) => completeAuth(params),
    listRemote,
    readRemote,
    writeRemote,
    deleteRemote,
    refresh: () => refresh(),
  }
}

export function buildAuthUrl(clientId, redirectUri, { state, silent = false, loginHint } = {}) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    include_granted_scopes: 'true',
  })
  if (silent) params.set('prompt', 'none')
  if (loginHint) params.set('login_hint', loginHint)
  return `${AUTH_ENDPOINT}?${params}`
}

async function startAuth(clientId, redirectUri, { silent = false } = {}) {
  const state = generateState()
  sessionStorage.setItem(STATE_KEY, state)
  let loginHint
  try { loginHint = (await getTokens(PROVIDER_ID))?.meta?.email } catch { /* ignore */ }
  window.location.href = buildAuthUrl(clientId, redirectUri, { state, silent, loginHint })
}

// `params` holds the redirect's query + fragment parameters. Returns true when
// this provider consumed a token, false when the response is not ours.
export async function completeAuth(params) {
  const state = params.get('state')
  const storedState = sessionStorage.getItem(STATE_KEY)
  if (!state || !storedState || state !== storedState) return false
  sessionStorage.removeItem(STATE_KEY)

  const error = params.get('error')
  if (error) throw new Error(`Google sign-in failed: ${error}`)
  const accessToken = params.get('access_token')
  if (!accessToken) throw new Error('Google sign-in returned no access token')

  const expiresIn = Number(params.get('expires_in')) || 3600
  const prev = await getTokens(PROVIDER_ID).catch(() => null)
  const email = (await fetchEmail(accessToken)) || prev?.meta?.email
  await setTokens(PROVIDER_ID, {
    accessToken,
    refreshToken: null,
    expiresAt: Date.now() + expiresIn * 1000,
    meta: email ? { email } : undefined,
  })
  return true
}

// Best-effort account email, used as `login_hint` so silent renewal picks the
// right account when several Google accounts are signed in.
async function fetchEmail(accessToken) {
  try {
    const res = await fetch(`${DRIVE_BASE}/about?fields=user(emailAddress)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    return (await res.json())?.user?.emailAddress || null
  } catch { return null }
}

// The token model issues no refresh token; renewal is a (silent) redirect
// driven by the engine. Keep the stored record so the connection is still
// recognised as intended and the account hint survives.
async function refresh() {
  throw new Error('reconnect-required')
}

async function ensureToken() {
  const rec = await getTokens(PROVIDER_ID)
  if (!rec || !rec.accessToken || isExpired(rec)) throw new Error('reconnect-required')
  return rec.accessToken
}

// A 401 means Google revoked or expired the token early; treat it like expiry.
function authError(res, what) {
  if (res.status === 401) return new Error('reconnect-required')
  return new Error(`Google ${what} failed: ${res.status}`)
}

async function listRemote() {
  const token = await ensureToken()
  // Google Drive paginates `files.list`: each response carries at most
  // `pageSize` files plus a `nextPageToken` for the next page. Reading only the
  // first page silently dropped everything past the first 1000 files (the same
  // class of bug that hid OneDrive journals past page 1), so follow the token.
  const out = []
  let pageToken = null
  do {
    const url = new URL(`${DRIVE_BASE}/files`)
    url.searchParams.set('spaces', SPACES)
    url.searchParams.set('fields', 'nextPageToken,files(id,name,modifiedTime)')
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw authError(res, 'list')
    const data = await res.json()
    for (const f of data.files || []) {
      out.push({ name: f.name, mtime: new Date(f.modifiedTime).getTime(), _id: f.id })
    }
    pageToken = data.nextPageToken || null
  } while (pageToken)
  return out
}

async function findFileId(providerConfig, filename) {
  const token = await ensureToken()
  const url = new URL(`${DRIVE_BASE}/files`)
  url.searchParams.set('spaces', SPACES)
  url.searchParams.set('q', `name='${filename.replace(/'/g, "\\'")}'`)
  url.searchParams.set('fields', 'files(id)')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw authError(res, 'query')
  const data = await res.json()
  return data.files?.[0]?.id || null
}

async function readRemote(providerConfig, filename) {
  const token = await ensureToken()
  const id = await findFileId(providerConfig, filename)
  if (!id) return null
  const res = await fetch(`${DRIVE_BASE}/files/${id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw authError(res, 'read')
  return await res.text()
}

async function writeRemote(providerConfig, filename, contents) {
  const token = await ensureToken()
  const existingId = await findFileId(providerConfig, filename)
  const boundary = 'fs-' + Math.random().toString(36).slice(2)
  const metadata = existingId
    ? { name: filename }
    : { name: filename, parents: [SPACES] }
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: text/plain\r\n\r\n' +
    contents +
    `\r\n--${boundary}--`

  const url = existingId
    ? `${UPLOAD_BASE}/files/${existingId}?uploadType=multipart&fields=id,modifiedTime`
    : `${UPLOAD_BASE}/files?uploadType=multipart&fields=id,modifiedTime`
  const res = await fetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })
  if (!res.ok) throw authError(res, 'write')
  const data = await res.json()
  return { mtime: new Date(data.modifiedTime).getTime() }
}

async function deleteRemote(providerConfig, filename) {
  const token = await ensureToken()
  const id = await findFileId(providerConfig, filename)
  if (!id) return
  const res = await fetch(`${DRIVE_BASE}/files/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 204 && res.status !== 404) {
    throw authError(res, 'delete')
  }
}
