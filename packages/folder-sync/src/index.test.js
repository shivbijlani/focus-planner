import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createFolderSync, TARGET_STATUS } from './index.js'

function memoryStorage() {
  const data = new Map()
  return {
    get length() { return data.size },
    key(index) { return Array.from(data.keys())[index] ?? null },
    getItem(key) { return data.has(key) ? data.get(key) : null },
    setItem(key, value) { data.set(key, String(value)) },
    removeItem(key) { data.delete(key) },
    clear() { data.clear() },
  }
}

function memoryStore(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    read: async path => files.get(path) ?? '',
    write: async (path, content) => files.set(path, content),
    listPaths: async () => Array.from(files.keys()).sort(),
    set: (path, content) => files.set(path, content),
    get: (path) => files.get(path),
  }
}

function target(id = 'onedrive') {
  return {
    id,
    label: id,
    restore: vi.fn(async () => true),
    connect: vi.fn(async () => true),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    read: vi.fn(async () => ''),
    list: vi.fn(async () => []),
  }
}

describe('folder sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('marks every local file dirty when a target connects and pushes the latest local content', async () => {
    const storage = memoryStorage()
    const store = memoryStore({ 'focus-plan.md': 'local plan' })
    const oneDrive = target()
    const sync = createFolderSync({
      storage,
      configKey: 'config',
      metaPrefix: 'meta:',
      pendingKey: 'pending',
      localFolders: [{ id: 'browser', name: 'Browser Storage', store, targets: [oneDrive] }],
    })

    await sync.connectTarget('browser', 'onedrive')

    expect(oneDrive.write).toHaveBeenCalledWith('focus-plan.md', 'local plan')
    expect(sync.getStatus().folders.browser.targets.onedrive.status).toBe(TARGET_STATUS.SYNCED)
  })

  it('collapses repeated writes into one dirty file upload with latest content', async () => {
    const storage = memoryStorage()
    const store = memoryStore({ 'focus-plan.md': 'v1' })
    const oneDrive = target()
    const sync = createFolderSync({
      storage,
      configKey: 'config',
      metaPrefix: 'meta:',
      pendingKey: 'pending',
      syncDelay: 10,
      localFolders: [{ id: 'browser', name: 'Browser Storage', store, targets: [oneDrive] }],
    })

    await sync.connectTarget('browser', 'onedrive')
    oneDrive.write.mockClear()

    store.set('focus-plan.md', 'v2')
    await sync.markDirty('focus-plan.md', 'write', 'browser')
    store.set('focus-plan.md', 'v3')
    await sync.markDirty('focus-plan.md', 'write', 'browser')
    await vi.runOnlyPendingTimersAsync()

    expect(oneDrive.write).toHaveBeenCalledTimes(1)
    expect(oneDrive.write).toHaveBeenCalledWith('focus-plan.md', 'v3')
  })

  it('pulls remote files into local store on connect when local is empty', async () => {
    const storage = memoryStorage()
    const store = memoryStore({})
    const oneDrive = target()
    oneDrive.list.mockResolvedValue([
      { path: 'focus-plan.md', mtime: '2026-05-10T12:00:00Z', etag: 'abc123' },
      { path: 'journal/task-1.md', mtime: '2026-05-10T12:00:00Z', etag: 'def456' },
    ])
    oneDrive.read.mockImplementation(async (path) => {
      if (path === 'focus-plan.md') return 'remote plan content'
      if (path === 'journal/task-1.md') return '# Task 1\n- TODO: something'
      return ''
    })

    const changed = []
    const sync = createFolderSync({
      storage,
      configKey: 'config',
      metaPrefix: 'meta:',
      pendingKey: 'pending',
      localFolders: [{ id: 'browser', name: 'Browser Storage', store, targets: [oneDrive] }],
    })
    sync.onLocalChange(paths => changed.push(...paths))

    await sync.connectTarget('browser', 'onedrive')

    expect(store.get('focus-plan.md')).toBe('remote plan content')
    expect(store.get('journal/task-1.md')).toBe('# Task 1\n- TODO: something')
    expect(changed).toContain('focus-plan.md')
    expect(changed).toContain('journal/task-1.md')
    expect(sync.getStatus().folders.browser.targets.onedrive.status).toBe(TARGET_STATUS.SYNCED)
  })

  it('treats remote as authoritative on initial connect (does not clobber backup with local scaffold)', async () => {
    // Regression test for issue #19: on first connect, scaffolded local
    // content must not overwrite the existing remote backup. We pull
    // remote first; local "dirty" only kicks in after a successful sync
    // has established baseline metadata.
    const storage = memoryStorage()
    const store = memoryStore({ 'focus-plan.md': 'scaffold template' })
    const oneDrive = target()
    oneDrive.list.mockResolvedValue([
      { path: 'focus-plan.md', mtime: '2026-05-09T12:00:00Z', etag: 'old' },
    ])
    oneDrive.read.mockResolvedValue('real backup content')

    const sync = createFolderSync({
      storage,
      configKey: 'config',
      metaPrefix: 'meta:',
      pendingKey: 'pending',
      localFolders: [{ id: 'browser', name: 'Browser Storage', store, targets: [oneDrive] }],
    })

    await sync.connectTarget('browser', 'onedrive')

    // Remote wins on initial connect — local scaffold is overwritten by backup.
    expect(store.get('focus-plan.md')).toBe('real backup content')
    // And we do NOT push the scaffold back up over the real backup.
    expect(oneDrive.write).not.toHaveBeenCalledWith('focus-plan.md', 'scaffold template')
  })
})
