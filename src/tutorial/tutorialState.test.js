import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTutorialState,
  saveTutorialState,
  recordLesson,
  markDismissed,
  markGraduated,
  resetTutorialState,
  subscribeTutorialState,
  __testing,
} from './tutorialState.js'
import { LESSON_STATUS } from './lessons.js'

// tutorialState talks to localStorage + window CustomEvents. Default vitest env
// is node, so install minimal in-memory stubs to exercise the real code paths.
function installDom() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  const listeners = new Map()
  globalThis.window = {
    localStorage: globalThis.localStorage,
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

describe('tutorialState persistence', () => {
  beforeEach(() => {
    installDom()
  })

  afterEach(() => {
    delete globalThis.localStorage
    delete globalThis.window
    delete globalThis.CustomEvent
  })

  it('returns a normalized empty state before anything is saved', () => {
    const s = getTutorialState()
    expect(s.version).toBe(1)
    expect(s.dismissed).toBe(false)
    expect(s.graduatedAt).toBeNull()
    expect(Object.keys(s.lessons)).toContain('delegate-ai')
    expect(s.lessons['delegate-ai'].status).toBe(LESSON_STATUS.NOT_STARTED)
  })

  it('recordLesson advances and persists a lesson', () => {
    recordLesson('add-todo')
    const s = getTutorialState()
    expect(s.lessons['add-todo'].status).toBe(LESSON_STATUS.DONE)
    expect(s.startedAt).toBeTruthy()
  })

  it('create-priority needs three records to complete', () => {
    recordLesson('create-priority')
    expect(getTutorialState().lessons['create-priority'].status).toBe(LESSON_STATUS.IN_PROGRESS)
    recordLesson('create-priority')
    recordLesson('create-priority')
    expect(getTutorialState().lessons['create-priority'].status).toBe(LESSON_STATUS.DONE)
  })

  it('markDismissed and markGraduated persist their flags', () => {
    markDismissed()
    expect(getTutorialState().dismissed).toBe(true)
    markGraduated()
    expect(getTutorialState().graduatedAt).toBeTruthy()
  })

  it('resetTutorialState wipes progress', () => {
    recordLesson('add-todo')
    markDismissed()
    resetTutorialState()
    const s = getTutorialState()
    expect(s.dismissed).toBe(false)
    expect(s.graduatedAt).toBeNull()
    expect(s.lessons['add-todo'].status).toBe(LESSON_STATUS.NOT_STARTED)
  })

  it('saveTutorialState emits to subscribers', () => {
    const spy = vi.fn()
    const unsub = subscribeTutorialState(spy)
    saveTutorialState({ ...getTutorialState(), dismissed: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].dismissed).toBe(true)
    unsub()
    saveTutorialState({ ...getTutorialState(), dismissed: false })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('survives corrupt persisted JSON', () => {
    globalThis.localStorage.setItem(__testing.STORAGE_KEY, '{not json')
    const s = getTutorialState()
    expect(s.lessons['create-task'].status).toBe(LESSON_STATUS.NOT_STARTED)
  })
})
