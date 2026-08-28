import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearDiagnostics,
  dumpDiagnostics,
  enableDiagnostics,
  resetDiagnosticsForTests,
  unregisterDiagSink,
} from '../../diagnostics/src/index.js'
import { mergeCollections } from './merge.js'
import { planMirrorSync, planPlainPush, shouldPullRemote } from './reconcile.js'

describe('sync diagnostic volume', () => {
  beforeEach(() => {
    resetDiagnosticsForTests()
    unregisterDiagSink('console')
    clearDiagnostics()
    enableDiagnostics({ persist: false })
  })

  it('does not emit a record for every unchanged mirror file', () => {
    for (let i = 0; i < 700; i++) {
      expect(planMirrorSync({
        mirrorDeleted: false,
        mirrorContent: `journal-${i}`,
        activeContent: `journal-${i}`,
      })).toBe('skip')
    }

    expect(dumpDiagnostics()).toEqual([])
  })

  it('keeps changed mirror decisions visible', () => {
    expect(planMirrorSync({
      mirrorDeleted: false,
      mirrorContent: 'new',
      activeContent: 'old',
    })).toBe('write')
    expect(planMirrorSync({
      mirrorDeleted: true,
      activeContent: 'stale',
    })).toBe('delete')

    expect(dumpDiagnostics().map((item) => item.fields.action)).toEqual(['write', 'delete'])
  })

  it('logs remote pulls but not hundreds of up-to-date skips', () => {
    for (let i = 0; i < 700; i++) {
      expect(shouldPullRemote({
        lastSeen: 200,
        remoteMtime: 200,
        localPresent: true,
      })).toBe(false)
    }
    expect(dumpDiagnostics()).toEqual([])

    expect(shouldPullRemote({
      lastSeen: 100,
      remoteMtime: 200,
      localPresent: true,
    })).toBe(true)
    expect(dumpDiagnostics()).toHaveLength(1)
    expect(dumpDiagnostics()[0].event).toBe('pull-decision')
  })

  it('does not emit a plain-push record for every first-contact skip', () => {
    for (let i = 0; i < 700; i++) {
      expect(planPlainPush({
        localContent: `journal-${i}`,
        tracked: false,
        remoteHas: true,
      })).toBe('skip')
    }

    expect(dumpDiagnostics()).toEqual([])
  })

  it('summarizes an unchanged collection instead of logging every record', () => {
    const records = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`task-${i}`, `row-${i}`]),
    )
    const meta = Object.fromEntries(
      Object.keys(records).map((id) => [id, { clock: 1, deleted: false }]),
    )

    mergeCollections({ records, meta }, { records, meta })

    const events = dumpDiagnostics()
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('collections-merged')
    expect(events[0].fields.ids).toBe(500)
  })
})
