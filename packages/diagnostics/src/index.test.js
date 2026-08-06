import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearDiagnostics,
  diag,
  dumpDiagnostics,
  enableDiagnostics,
  registerDiagSink,
  resetDiagnosticsForTests,
  setDiagnosticsLimit,
  unregisterDiagSink,
} from './index.js'

describe('diagnostics', () => {
  beforeEach(() => {
    resetDiagnosticsForTests()
    unregisterDiagSink('console')
    clearDiagnostics()
  })

  it('is a cheap no-op when disabled', () => {
    const seen = []
    registerDiagSink('test', (item) => seen.push(item))

    expect(diag('sync', 'event', { id: 1 })).toBe(false)

    expect(seen).toEqual([])
    expect(dumpDiagnostics()).toEqual([])
  })

  it('fans out enabled events to every registered sink', () => {
    const a = []
    const b = []
    registerDiagSink('a', (item) => a.push(item))
    registerDiagSink('b', (item) => b.push(item))
    enableDiagnostics({ persist: false })

    expect(diag('folder-sync.merge', 'record-decision', { id: 'r1' })).toBe(true)

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].channel).toBe('folder-sync.merge')
    expect(a[0].event).toBe('record-decision')
    expect(a[0].fields).toEqual({ id: 'r1' })
  })

  it('keeps the CDP buffer bounded as a ring', () => {
    setDiagnosticsLimit(2)
    enableDiagnostics({ persist: false })

    diag('sync', 'one')
    diag('sync', 'two')
    diag('sync', 'three')

    expect(dumpDiagnostics().map((item) => item.event)).toEqual(['two', 'three'])
  })
})
