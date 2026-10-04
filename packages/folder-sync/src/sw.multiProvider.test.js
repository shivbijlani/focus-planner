import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { idbDel, idbGet, idbKeys, idbSet } from './idb.js'
import { setTokens } from './auth/tokenStore.js'
import { enqueue } from './queue.js'
import { createSyncEngine } from './engine.js'
import { readLocalSnapshot, saveLocalReplica } from './localReplica.js'
import { mdTableCodec } from './codecs/mdTable.js'

const clouds = vi.hoisted(() => new Map())
const makeProvider = vi.hoisted(() => id => ({
  id,
  async listRemote() {
    return [...clouds.get(id).files].map(([name]) => ({ name, mtime: 1 }))
  },
  async readRemote(_provider, name) {
    const cloud = clouds.get(id)
    if (cloud.onRead) await cloud.onRead(name)
    if (cloud.error) throw cloud.error
    return cloud.files.get(name) ?? null
  },
  async writeRemote(_provider, name, content) {
    const cloud = clouds.get(id)
    cloud.writes.push(name)
    cloud.files.set(name, content)
    return { mtime: Date.now() }
  },
  async deleteRemote(_provider, name) { clouds.get(id).files.delete(name) },
}))
vi.mock('./providers/oneDrive.js', () => ({ oneDriveProvider: () => makeProvider('onedrive') }))
vi.mock('./providers/googleDrive.js', () => ({ googleDriveProvider: () => makeProvider('google-drive') }))

const PATH = 'planner.md'
const plan = (...rows) => '## Today\n\n| ID | Task |\n|---|---|\n' + rows.map(([id, text]) => `| ${id} | ${text} |`).join('\n') + '\n\n## Priorities\n\n1. Keep my data\n'
const ids = content => Object.keys(mdTableCodec.parse(content).records).sort()
const fullBoard = plan(...Array.from({ length: 153 }, (_, i) => [i + 1, `Task ${i + 1}`]))
let events, statuses, posts

async function loadWorker() {
  events = new Map()
  vi.stubGlobal('self', {
    navigator: { onLine: true },
    addEventListener: (type, fn) => events.set(type, fn),
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: msg => posts.push(msg) }],
    },
    registration: { sync: { register: vi.fn(async () => {}) } },
    skipWaiting: async () => {},
  })
  await import(`./sw.js`)
}

async function cycle(order = ['onedrive', 'google-drive']) {
  let work
  events.get('message')({
    data: { type: 'sync', providers: order.map(id => ({ id })), reason: 'test' },
    waitUntil: promise => { work = promise },
  })
  await work
}

function device(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    init: async () => true,
    readFile: async name => files.get(name) ?? '',
    writeFile: async (name, content) => { files.set(name, content) },
    deleteFile: async name => { files.delete(name) },
    listFiles: async () => [...files.keys()],
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  statuses = []
  posts = []
  vi.stubGlobal('BroadcastChannel', class {
    postMessage(msg) { statuses.push(msg.status) }
    close() {}
  })
  for (const store of ['meta', 'queue', 'tokens']) {
    for (const key of await idbKeys(store)) await idbDel(store, key)
  }
  for (const id of ['onedrive', 'google-drive']) {
    clouds.set(id, { files: new Map(), writes: [], error: null, onRead: null })
    await setTokens(id, { accessToken: 'test', expiresAt: Date.now() + 3600_000 })
  }
  // Reevaluate the actual worker's event handlers/inFlight state, not a copy of
  // its algorithm. IndexedDB persists across these worker restarts.
  vi.resetModules()
  await loadWorker()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clouds.clear()
})

