// In-memory Microsoft Graph app folder for tests. Implements exactly the
// endpoints the planner tools use, with eTags and If-Match / If-None-Match.
export const GRAPH = 'https://graph.microsoft.com/v1.0'
export const APPROOT = `${GRAPH}/me/drive/special/approot`

export function fakeGraph(initial = {}) {
  const files = new Map()
  let seq = 0
  const put = (path, content) => {
    const prev = files.get(path)
    const id = prev?.id ?? `item-${++seq}`
    files.set(path, { id, etag: `"{${id}},${++seq}"`, content })
  }
  for (const [path, content] of Object.entries(initial)) put(path, content)
  const state = { calls: [], beforeWrite: null }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const byId = (id) => [...files.entries()].find(([, f]) => f.id === id)

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET'
    state.calls.push({ url, method, headers: init.headers || {} })
    if (url.startsWith('https://download.example/')) {
      const entry = byId(decodeURIComponent(url.slice('https://download.example/'.length)))
      return entry ? new Response(entry[1].content, { status: 200 }) : new Response('', { status: 404 })
    }
    if (!init.headers?.Authorization?.startsWith('Bearer ')) return json({ error: 'unauthenticated' }, 401)
    if (method === 'PUT' && state.beforeWrite) {
      const hook = state.beforeWrite
      state.beforeWrite = null
      hook({ files, put })
    }
    const itemMatch = url.match(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/items\/([^/]+)\/content$/)
    if (itemMatch && method === 'PUT') {
      const entry = byId(decodeURIComponent(itemMatch[1]))
      if (!entry) return json({}, 404)
      if (init.headers['If-Match'] !== entry[1].etag) return json({ error: 'precondition' }, 412)
      put(entry[0], init.body)
      return json({ id: entry[1].id }, 200)
    }
    if (!url.startsWith(`${APPROOT}:/`)) return json({}, 400)
    const rest = url.slice(`${APPROOT}:/`.length)
    const [pathPart] = rest.split('?')
    if (pathPart.endsWith(':/children')) {
      const dir = decodeURIComponent(pathPart.slice(0, -':/children'.length))
      const names = [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1))
      if (!names.length) return json({}, 404)
      return json({ value: names.map(name => ({ name })) })
    }
    if (pathPart.endsWith(':/content') && method === 'PUT') {
      const path = decodeURIComponent(pathPart.slice(0, -':/content'.length))
      if (files.has(path)) return json({ error: 'nameAlreadyExists' }, 409)
      put(path, init.body)
      return json({ id: files.get(path).id }, 201)
    }
    const path = decodeURIComponent(pathPart)
    const file = files.get(path)
    if (!file) return json({}, 404)
    if (rest.includes('$select=id,eTag')) return json({ id: file.id, eTag: file.etag })
    return json({ id: file.id, eTag: file.etag, name: path, '@microsoft.graph.downloadUrl': `https://download.example/${encodeURIComponent(file.id)}` })
  }

  return { files, state, fetchImpl, read: (path) => files.get(path)?.content ?? null, put }
}

export const BOARD = `## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 30 | 🟡 | Plan the trip | - | 2026-10-01 | |
| 31 | 🔴 | Book flights | - | 2026-10-02 | 30 |
| 32 | 🟡 | Pack | - | 2026-10-02 | |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |
|---|---|------|---------------|-------|------|-----------|
| 33 | ⚪ | Hotel research | - | 2026-10-03 |  | 31 |

## Priorities

1. 30
`

export const COMPLETED = `# Completed Tasks

## Week of 10/5/2026

| # | 🎯 | Task | Work Priority | Completed Date |
|---|---|------|---------------|----------------|
| 12 | ✅ | Old thing | - | 2026-10-06 |
`

export const JOURNAL_31 = `# Task 31: Book flights

- [ ] Compare fares
- TODO: Pick seats

## 2026-10-19

<!-- from: me -->
Prefer aisle seats.
`
