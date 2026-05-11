/**
 * OneDrive provider for focus-planner using Microsoft Graph API + PKCE OAuth2.
 * Uses the special App Folder (Files.ReadWrite.AppFolder scope) —
 * sandboxed to /Apps/focus-planner/ with no broad file access needed.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

// Azure SPA app "Focus Planner" — registered 2026-05-05.
const CLIENT_ID = '4f22242f-c9a7-4a61-9208-8ca0e5ef8697'
const SCOPES = 'Files.ReadWrite.AppFolder offline_access'

// All files live directly under the app folder root
const APPROOT = `${GRAPH_BASE}/me/drive/special/approot`

export class OneDriveProvider {
  constructor() {
    this._token = null
    this._refreshToken = null
    this._expiresAt = null
    this._loadTokens()
  }

  folderName() { return 'OneDrive (App Folder)' }

  /** Called on user button click — initiates PKCE redirect */
  async pick() {
    await this._startPKCE()
    return null
  }

  /**
   * Called on app startup. If we have valid tokens → ready.
   * If URL has ?code= → complete token exchange.
   */
  async restore() {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error')

    if (error) {
      console.error('OneDrive OAuth error:', error)
      return null
    }

    if (code && state) {
      const ok = await this._exchangeCode(code, state)
      if (ok) {
        window.history.replaceState({}, '', window.location.pathname)
        return true
      }
      return null
    }

    if (this._isTokenValid()) return true
    if (this._refreshToken) {
      const ok = await this._refreshAccessToken()
      return ok ? true : null
    }
    return null
  }

  async scaffold() {
    const files = [
      ['focus-plan.md', `## Today\n\n| ID | 🎯 | Task | Priority | Added | Linked ID |\n|---|---|------|----------|-------|----------|\n\n## Deferred\n\n| ID | 🎯 | Task | Priority | Added | Linked ID |\n|---|---|------|----------|-------|----------|\n\n## Priorities\n\n`],
      ['focus-plan-completed.md', '# Completed Tasks\n'],
    ]
    for (const [name, content] of files) {
      const existing = await this.read(name)
      if (!existing) await this.write(name, content)
    }
  }

  async read(path) {
    await this._ensureToken()
    const url = `${APPROOT}:/${path}:/content`
    const res = await fetch(url, { headers: this._authHeader() })
    if (res.status === 404) return ''
    if (!res.ok) throw new Error(`OneDrive read failed: ${res.status}`)
    return res.text()
  }

  async write(path, content) {
    await this._ensureToken()
    // For subdirectory paths (e.g. journal/task-1.md), ensure the subdir exists
    const parts = path.split('/')
    if (parts.length > 1) {
      await this._ensureSubfolder(parts.slice(0, -1).join('/'))
    }
    const url = `${APPROOT}:/${path}:/content`
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...this._authHeader(), 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    })
    if (!res.ok) throw new Error(`OneDrive write failed: ${res.status}`)
  }

  async remove(path) {
    await this._ensureToken()
    const url = `${APPROOT}:/${path}`
    const res = await fetch(url, { method: 'DELETE', headers: this._authHeader() })
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`OneDrive delete failed: ${res.status}`)
    }
  }

  async getFiles() {
    await this._ensureToken()
    return this._listRecursive('')
  }

  async listFlat() {
    await this._ensureToken()
    return this._listFlatRecursive('')
  }

  async _listFlatRecursive(subPath, prefix = '') {
    const url = subPath
      ? `${APPROOT}:/${subPath}:/children?$select=name,lastModifiedDateTime,eTag,folder`
      : `${APPROOT}/children?$select=name,lastModifiedDateTime,eTag,folder`
    const res = await fetch(url, { headers: this._authHeader() })
    if (!res.ok) return []
    const data = await res.json()
    const entries = []
    for (const item of data.value ?? []) {
      const name = item.name
      const path = prefix ? `${prefix}/${name}` : name
      if (item.folder) {
        const children = await this._listFlatRecursive(subPath ? `${subPath}/${name}` : name, path)
        entries.push(...children)
      } else if (name.endsWith('.md')) {
        entries.push({ path, mtime: item.lastModifiedDateTime, etag: item.eTag })
      }
    }
    return entries
  }

  async checkJournal(taskId) {
    const path = `journal/task-${taskId}.md`
    const content = await this.read(path)
    if (!content) return { exists: false }
    return { exists: true, path }
  }

  async maxJournalId() {
    await this._ensureToken()
    try {
      const url = `${APPROOT}:/journal:/children`
      const res = await fetch(url, { headers: this._authHeader() })
      if (!res.ok) return 0
      const data = await res.json()
      let max = 0
      for (const item of data.value ?? []) {
        const m = item.name.match(/^task-(\d+)\.md$/)
        if (m) max = Math.max(max, parseInt(m[1], 10))
      }
      return max
    } catch { return 0 }
  }

  // ── Private helpers ──────────────────────────────────

  async _listRecursive(subPath, prefix = '') {
    const url = subPath
      ? `${APPROOT}:/${subPath}:/children`
      : `${APPROOT}/children`
    const res = await fetch(url, { headers: this._authHeader() })
    if (!res.ok) return []
    const data = await res.json()
    const items = []
    for (const item of data.value ?? []) {
      const name = item.name
      const path = prefix ? `${prefix}/${name}` : name
      if (item.folder) {
        const children = await this._listRecursive(subPath ? `${subPath}/${name}` : name, path)
        items.push({ name, type: 'directory', path, children })
      } else if (name.endsWith('.md')) {
        items.push({ name, type: 'file', path })
      }
    }
    return items
  }

  async _ensureSubfolder(subPath) {
    const parts = subPath.split('/')
    let current = ''
    for (const part of parts) {
      const parentUrl = current
        ? `${APPROOT}:/${current}:/children`
        : `${APPROOT}/children`
      current = current ? `${current}/${part}` : part
      const checkUrl = `${APPROOT}:/${current}`
      const res = await fetch(checkUrl, { headers: this._authHeader() })
      if (res.status === 404) {
        await fetch(parentUrl, {
          method: 'POST',
          headers: { ...this._authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
        })
      }
    }
  }

  async _startPKCE() {
    const verifier = _randomBase64(32)
    const challenge = await _sha256Base64url(verifier)
    const state = _randomBase64(16)
    sessionStorage.setItem('onedrive_verifier', verifier)
    sessionStorage.setItem('onedrive_state', state)
    sessionStorage.setItem('onedrive_pending', '1')

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: _redirectUri(),
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    window.location.href = `${AUTH_ENDPOINT}?${params}`
  }

  async _exchangeCode(code, state) {
    const storedState = sessionStorage.getItem('onedrive_state')
    const verifier = sessionStorage.getItem('onedrive_verifier')
    if (!verifier || storedState !== state) return false

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: _redirectUri(),
      code_verifier: verifier,
    })
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return false
    const data = await res.json()
    this._saveTokens(data)
    sessionStorage.removeItem('onedrive_verifier')
    sessionStorage.removeItem('onedrive_state')
    sessionStorage.removeItem('onedrive_pending')
    return true
  }

  async _refreshAccessToken() {
    if (!this._refreshToken) return false
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: this._refreshToken,
      scope: SCOPES,
    })
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) { this._clearTokens(); return false }
    this._saveTokens(await res.json())
    return true
  }

  /**
   * True if the provider cannot read/write because tokens are missing or expired
   * and refresh failed. Call `pick()` to re-authenticate.
   */
  needsAuth() {
    return !this._isTokenValid() && !this._refreshToken
  }

  async _ensureToken() {
    if (this._isTokenValid()) return
    if (this._refreshToken) {
      const ok = await this._refreshAccessToken()
      if (ok) return
    }
    // Do NOT redirect automatically here — throw so callers can handle gracefully.
    // The user must explicitly click "Re-connect" (which calls pick()) to re-auth.
    throw new Error('OneDrive authentication required. Please re-connect in Settings.')
  }

  _isTokenValid() {
    return !!(this._token && this._expiresAt && Date.now() < this._expiresAt)
  }

  _authHeader() {
    return { Authorization: `Bearer ${this._token}` }
  }

  _saveTokens(data) {
    this._token = data.access_token
    if (data.refresh_token) this._refreshToken = data.refresh_token
    this._expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000
    localStorage.setItem('od_token', this._token)
    localStorage.setItem('od_refresh', this._refreshToken ?? '')
    localStorage.setItem('od_expires', String(this._expiresAt))
  }

  _loadTokens() {
    this._token = localStorage.getItem('od_token') || null
    this._refreshToken = localStorage.getItem('od_refresh') || null
    const exp = localStorage.getItem('od_expires')
    this._expiresAt = exp ? parseInt(exp, 10) : null
  }

  _clearTokens() {
    this._token = null; this._refreshToken = null; this._expiresAt = null
    localStorage.removeItem('od_token')
    localStorage.removeItem('od_refresh')
    localStorage.removeItem('od_expires')
  }

  /** Remove all persisted credentials so re-adding requires a fresh OAuth flow. */
  async forget() {
    this._clearTokens()
  }
}

function _redirectUri() {
  return `${window.location.origin}${window.location.pathname}`
}

function _randomBase64(bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function _sha256Base64url(str) {
  const data = new TextEncoder().encode(str)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