describe('actual service worker: device + OneDrive + Google Drive', () => {
  it.each([
    ['onedrive', 'google-drive'],
    ['google-drive', 'onedrive'],
  ])('onboards an empty second cloud without losing 153 rows (%s first)', async (first, second) => {
    const local = device({
      [PATH]: fullBoard,
      'planner-completed.md': plan([900, 'Completed task']),
      'journal/task-1.md': '# Task 1\nRecovered journal',
    })
    clouds.get(first).files.set(PATH, fullBoard)
    const engine = createSyncEngine({ localAdapter: local, deferLocalInit: true, redirectUri: '' })
    await engine.initLocal() // No edits: existing device files must still be seeded.
    await cycle([first, second])
    await cycle([first, second])
    expect(ids((await readLocalSnapshot(PATH)).content)).toEqual(ids(fullBoard))
    for (const id of [first, second]) {
      expect(ids(clouds.get(id).files.get(PATH))).toEqual(ids(fullBoard))
      expect(clouds.get(id).files.get('planner-completed.md')).toContain('Completed task')
      expect(clouds.get(id).files.get('journal/task-1.md')).toContain('Recovered journal')
    }
  })

  it('a scaffolded/empty Google copy with leftover alive metadata cannot delete the device rows', async () => {
    await saveLocalReplica(PATH, fullBoard, { importing: true })
    clouds.get('onedrive').files.set(PATH, fullBoard)
    clouds.get('google-drive').files.set(PATH, plan())
    clouds.get('google-drive').files.set(`${PATH}.sync.json`, (await readLocalSnapshot(PATH)).rawSidecar)
    await enqueue(PATH)
    await cycle()
    expect(ids((await readLocalSnapshot(PATH)).content)).toEqual(ids(fullBoard))
    expect(ids(clouds.get('google-drive').files.get(PATH))).toEqual(ids(fullBoard))
    const meta = JSON.parse((await readLocalSnapshot(PATH)).rawSidecar).entries
    expect(Object.values(meta).some(entry => entry.deleted)).toBe(false)
  })

  it('repairs an empty already-seeded provider without any pending user edits', async () => {
    await saveLocalReplica(PATH, fullBoard, { importing: true })
    await saveLocalReplica('journal/task-1.md', '# Recovered journal', { importing: true })
    await idbSet('meta', 'seeded:google-drive', 1)
    await idbSet('meta', 'mtime:google-drive:planner.md', 1)
    await idbSet('meta', 'pending:google-drive', [])
    await idbSet('meta', 'seeded:onedrive', 1)
    clouds.get('onedrive').files.set(PATH, fullBoard)
    await cycle()
    expect(ids(clouds.get('google-drive').files.get(PATH))).toEqual(ids(fullBoard))
    expect(clouds.get('google-drive').files.get('journal/task-1.md')).toBe('# Recovered journal')
  })

  it('preserves both journal versions rather than silently losing local content on first contact', async () => {
    await saveLocalReplica('journal/task-1.md', '# Device journal', { importing: true })
    clouds.get('google-drive').files.set('journal/task-1.md', '# Google journal')
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await cycle()
    await cycle()
    expect((await readLocalSnapshot('journal/task-1.md')).content).toBe('# Google journal')
    const conflictKeys = (await idbKeys('meta')).filter(key => key.startsWith('local:sync-conflicts/'))
    expect(conflictKeys).toHaveLength(1)
    expect((await idbGet('meta', conflictKeys[0])).content).toBe('# Device journal')
    const conflictPath = conflictKeys[0].slice('local:'.length)
    for (const cloud of clouds.values()) expect(cloud.files.get(conflictPath)).toBe('# Device journal')
    log.mockRestore()
  })

  it('repairs a missing cached board from the populated cloud, without manufacturing tombstones', async () => {
    await saveLocalReplica(PATH, fullBoard, { importing: true })
    await idbDel('meta', `local:${PATH}`) // content lost, sidecar survived
    clouds.get('onedrive').files.set(PATH, fullBoard)
    await cycle(['google-drive', 'onedrive'])
    await cycle(['google-drive', 'onedrive'])
    expect(ids((await readLocalSnapshot(PATH)).content)).toEqual(ids(fullBoard))
    for (const cloud of clouds.values()) expect(ids(cloud.files.get(PATH))).toEqual(ids(fullBoard))
  })

  it('forwards records learned from the last provider to the first, without another user edit', async () => {
    await saveLocalReplica(PATH, plan([1, 'Device row']), { importing: true })
    clouds.get('google-drive').files.set(PATH, plan([2, 'Google-only row']))
    await enqueue(PATH)
    await cycle()
    await cycle()
    expect(ids(clouds.get('onedrive').files.get(PATH))).toEqual(['1', '2'])
    expect(ids(clouds.get('google-drive').files.get(PATH))).toEqual(['1', '2'])
    expect(await idbKeys('queue')).toEqual([])
  })

  it('honors deliberate tombstones across both clouds, then survives a stale-device reload', async () => {
    const local = device({ [PATH]: plan([1, 'A'], [2, 'B']) })
    const engine = createSyncEngine({ localAdapter: local, deferLocalInit: true, redirectUri: '' })
    await engine.initLocal()
    await cycle()
    vi.setSystemTime(Date.now() + 1000)
    await engine.writeFile(PATH, plan([1, 'A']))
    await cycle()
    // A returning old device has B in its markdown but has the durable deletion
    // metadata. Startup must not restamp B alive just because it is present.
    local.files.set(PATH, plan([1, 'A'], [2, 'B']))
    const reloaded = createSyncEngine({ localAdapter: local, deferLocalInit: true, redirectUri: '' })
    await reloaded.initLocal()
    await cycle()
    for (const cloud of clouds.values()) {
      expect(ids(cloud.files.get(PATH))).toEqual(['1'])
      expect(JSON.parse(cloud.files.get(`${PATH}.sync.json`)).entries['2'].deleted).toBe(true)
    }
    expect(ids(local.files.get(PATH))).toEqual(['1'])
  })

  it('a genuinely stale second device cannot resurrect rows deleted through either cloud', async () => {
    const original = plan([1, 'A'], [2, 'B'])
    await saveLocalReplica(PATH, original, { importing: true })
    const staleDevice = await readLocalSnapshot(PATH)
    await enqueue(PATH)
    await cycle()
    vi.setSystemTime(Date.now() + 1000)
    await saveLocalReplica(PATH, plan([1, 'A']), { previousContent: original })
    await enqueue(PATH)
    await cycle()
    // Switch the test's local replica to a second device's old independent
    // content AND old sidecar, not just an old active-store markdown file.
    await idbSet('meta', `local:${PATH}`, staleDevice.file)
    await idbSet('meta', `local:${PATH}.sync.json`, staleDevice.sidecar)
    await enqueue(PATH)
    vi.setSystemTime(Date.now() + 1000)
    await cycle(['google-drive', 'onedrive'])
    expect(ids((await readLocalSnapshot(PATH)).content)).toEqual(['1'])
    for (const cloud of clouds.values()) expect(ids(cloud.files.get(PATH))).toEqual(['1'])
  })

  it('explicitly clearing the last row propagates tombstones rather than being mistaken for an empty provider', async () => {
    const original = plan([1, 'A'])
    const local = device({ [PATH]: original })
    const engine = createSyncEngine({ localAdapter: local, deferLocalInit: true, redirectUri: '' })
    await engine.initLocal()
    await cycle()
    vi.setSystemTime(Date.now() + 1000)
    await engine.deleteFile(PATH)
    await cycle()
    for (const cloud of clouds.values()) {
      expect(ids(cloud.files.get(PATH))).toEqual([])
      expect(JSON.parse(cloud.files.get(`${PATH}.sync.json`)).entries['1'].deleted).toBe(true)
    }
  })

  it('retries a stale worker snapshot when a user saves while remote reads are in flight', async () => {
    const initial = plan([1, 'A'])
    await saveLocalReplica(PATH, initial, { importing: true })
    await enqueue(PATH)
    let edited = false
    clouds.get('onedrive').onRead = async name => {
      if (name !== PATH || edited) return
      edited = true
      await saveLocalReplica(PATH, plan([1, 'Edited during sync'], [2, 'New']), { previousContent: initial })
    }
    await cycle()
    expect(ids((await readLocalSnapshot(PATH)).content)).toEqual(['1', '2'])
    for (const cloud of clouds.values()) {
      expect(cloud.files.get(PATH)).toContain('Edited during sync')
      expect(ids(cloud.files.get(PATH))).toEqual(['1', '2'])
    }
  })

  it.each(['reconnect-required', 'Drive read failed: 500', 'Network unavailable'])('does not turn %s into an empty cloud', async message => {
    await saveLocalReplica(PATH, fullBoard, { importing: true })
    await enqueue(PATH)
    clouds.get('google-drive').error = new Error(message)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await cycle()
    expect(ids((await readLocalSnapshot(PATH)).content)).toEqual(ids(fullBoard))
    expect(clouds.get('google-drive').writes).toEqual([])
    expect(await idbGet('meta', 'pending:google-drive')).toContain(PATH)
    expect(statuses.at(-1).providers['google-drive'].state).toBe(message === 'reconnect-required' ? 'reconnect-required' : 'error')
    clouds.get('google-drive').error = null
    await cycle()
    expect(ids(clouds.get('google-drive').files.get(PATH))).toEqual(ids(fullBoard))
    log.mockRestore()
  })
})
