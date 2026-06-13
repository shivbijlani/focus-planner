import { describe, it, expect } from 'vitest'
import { filesToDeleteLocally, mtimeKeysForProvider } from './reconcile.js'

const isSidecar = (n) => n.endsWith('.sync.json')
const isRecord = (n) => n === 'focus-plan.md' || n === 'focus-plan-completed.md'

describe('filesToDeleteLocally', () => {
  it('deletes a synced file that vanished from the remote listing', () => {
    const out = filesToDeleteLocally({
      candidates: ['journal/task-426550.md', 'focus-plan.md'],
      remoteNames: new Set(['focus-plan.md']),
    })
    expect(out).toEqual(['journal/task-426550.md'])
  })

  it('keeps files that are still present remotely', () => {
    const out = filesToDeleteLocally({
      candidates: ['journal/task-1.md'],
      remoteNames: new Set(['journal/task-1.md']),
    })
    expect(out).toEqual([])
  })

  it('never deletes a file with a pending local change (created/edited offline)', () => {
    const out = filesToDeleteLocally({
      candidates: ['journal/task-new.md'],
      remoteNames: new Set([]),            // not on remote yet
      pending: new Set(['journal/task-new.md']),
    })
    expect(out).toEqual([])
  })

  it('ignores sidecars and record-level files', () => {
    const out = filesToDeleteLocally({
      candidates: ['focus-plan.md', 'focus-plan.md.sync.json', 'journal/task-9.md'],
      remoteNames: new Set([]),            // remote says none of them exist
      isSidecar,
      isRecordFile: isRecord,
    })
    // record file + sidecar are excluded; only the plain journal is deleted
    expect(out).toEqual(['journal/task-9.md'])
  })

  it('deduplicates candidates from overlapping sources', () => {
    const out = filesToDeleteLocally({
      candidates: ['journal/task-2.md', 'journal/task-2.md'],
      remoteNames: new Set([]),
    })
    expect(out).toEqual(['journal/task-2.md'])
  })

  it('accepts array inputs as well as Sets', () => {
    const out = filesToDeleteLocally({
      candidates: ['a.md', 'b.md'],
      remoteNames: ['a.md'],
      pending: ['b.md'],
    })
    expect(out).toEqual([])
  })
})

describe('mtimeKeysForProvider', () => {
  const keys = [
    'mtime:onedrive:focus-plan.md',
    'mtime:onedrive:journal/task-1.md',
    'mtime:google-drive:focus-plan.md',
    'local:focus-plan.md',
    'local:journal/task-1.md',
  ]

  it('selects only the target provider\'s mtime keys', () => {
    expect(mtimeKeysForProvider(keys, 'onedrive')).toEqual([
      'mtime:onedrive:focus-plan.md',
      'mtime:onedrive:journal/task-1.md',
    ])
  })

  it('leaves other providers and non-mtime keys untouched', () => {
    expect(mtimeKeysForProvider(keys, 'google-drive')).toEqual([
      'mtime:google-drive:focus-plan.md',
    ])
  })

  it('returns empty for an unknown provider or empty input', () => {
    expect(mtimeKeysForProvider(keys, 'dropbox')).toEqual([])
    expect(mtimeKeysForProvider([], 'onedrive')).toEqual([])
    expect(mtimeKeysForProvider(undefined, 'onedrive')).toEqual([])
  })
})
