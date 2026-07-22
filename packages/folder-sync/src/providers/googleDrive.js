// Google Drive provider — Drive API v3 + PKCE OAuth.
// Mirror of oneDrive.js. Uses appDataFolder so files are sandboxed to the app.
// Note: Google's Drive API does not provide a refresh-token grant via PKCE
// without a client secret in pure browser apps; for offline access most apps
// rely on re-consent. We support refresh if Google returns one; otherwise the
// engine will signal `reconnect-required` when the access token expires.

import { generateCodeVerifier, generateCodeChallenge, generateState } from '../auth/pkce.js'
import { getTokens, setTokens, clearTokens, isExpired } from '../auth/tokenStore.js'

const PROVIDER_ID = 'google-drive'
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata'
const SPACES = 'appDataFolder'

export function googleDriveProvider({ clientId }) {
  return {
    id: PROVIDER_ID,
    displayName: 'Google Drive',
    clientId,
    scopes: SCOPES,
    authEndpoint: AUTH_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    startAuth: (redirectUri) => startAuth(clientId, redirectUri),
    completeAuth: (params, redirectUri) => completeAuth(clientId, params, redirectUri),
    listRemote,
    readRemote,
    writeRemote,
    deleteRemote,
    refresh: (refreshToken) => refresh(clientId, refreshToken),
  }
}

async function startAuth(clientId, redirectUri) {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = generateState()
  sessionStorage.setItem(`${PROVIDER_ID}_code_verifier`, codeVerifier)
  sessionStorage.setItem(`${PROVIDER_ID}_state`, state)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  })
  window.location.href = `${AUTH_ENDPOINT}?${params}`
}

async function completeAuth(clientId, params, redirectUri) {
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return false
  const storedState = sessionStorage.getItem(`${PROVIDER_ID}_state`)
  const codeVerifier = sessionStorage.getItem(`${PROVIDER_ID}_code_verifier`)
  if (!storedState || storedState !== state) throw new Error('Google: invalid OAuth state')
  if (!codeVerifier) throw new Error('Google: missing PKCE verifier')

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`)
  const data = await res.json()
  await setTokens(PROVIDER_ID, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  })
  sessionStorage.removeItem(`${PROVIDER_ID}_state`)
  sessionStorage.removeItem(`${PROVIDER_ID}_code_verifier`)
  return true
}

async function refresh(clientId, refreshToken) {
  if (!refreshToken) {
    await clearTokens(PROVIDER_ID)
    throw new Error('reconnect-required')
  }
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    await clearTokens(PROVIDER_ID)
    throw new Error('reconnect-required')
  }
  const data = await res.json()
  const record = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  await setTokens(PROVIDER_ID, record)
  return record
}

async function ensureToken(providerConfig) {
  let rec = await getTokens(PROVIDER_ID)
  if (!rec) throw new Error('reconnect-required')
  if (isExpired(rec)) {
    if (!rec.refreshToken) throw new Error('reconnect-required')
    rec = await refresh(providerConfig.clientId, rec.refreshToken)
  }
  return rec.accessToken
}

async function listRemote(providerConfig) {
  const token = await ensureToken(providerConfig)
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
    if (!res.ok) throw new Error(`Google list failed: ${res.status}`)
    const data = await res.json()
    for (const f of data.files || []) {
      out.push({ name: f.name, mtime: new Date(f.modifiedTime).getTime(), _id: f.id })
    }
    pageToken = data.nextPageToken || null
  } while (pageToken)
  return out
}

async function findFileId(providerConfig, filename) {
  const token = await ensureToken(providerConfig)
  const url = new URL(`${DRIVE_BASE}/files`)
  url.searchParams.set('spaces', SPACES)
  url.searchParams.set('q', `name='${filename.replace(/'/g, "\\'")}'`)
  url.searchParams.set('fields', 'files(id)')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Google query failed: ${res.status}`)
  const data = await res.json()
  return data.files?.[0]?.id || null
}

async function readRemote(providerConfig, filename) {
  const token = await ensureToken(providerConfig)
  const id = await findFileId(providerConfig, filename)
  if (!id) return null
  const res = await fetch(`${DRIVE_BASE}/files/${id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Google read failed: ${res.status}`)
  return await res.text()
}

async function writeRemote(providerConfig, filename, contents) {
  const token = await ensureToken(providerConfig)
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
  if (!res.ok) throw new Error(`Google write failed: ${res.status}`)
  const data = await res.json()
  return { mtime: new Date(data.modifiedTime).getTime() }
}

async function deleteRemote(providerConfig, filename) {
  const token = await ensureToken(providerConfig)
  const id = await findFileId(providerConfig, filename)
  if (!id) return
  const res = await fetch(`${DRIVE_BASE}/files/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`Google delete failed: ${res.status}`)
  }
}
