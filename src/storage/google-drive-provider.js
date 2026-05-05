/**
 * Google Drive provider for focus-planner using Drive API v3 + PKCE OAuth2.
 * Files stored in appDataFolder (private to this app) OR in a named folder.
 * We use a named folder "focus-planner" for easy user visibility.
 */
import { parseTodos } from './fsa.js'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

// Google OAuth2 SPA app — partial setup completed:
//   ✓ Google Cloud project created: focus-planner-495417
//   ✓ Google Drive API enabled
//   ✓ OAuth consent screen: App name "focus-planner", support email shiv@bijlanis.com,
//     User type: External (started — may need to finish Contact Info + Finish steps)
// To finish setup and get CLIENT_ID:
//   1. Go to https://console.cloud.google.com/auth/audience?project=focus-planner-495417
//      and complete the consent screen (Contact Information → Finish)
//   2. Go to https://console.cloud.google.com/apis/credentials?project=focus-planner-495417
//   3. Create Credentials → OAuth client ID
//      Application type: Web application
//      Authorized JavaScript origins:
//        https://plannermd.com
//        https://shivbijlani.github.io
//      Authorized redirect URIs:
//        https://plannermd.com/
//        https://shivbijlani.github.io/focus-planner/
//   4. Copy the Client ID (ends in .apps.googleusercontent.com)
//   5. Replace TODO_REGISTER_GOOGLE_APP below with that Client ID
const CLIENT_ID = 'TODO_REGISTER_GOOGLE_APP'
const SCOPES = 'https://www.googleapis.com/auth/drive.file'
const DEFAULT_FOLDER = 'focus-planner'
const FOLDER_KEY = 'gd_folder'

export class GoogleDriveProvider {
  constructor(folderName = null) {
    this._token = null
    this._refreshToken = null
    this._expiresAt = null
    this._folderId = null
    this._fileIndex = {} // path → fileId cache
    this._folder = folderName || localStorage.getItem(FOLDER_KEY) || DEFAULT_FOLDER
    if (folderName) localStorage.setItem(FOLDER_KEY, folderName)
    this._loadTokens()
  }

  folderName() { return `Google Drive/${this._folder}` }

  setFolder(name) {
    this._folder = name
    localStorage.setItem(FOLDER_KEY, name)
  }

  async pick() {
    await this._startPKCE()
    return null // will redirect
  }

  async restore() {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error')

    if (error) { console.error('Google OAuth error:', error); return null }

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
    await this._ensureFolder()
    const files = [
      ['focus-plan.md', `## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|------|---------------|-------|----------|\n\n## Deferred\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|------|---------------|-------|----------|\n\n## Work Priorities\n\n## Personal Priorities\n\n`],
      ['focus-plan-completed.md', '# Completed Tasks\n'],
    ]
    for (const [name, content] of files) {
      const existing = await this.read(name)
      if (!existing) await this.write(name, content)
    }
  }

