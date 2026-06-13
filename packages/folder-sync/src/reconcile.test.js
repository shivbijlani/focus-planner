import { describe, it, expect } from 'vitest'
import { filesToDeleteLocally, mtimeKeysForProvider, planPlainPush, shouldPullRemote } from './reconcile.js'

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

describe('planPlainPush', () => {
  it('writes a brand-new local file (untracked, not on remote)', () => {
    expect(planPlainPush({ localContent: 'hi', tracked: false, remoteHas: false }))
      .toBe('write')
  })

  it('skips overwriting a pre-existing remote file on first contact (untracked, remote has it)', () => {
    // This is the data-loss-on-connect guard: a queued local write must not
    // clobber cloud data we have never synced.
    expect(planPlainPush({ localContent: 'local', tracked: false, remoteHas: true }))
      .toBe('skip')
  })

  it('writes an update to a file we have synced before (tracked)', () => {
    expect(planPlainPush({ localContent: 'edit', tracked: true, remoteHas: true }))
      .toBe('write')
  })

  it('deletes remote only for a file we have synced before (tracked deletion)', () => {
    expect(planPlainPush({ localContent: null, tracked: true, remoteHas: true }))
      .toBe('delete')
  })

  it('skips deleting a remote file we have never synced (untracked deletion)', () => {
    // Prevents a stale/empty local device from wiping pre-existing cloud data.
    expect(planPlainPush({ localContent: null, tracked: false, remoteHas: true }))
      .toBe('skip')
  })

  it('skips a local deletion that was never on this remote (nothing to do)', () => {
    expect(planPlainPush({ localContent: null, tracked: false, remoteHas: false }))
      .toBe('skip')
  })

  it('treats undefined local content as a deletion', () => {
    expect(planPlainPush({ localContent: undefined, tracked: true, remoteHas: true }))
      .toBe('delete')
    expect(planPlainPush({ localContent: undefined, tracked: false, remoteHas: true }))
      .toBe('skip')
  })

  it('writes an empty-string file (empty is content, not a deletion)', () => {
    expect(planPlainPush({ localContent: '', tracked: false, remoteHas: false }))
      .toBe('write')
  })
})

describe('shouldPullRemote', () => {
  it('pulls a file we have never synced (no lastSeen)', () => {
    expect(shouldPullRemote({ lastSeen: null, remoteMtime: 100, localPresent: false }))
      .toBe(true)
  })

  it('pulls when the remote is newer than last seen', () => {
    expect(shouldPullRemote({ lastSeen: 100, remoteMtime: 200, localPresent: true }))
      .toBe(true)
  })

  it('pulls when up-to-date by mtime but the local copy is missing (reconnect journal bug)', () => {
    // Stale mtime left from a prior session, but the journal isn't present
    // locally — it must still be restored from the authoritative remote.
    expect(shouldPullRemote({ lastSeen: 200, remoteMtime: 200, localPresent: false }))
      .toBe(true)
  })

  it('skips when up-to-date and the local copy is present', () => {
    expect(shouldPullRemote({ lastSeen: 200, remoteMtime: 200, localPresent: true }))
      .toBe(false)
    expect(shouldPullRemote({ lastSeen: 300, remoteMtime: 200, localPresent: true }))
      .toBe(false)
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
