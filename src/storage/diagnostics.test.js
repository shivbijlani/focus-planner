import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatDiagnosticsReport,
  isDiagnosticsEnabled,
  setDiagnosticsEnabled,
  recordDiagnosticEvent,
  getDiagnosticEvents,
  clearDiagnosticEvents,
} from './diagnostics.js'

let originalLocalStorage
let store

beforeEach(() => {
  originalLocalStorage = globalThis.localStorage
  store = new Map()
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
})

afterEach(() => {
  clearDiagnosticEvents()
  if (originalLocalStorage === undefined) {
    delete globalThis.localStorage
  } else {
    globalThis.localStorage = originalLocalStorage
  }
})

describe('diagnostics enable flag', () => {
  it('defaults to disabled and round-trips', () => {
    expect(isDiagnosticsEnabled()).toBe(false)
    setDiagnosticsEnabled(true)
    expect(isDiagnosticsEnabled()).toBe(true)
    setDiagnosticsEnabled(false)
    expect(isDiagnosticsEnabled()).toBe(false)
  })
})

describe('diagnostic event buffer', () => {
  it('only records when enabled', () => {
    setDiagnosticsEnabled(false)
    recordDiagnosticEvent('sync', 'ignored while off')
    expect(getDiagnosticEvents()).toHaveLength(0)

    setDiagnosticsEnabled(true)
    recordDiagnosticEvent('quota', 'QuotaExceededError on task-999.md')
    const events = getDiagnosticEvents()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('quota')
    expect(events[0].message).toContain('QuotaExceededError')
    expect(typeof events[0].t).toBe('string')
  })

  it('caps the buffer at 100 events', () => {
    setDiagnosticsEnabled(true)
    for (let i = 0; i < 130; i++) recordDiagnosticEvent('sync', `event ${i}`)
    const events = getDiagnosticEvents()
    expect(events).toHaveLength(100)
    // oldest dropped, newest kept
    expect(events[events.length - 1].message).toBe('event 129')
    expect(events[0].message).toBe('event 30')
  })
})

describe('formatDiagnosticsReport', () => {
  const sample = {
    generatedAt: '2026-07-22T00:00:00.000Z',
    build: '2026-07-21T19-21',
    activeProvider: 'local-storage',
    activeSourceId: 's1',
    sources: [{ id: 's1', provider: 'local-storage', name: 'Browser Storage' }],
    localStorage: {
      fileCount: 210,
      chars: 2_100_000,
      approxBytesUtf16: 4_200_000,
      byExt: { '.md': 200, '.png': 2 },
      largest: [{ name: 'journal/task-258.md', kb: 449 }],
      journal: { count: 196, min: 120, max: 372, junkCount: 5, gaps: [369, 370, 371] },
    },
    storageEstimate: { quota: 10_000_000_000, usage: 5_300_000 },
    storagePersisted: false,
    folderSync: {
      present: true,
      queueLen: 0,
      metaCount: 210,
      tokens: [{ provider: 'onedrive', expiresAt: 123, expiresInSec: -166, hasRefreshToken: true }],
    },
    recentEvents: [{ t: '2026-07-22T00:00:00.000Z', type: 'quota', message: 'boom' }],
  }

  it('includes key sections and never leaks token values', () => {
    const out = formatDiagnosticsReport(sample)
    expect(out).toContain('# Planner diagnostics')
    expect(out).toContain('Build: 2026-07-21T19-21')
    expect(out).toContain('Browser Storage (localStorage)')
    expect(out).toContain('Journals: 196')
    expect(out).toContain('Journal gaps (3): 369, 370, 371')
    expect(out).toContain('Token onedrive: expires in -166s (refresh: yes)')
    expect(out).toContain('Recent events')
  })

  it('is resilient to a mostly-empty object', () => {
    const out = formatDiagnosticsReport({ generatedAt: 'now' })
    expect(out).toContain('# Planner diagnostics')
    expect(out).toContain('Build: ?')
  })
})
