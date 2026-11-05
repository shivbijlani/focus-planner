// Direct Microsoft Graph executor for CLI/MCP use outside Muse (#836).
//
// Reads return {content, id, etag} snapshots, re-checking the item version
// after download so content and eTag always belong together. Writes execute
// only requests produced by planTool, and only against files the guardrail
// allowlist permits, keyed by the item IDs this client itself read.
import { ToolError } from './errors.js'
import { assertWritable } from './paths.js'
import { APPROOT, GRAPH } from './plan.js'

export function graphClient({ getAccessToken, fetchImpl = fetch }) {
  const itemNames = new Map()

  async function call(url, init = {}) {
    const token = await getAccessToken()
    if (!token) throw new ToolError('AUTH_REQUIRED', 'Sign in to the Focus Planner app first (device code) or supply a runtime token.')
    let response
    try {
      response = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
    } catch {
      throw new ToolError('NETWORK_ERROR', 'OneDrive request failed. Nothing is claimed; retry with the same operationId.')
    }
    if (response.status === 401) throw new ToolError('AUTH_REQUIRED', 'OneDrive sign-in expired; sign in again.')
    if (response.status === 403) throw new ToolError('ACCESS_DENIED', 'Focus Planner app-folder access was denied.')
    return response
  }

  async function readFile(read) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const meta = await call(read.url)
      if (meta.status === 404) return { content: null, id: null, etag: null }
      if (!meta.ok) throw new ToolError('ONEDRIVE_ERROR', `OneDrive returned HTTP ${meta.status}.`)
      const item = await meta.json()
      const downloadUrl = item['@microsoft.graph.downloadUrl']
      if (!item.id || !item.eTag || !downloadUrl) throw new ToolError('INVALID_RESPONSE', 'OneDrive did not return versioned file metadata.')
      let download
      try { download = await fetchImpl(downloadUrl) } catch { throw new ToolError('NETWORK_ERROR', 'OneDrive download failed.') }
      if (!download.ok) throw new ToolError('ONEDRIVE_ERROR', `OneDrive download returned HTTP ${download.status}.`)
      const text = await download.text()
      const check = await call(`${read.url}${read.url.includes('?') ? '&' : '?'}$select=id,eTag`)
      if (!check.ok) continue
      const version = await check.json()
      if (version.id !== item.id || version.eTag !== item.eTag) continue
      itemNames.set(item.id, read.filename)
      return { content: text, id: item.id, etag: item.eTag }
    }
    throw new ToolError('CONCURRENT_UPDATE', 'OneDrive kept changing during read. Retry.')
  }

  async function readListing(read) {
    const names = []
    let url = read.url
    while (url) {
      const response = await call(url)
      if (response.status === 404) return { names: [] }
      if (!response.ok) throw new ToolError('ONEDRIVE_ERROR', `OneDrive returned HTTP ${response.status}.`)
      const page = await response.json()
      for (const item of page.value ?? []) if (typeof item.name === 'string') names.push(item.name)
      url = page['@odata.nextLink'] || null
      if (url && !url.startsWith(`${GRAPH}/`)) throw new ToolError('INVALID_RESPONSE', 'Unexpected paging link.')
    }
    return { names }
  }

  return {
    read: (read) => (read.kind === 'listing' ? readListing(read) : readFile(read)),
    async write(filename, request) {
      assertWritable(filename)
      const byId = request.url.match(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/items\/([^/]+)\/content$/)
      const byPath = request.url.startsWith(`${APPROOT}:/`)
      if (byId ? itemNames.get(decodeURIComponent(byId[1])) !== filename : !byPath) {
        throw new ToolError('POLICY_DENIED', 'Refusing a write that does not target a file this client read.')
      }
      if (!request.headers['If-Match'] && request.headers['If-None-Match'] !== '*') {
        throw new ToolError('POLICY_DENIED', 'Refusing an unconditional write.')
      }
      const response = await call(request.url, { method: 'PUT', headers: request.headers, body: request.body })
      if (response.status === 409 || response.status === 412) return response.status
      if (!response.ok) throw new ToolError('ONEDRIVE_ERROR', `OneDrive returned HTTP ${response.status} on write. Re-read before retrying.`)
      return response.status
    },
  }
}
