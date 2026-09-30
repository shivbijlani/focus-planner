import { describe, it, expect } from 'vitest'
import { planProviderPush, syncStateKeysForProvider, pendingKey, seededKey } from './reconcile.js'

const isSidecar = (n) => n.endsWith('.sync.json')
const isRecordFile = (n) => n === 'planner.md' || n === 'planner-completed.md'

// Regression for the live plannermd.com test (2026-09-30): with OneDrive and
// Google Drive both connected, a new task reached OneDrive but never Google
// Drive, because the single shared dirty queue was dequeued by whichever
// provider synced first. Each provider now gets its own pending list.
describe('planProviderPush', () => {
  it('gives every provider each queued edit (the queue is fanned out, not shared)', () => {
    const queued = ['planner.md', 'journal/task-5.md']
    const onedrive = planProviderPush({ queued, isRecordFile, isSidecar })
    const google = planProviderPush({ queued, isRecordFile, isSidecar })
    expect(onedrive).toEqual(['planner.md', 'journal/task-5.md'])
    expect(google).toEqual(onedrive)
  })

  it('keeps names a provider has not pushed yet across cycles and dedupes them', () => {
    const out = planProviderPush({
      pending: ['journal/task-1.md', 'planner.md'],
      queued: ['planner.md', 'journal/task-2.md'],
      isRecordFile,
      isSidecar,
    })
    expect(out).toEqual(['planner.md', 'journal/task-2.md', 'journal/task-1.md'])
  })

  it('seeds a full local snapshot on first contact, boards first and junk last', () => {
    const out = planProviderPush({
      queued: ['journal/task-9.md'],
      seed: ['journal/paper/task-3.html', 'journal/task-1.md', 'planner-completed.md', 'planner.md', 'planner.md.sync.json', 'AGENTS.md'],
      isRecordFile,
      isSidecar,
    })
    expect(out).toEqual([
      'planner-completed.md',
      'planner.md',
      'journal/task-9.md',
      'journal/task-1.md',
      'AGENTS.md',
      'journal/paper/task-3.html',
    ])
  })

  it('drops sidecars and names no remote can hold', () => {
    const out = planProviderPush({
      queued: ['planner.md.sync.json', 's2:focus-plan.md'.replace(':', '/../'), 'ok.md', ''],
      isRecordFile,
      isSidecar,
    })
    expect(out).toEqual(['ok.md'])
  })

  it('returns nothing when there is nothing to do', () => {
    expect(planProviderPush()).toEqual([])
  })
})

describe('syncStateKeysForProvider', () => {
  it('selects one provider\'s mtimes, pending list and seed marker only', () => {
    const keys = [
      'mtime:google-drive:planner.md',
      'mtime:onedrive:planner.md',
      pendingKey('google-drive'),
      pendingKey('onedrive'),
      seededKey('google-drive'),
      'local:planner.md',
    ]
    expect(syncStateKeysForProvider(keys, 'google-drive').sort()).toEqual([
      'mtime:google-drive:planner.md',
      'pending:google-drive',
      'seeded:google-drive',
    ])
  })
})
