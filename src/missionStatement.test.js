import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMissionStatement,
  loadMissionStatement,
  setMissionStatement,
  subscribeMissionStatement,
  __testing,
} from './missionStatement.js'
import { SETTINGS_FILE, __testing as settingsTesting } from './storage/settings.js'

// The module talks to settings storage + window events. The default vitest env
// is node, so we install minimal in-memory stubs to exercise the real code paths.
function installDom() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  const listeners = new Map()
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    dispatchEvent: (evt) => { listeners.get(evt.type)?.forEach((fn) => fn(evt)) },
  }
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts = {}) { this.type = type; this.detail = opts.detail }
  }
}

describe('mission statement', () => {
  let files

  beforeEach(() => {
    installDom()
    __testing.resetCache()
    files = new Map()
    settingsTesting.setStorageAdapter({
      read: async (path) => files.get(path) ?? '',
      write: async (path, content) => files.set(path, content),
    })
  })
  afterEach(() => {
    delete globalThis.localStorage
    delete globalThis.window
    delete globalThis.CustomEvent
    settingsTesting.setStorageAdapter(null)
    __testing.resetCache()
  })

  it('returns empty string when unset', () => {
    expect(getMissionStatement()).toBe('')
  })

  it('persists and reads back a value from settings.json', async () => {
    await setMissionStatement('Be present with family.')
    expect(getMissionStatement()).toBe('Be present with family.')
    expect(JSON.parse(files.get(SETTINGS_FILE)).missionStatement).toBe('Be present with family.')
  })

  it('trims whitespace and clears on empty', async () => {
    await setMissionStatement('   Ship calm software.  ')
    expect(getMissionStatement()).toBe('Ship calm software.')
    await setMissionStatement('   ')
    expect(getMissionStatement()).toBe('')
    expect(JSON.parse(files.get(SETTINGS_FILE)).missionStatement).toBe('')
  })

  it('notifies subscribers with the new value', async () => {
    const seen = vi.fn()
    const unsub = subscribeMissionStatement(seen)
    await setMissionStatement('North star')
    expect(seen).toHaveBeenCalledWith('North star')
    unsub()
    await setMissionStatement('changed again')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('loads the mission from settings.json', async () => {
    files.set(SETTINGS_FILE, '{ "version": 1, "missionStatement": "Loaded north star" }')
    await loadMissionStatement()
    expect(getMissionStatement()).toBe('Loaded north star')
  })

  it('survives unavailable settings storage without throwing', async () => {
    settingsTesting.setStorageAdapter({
      read: async () => { throw new Error('no storage') },
      write: async () => { throw new Error('no storage') },
    })
    await expect(setMissionStatement('x')).resolves.toBe('x')
    expect(getMissionStatement()).toBe('x')
  })
})
