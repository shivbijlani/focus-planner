import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __testing,
  chooseActiveSource,
  dismissMultiSourceNotice,
  getHiddenSources,
  isMultiSourceNoticeDismissed,
  loadSources,
  setActiveSource,
  getActiveSourceId,
} from './sources.js'

function makeLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

describe('single active storage source', () => {
  beforeEach(() => {
    globalThis.localStorage = makeLocalStorage()
    __testing.reset()
  })

  afterEach(() => {
    delete globalThis.localStorage
    __testing.reset()
  })

  it('uses the saved active source or the first registered choice', () => {
    const sources = [{ id: 'first' }, { id: 'last-used' }]
    expect(chooseActiveSource(sources, 'last-used')).toBe(sources[1])
    expect(chooseActiveSource(sources, 'missing')).toBe(sources[0])
    expect(chooseActiveSource([], 'missing')).toBeNull()
  })

  it('retains saved choices and their data while showing only the active choice', () => {
    const storedChoices = [
      { id: 'work', name: 'Work', providerType: 'fsa', token: 'keep-work' },
      { id: 'personal', name: 'Personal', providerType: 'fsa', token: 'keep-personal' },
    ]
    globalThis.localStorage = makeLocalStorage({
      'fp-sources': JSON.stringify(storedChoices),
      'fp-active-source': 'personal',
    })

    expect(loadSources()).toEqual(storedChoices)
    expect(getHiddenSources()).toEqual([storedChoices[0]])
    expect(JSON.parse(localStorage.getItem('fp-sources'))).toEqual(storedChoices)
  })

  it('persists a one-time notice dismissal', () => {
    expect(isMultiSourceNoticeDismissed()).toBe(false)
    dismissMultiSourceNotice()
    expect(isMultiSourceNoticeDismissed()).toBe(true)
  })

  it('switches the active saved source without removing other choices', async () => {
    const storedChoices = [
      { id: 'first', name: 'First', providerType: 'local-storage' },
      { id: 'second', name: 'Second', providerType: 'local-storage' },
    ]
    globalThis.localStorage = makeLocalStorage({
      'fp-sources': JSON.stringify(storedChoices),
      'fp-active-source': 'first',
    })
    loadSources()

    await setActiveSource('second')

    expect(getActiveSourceId()).toBe('second')
    expect(localStorage.getItem('fp-active-source')).toBe('second')
    expect(JSON.parse(localStorage.getItem('fp-sources'))).toEqual(storedChoices)
  })
})