  async read(path) {
    await this._ensureToken()
    const fileId = await this._resolveFileId(path)
    if (!fileId) return ''
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: this._authHeader(),
    })
    if (res.status === 404) return ''
    if (!res.ok) throw new Error(`Drive read failed: ${res.status}`)
    return res.text()
  }

  async write(path, content) {
    await this._ensureToken()
    const folderId = await this._ensureParentFolder(path)
    const existingId = await this._resolveFileId(path)

    const metadata = { name: _basename(path), mimeType: 'text/plain' }
    if (!existingId) metadata.parents = [folderId]

    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('file', new Blob([content], { type: 'text/plain' }))

    const url = existingId
      ? `${UPLOAD_API}/files/${existingId}?uploadType=multipart`
      : `${UPLOAD_API}/files?uploadType=multipart`

    const res = await fetch(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: this._authHeader(),
      body: form,
    })
    if (!res.ok) throw new Error(`Drive write failed: ${res.status}`)
    const data = await res.json()
    this._fileIndex[path] = data.id
  }

  async remove(path) {
    await this._ensureToken()
    const fileId = await this._resolveFileId(path)
    if (!fileId) return
    await fetch(`${DRIVE_API}/files/${fileId}`, {
      method: 'DELETE',
      headers: this._authHeader(),
    })
    delete this._fileIndex[path]
  }

  async getFiles() {
    await this._ensureToken()
    const folderId = await this._ensureFolder()
    return this._listRecursive(folderId, '')
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
      const journalFolderId = await this._resolveFolderId('journal')
      if (!journalFolderId) return 0
      const items = await this._listFolder(journalFolderId)
      let max = 0
      for (const item of items) {
        const m = item.name.match(/^task-(\d+)\.md$/)
        if (m) max = Math.max(max, parseInt(m[1], 10))
      }
      return max
    } catch { return 0 }
  }

  // ── Private helpers ──────────────────────────────────

  async _ensureFolder() {
    if (this._folderId) return this._folderId
    // Try to find existing folder
    const q = `name='${this._folder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    const res = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
      headers: this._authHeader(),
    })
    const data = await res.json()
    if (data.files?.length > 0) {
      this._folderId = data.files[0].id
      return this._folderId
    }
    // Create it
    const create = await fetch(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: { ...this._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this._folder, mimeType: 'application/vnd.google-apps.folder' }),
    })
    const created = await create.json()
    this._folderId = created.id
    return this._folderId
  }

  async _ensureParentFolder(path) {
    const parts = path.split('/')
    if (parts.length === 1) return this._ensureFolder() // root
    const subPath = parts.slice(0, -1).join('/')
    return this._ensureSubfolder(subPath)
  }

  async _ensureSubfolder(subPath) {
    const parts = subPath.split('/')
    let parentId = await this._ensureFolder()
    for (const part of parts) {
      const existing = await this._findFolder(part, parentId)
      if (existing) { parentId = existing; continue }
      const res = await fetch(`${DRIVE_API}/files`, {
        method: 'POST',
        headers: { ...this._authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: part, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
      })
      const data = await res.json()
      parentId = data.id
    }
    return parentId
  }

  async _findFolder(name, parentId) {
    const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    const res = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
      headers: this._authHeader(),
    })
    const data = await res.json()
    return data.files?.[0]?.id ?? null
  }

  async _resolveFolderId(subPath) {
    const parts = subPath.split('/')
    let parentId = await this._ensureFolder()
    for (const part of parts) {
      const id = await this._findFolder(part, parentId)
      if (!id) return null
      parentId = id
    }
    return parentId
  }

  async _resolveFileId(path) {
    if (this._fileIndex[path]) return this._fileIndex[path]
    const name = _basename(path)
    const parentId = await this._ensureParentFolder(path)
    const q = `name='${name}' and '${parentId}' in parents and trashed=false`
    const res = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
      headers: this._authHeader(),
    })
    const data = await res.json()
    const id = data.files?.[0]?.id ?? null
    if (id) this._fileIndex[path] = id
    return id
  }

  async _listFolder(folderId) {
    const res = await fetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=files(id,name,mimeType)`,
      { headers: this._authHeader() }
    )
    const data = await res.json()
    return data.files ?? []
  }

  async _listRecursive(folderId, prefix) {
    const items = await this._listFolder(folderId)
    const result = []
    for (const item of items) {
      const path = prefix ? `${prefix}/${item.name}` : item.name
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const children = await this._listRecursive(item.id, path)
        result.push({ name: item.name, type: 'directory', path, children })
      } else if (item.name.endsWith('.md')) {
        result.push({ name: item.name, type: 'file', path })
      }
    }
    return result
  }

  // ── PKCE OAuth2 ──────────────────────────────────────

  async _startPKCE() {
    const verifier = _randomBase64(32)
    const challenge = await _sha256Base64url(verifier)
    const state = _randomBase64(16)
    sessionStorage.setItem('gd_verifier', verifier)
    sessionStorage.setItem('gd_state', state)
    sessionStorage.setItem('gd_pending', '1')

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: _redirectUri(),
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    })
    window.location.href = `${AUTH_ENDPOINT}?${params}`
  }

  async _exchangeCode(code, state) {
    const storedState = sessionStorage.getItem('gd_state')
    const verifier = sessionStorage.getItem('gd_verifier')
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
    this._saveTokens(await res.json())
    sessionStorage.removeItem('gd_verifier')
    sessionStorage.removeItem('gd_state')
    sessionStorage.removeItem('gd_pending')
    return true
  }

  async _refreshAccessToken() {
    if (!this._refreshToken) return false
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: this._refreshToken,
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

  async _ensureToken() {
    if (this._isTokenValid()) return
    if (this._refreshToken) {
      const ok = await this._refreshAccessToken()
      if (ok) return
    }
    await this._startPKCE()
    throw new Error('Redirecting to Google login…')
  }

  _isTokenValid() {
    return this._token && this._expiresAt && Date.now() < this._expiresAt
  }

  _authHeader() { return { Authorization: `Bearer ${this._token}` } }

  _saveTokens(data) {
    this._token = data.access_token
    if (data.refresh_token) this._refreshToken = data.refresh_token
    this._expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000
    localStorage.setItem('gd_token', this._token)
    localStorage.setItem('gd_refresh', this._refreshToken ?? '')
    localStorage.setItem('gd_expires', String(this._expiresAt))
  }

  _loadTokens() {
    this._token = localStorage.getItem('gd_token') || null
    this._refreshToken = localStorage.getItem('gd_refresh') || null
    const exp = localStorage.getItem('gd_expires')
    this._expiresAt = exp ? parseInt(exp, 10) : null
  }

  _clearTokens() {
    this._token = null; this._refreshToken = null; this._expiresAt = null
    localStorage.removeItem('gd_token')
    localStorage.removeItem('gd_refresh')
    localStorage.removeItem('gd_expires')
  }
}

function _redirectUri() {
  return `${window.location.origin}${window.location.pathname}`
}

function _basename(path) {
  return path.split('/').pop()
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
