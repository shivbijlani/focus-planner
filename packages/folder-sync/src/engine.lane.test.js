// #826: a local write must never be undone by the mirror→active replay. engine.writeFile writes the
// active store and then the mirror; a replay landing between the two used to see active ≠ mirror
// and copy the OLD mirror content back over the new file (a task added right after load vanished).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const meta = new Map()
vi.mock('./idb.js', () => ({
  idbGet: async (_store, k) => meta.get(k),
  idbSet: async (_store, k, v) => { meta.set(k, v) },
  idbKeys: async () => [...meta.keys()],
  idbDel: async (_store, k) => { meta.delete(k) },
}))
vi.mock('./queue.js', () => ({ enqueue: async () => {}, peekAll: async () => [] }))
vi.mock('./auth/tokenStore.js', () => ({ getTokens: async () => null, clearTokens: async () => {} }))

const { createSyncEngine } = await import('./engine.js')

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function adapter() {
  const files = new Map()
  const a = {
    files,
    gate: null,
    async init() { return true },
    async readFile(n) { return files.get(n) ?? '' },
    async writeFile(n, c) {
      files.set(n, c)
      if (a.gate) await a.gate.promise // the window between the active write and the mirror write
      return { mtime: Date.now() }
    },
    async deleteFile(n) { files.delete(n) },
    async listFiles() { return [...files.keys()] },
    async getFolderName() { return 'test' },
  }
  return a
}

describe('engine: local writes and the mirror replay share one lane (#826)', () => {
  beforeEach(() => {
    meta.clear()
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a replay that fires mid-write cannot restore the old content', async () => {
    const local = adapter()
    local.files.set('planner.md', 'OLD')
    meta.set('local:planner.md', { content: 'OLD', mtime: 1 })
    const engine = createSyncEngine({ localAdapter: local, providers: [], redirectUri: 'http://x/' })

    local.gate = deferred()
    const write = engine.writeFile('planner.md', 'NEW')
    await vi.advanceTimersByTimeAsync(900) // the startup replay fires while the write is half done
    local.gate.resolve()
    local.gate = null
    await write
    await vi.advanceTimersByTimeAsync(100)

    expect(local.files.get('planner.md')).toBe('NEW')
    expect(meta.get('local:planner.md').content).toBe('NEW')
  })

  it('the replay still repairs a file the mirror has and the active store lost', async () => {
    const local = adapter()
    meta.set('local:journal/task-1.md', { content: 'pulled', mtime: 1 })
    createSyncEngine({ localAdapter: local, providers: [], redirectUri: 'http://x/' })
    await vi.advanceTimersByTimeAsync(900)
    expect(local.files.get('journal/task-1.md')).toBe('pulled')
  })

  it('a delete is not resurrected by a replay that fires mid-delete', async () => {
    const local = adapter()
    local.files.set('journal/task-2.md', 'x')
    meta.set('local:journal/task-2.md', { content: 'x', mtime: 1 })
    const engine = createSyncEngine({ localAdapter: local, providers: [], redirectUri: 'http://x/' })
    const gate = deferred()
    const del = local.deleteFile.bind(local)
    local.deleteFile = async (n) => { await del(n); await gate.promise }
    const p = engine.deleteFile('journal/task-2.md')
    await vi.advanceTimersByTimeAsync(900)
    gate.resolve()
    await p
    await vi.advanceTimersByTimeAsync(100)
    expect(local.files.has('journal/task-2.md')).toBe(false)
    expect(meta.get('local:journal/task-2.md').deleted).toBe(true)
  })
})
