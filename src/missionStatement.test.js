import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMissionStatement,
  setMissionStatement,
  subscribeMissionStatement,
  __testing,
} from './missionStatement.js'

// The module talks to localStorage + window events. The default vitest env is
// node, so we install minimal in-memory stubs to exercise the real code paths.
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
  beforeEach(() => installDom())
  afterEach(() => {
    delete globalThis.localStorage
    delete globalThis.window
    delete globalThis.CustomEvent
  })

  it('returns empty string when unset', () => {
    expect(getMissionStatement()).toBe('')
  })

  it('persists and reads back a value', () => {
    setMissionStatement('Be present with family.')
    expect(getMissionStatement()).toBe('Be present with family.')
    expect(localStorage.getItem(__testing.STORAGE_KEY)).toBe('Be present with family.')
  })

  it('trims whitespace and clears on empty', () => {
    setMissionStatement('   Ship calm software.  ')
    expect(getMissionStatement()).toBe('Ship calm software.')
    setMissionStatement('   ')
    expect(getMissionStatement()).toBe('')
  })

  it('notifies subscribers with the new value', () => {
    const seen = vi.fn()
    const unsub = subscribeMissionStatement(seen)
    setMissionStatement('North star')
    expect(seen).toHaveBeenCalledWith('North star')
    unsub()
    setMissionStatement('changed again')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('survives missing storage without throwing', () => {
    delete globalThis.localStorage
    expect(() => setMissionStatement('x')).not.toThrow()
    expect(getMissionStatement()).toBe('')
  })
})
