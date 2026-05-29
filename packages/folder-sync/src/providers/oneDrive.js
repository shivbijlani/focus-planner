// OneDrive provider — Microsoft Graph + PKCE OAuth, AppFolder scope.
//
// Two halves:
//  - `oneDriveProvider({clientId, ...})` is called on the *main thread* to produce
//    a provider config descriptor. The descriptor is serialisable (no closures)
//    so it can be sent to the service worker via postMessage.
//  - HTTP helpers (getRemote/putRemote/listRemote/refresh) are pure functions
//    that work in both main and SW contexts.

import { generateCodeVerifier, generateCodeChallenge, generateState } from '../auth/pkce.js'
import { getTokens, setTokens, clearTokens, isExpired } from '../auth/tokenStore.js'

const PROVIDER_ID = 'onedrive'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const SCOPES = 'Files.ReadWrite.AppFolder offline_access'
const APPROOT = `${GRAPH_BASE}/me/drive/special/approot`

/** Public factory called by consumers on the main thread. */
export function oneDriveProvider({ clientId }) {
  return {
    id: PROVIDER_ID,
    displayName: 'OneDrive',
    clientId,
    scopes: SCOPES,
    authEndpoint: AUTH_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,

    // Main-thread OAuth helpers
    startAuth: (redirectUri) => startAuth(clientId, redirectUri),
    completeAuth: (params, redirectUri) => completeAuth(clientId, params, redirectUri),

    // Isomorphic HTTP helpers used by the SW
    listRemote,
    readRemote,
    writeRemote,
    deleteRemote,
    refresh: (refreshToken) => refresh(clientId, refreshToken),
  }
}

// ---- OAuth (main thread) ----

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
  })
  window.location.href = `${AUTH_ENDPOINT}?${params}`
}

async function completeAuth(clientId, params, redirectUri) {
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return false

  const storedState = sessionStorage.getItem(`${PROVIDER_ID}_state`)
  const codeVerifier = sessionStorage.getItem(`${PROVIDER_ID}_code_verifier`)
  if (!storedState || storedState !== state) throw new Error('OneDrive: invalid OAuth state')
  if (!codeVerifier) throw new Error('OneDrive: missing PKCE verifier')

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
  if (!res.ok) throw new Error(`OneDrive token exchange failed: ${res.status}`)
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

// ---- Token refresh (isomorphic) ----

async function refresh(clientId, refreshToken) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
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

// ---- HTTP (isomorphic) ----

async function listRemote(providerConfig) {
  const token = await ensureToken(providerConfig)
  const res = await fetch(`${APPROOT}/children?$select=name,lastModifiedDateTime,file`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`OneDrive list failed: ${res.status}`)
  const data = await res.json()
  return data.value.filter(i => i.file).map(i => ({
    name: i.name,
    mtime: new Date(i.lastModifiedDateTime).getTime(),
  }))
}

async function readRemote(providerConfig, filename) {
  const token = await ensureToken(providerConfig)
  const res = await fetch(`${APPROOT}:/${encodeURIComponent(filename)}:/content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`OneDrive read failed: ${res.status}`)
  return await res.text()
}

async function writeRemote(providerConfig, filename, contents) {
  const token = await ensureToken(providerConfig)
  const res = await fetch(`${APPROOT}:/${encodeURIComponent(filename)}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: contents,
  })
  if (!res.ok) throw new Error(`OneDrive write failed: ${res.status}`)
  const data = await res.json()
  return { mtime: new Date(data.lastModifiedDateTime).getTime() }
}

async function deleteRemote(providerConfig, filename) {
  const token = await ensureToken(providerConfig)
  const res = await fetch(`${APPROOT}:/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`OneDrive delete failed: ${res.status}`)
  }
}
