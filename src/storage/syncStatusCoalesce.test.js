import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSyncStatusCoalescer, sameSyncStatus } from './syncStatusCoalesce.js'

// Build a mapped status object shaped like storage.mapEngineStatus() output.
function status(aggregate, { onedrive = aggregate, google = 'disconnected', message = '' } = {}) {
  return {
    aggregate,
    folders: {
      local: {
        targets: {
          onedrive: { status: onedrive, message },
          google_drive: { status: google, message: '' },
        },
      },
    },
  }
}

describe('sameSyncStatus', () => {
  it('treats value-identical objects (different identity) as equal', () => {
    expect(sameSyncStatus(status('syncing'), status('syncing'))).toBe(true)
  })

  it('detects an aggregate change', () => {
    expect(sameSyncStatus(status('syncing'), status('synced'))).toBe(false)
  })

  it('detects a per-target status change even when aggregate matches', () => {
    const a = status('syncing', { onedrive: 'syncing', google: 'synced' })
    const b = status('syncing', { onedrive: 'error', google: 'synced' })
    expect(sameSyncStatus(a, b)).toBe(false)
  })

  it('detects a message change (e.g. an error string)', () => {
    const a = status('error', { message: '' })
    const b = status('error', { message: 'quota exceeded' })
    expect(sameSyncStatus(a, b)).toBe(false)
  })

  it('handles null/undefined operands', () => {
    expect(sameSyncStatus(null, status('synced'))).toBe(false)
    expect(sameSyncStatus(undefined, undefined)).toBe(true)
  })
})

describe('makeSyncStatusCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('drops value-identical churn to a single apply', () => {
    const apply = vi.fn()
    const { push } = makeSyncStatusCoalescer({ apply, delay: 800 })
    for (let i = 0; i < 20; i++) push(status('syncing'))
    expect(apply).toHaveBeenCalledTimes(1) // leading edge only; rest deduped
  })

  it('applies the first change immediately (leading edge)', () => {
    const apply = vi.fn()
    const { push } = makeSyncStatusCoalescer({ apply, delay: 800 })
    push(status('syncing'))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0].aggregate).toBe('syncing')
  })

  it('coalesces a burst of save cycles to the final state (trailing edge)', () => {
    const apply = vi.fn()
    const { push } = makeSyncStatusCoalescer({ apply, delay: 800 })
    // A flurry: syncing → synced → syncing → synced within one window.
    push(status('syncing')) // leading apply
    push(status('synced'))
    push(status('syncing'))
    push(status('synced')) // final
    expect(apply).toHaveBeenCalledTimes(1) // still just the leading edge so far
    vi.advanceTimersByTime(800)
    expect(apply).toHaveBeenCalledTimes(2) // trailing edge applies the last state
    expect(apply.mock.calls[1][0].aggregate).toBe('synced')
  })

  it('does not re-apply on the trailing edge when the burst ended where it began', () => {
    const apply = vi.fn()
    const { push } = makeSyncStatusCoalescer({ apply, delay: 800 })
    push(status('syncing')) // leading apply
    push(status('synced'))
    push(status('syncing')) // ends equal to leading state
    vi.advanceTimersByTime(800)
    expect(apply).toHaveBeenCalledTimes(1) // trailing pending equals lastApplied → skipped
  })

  it('cancel() stops a pending trailing apply', () => {
    const apply = vi.fn()
    const { push, cancel } = makeSyncStatusCoalescer({ apply, delay: 800 })
    push(status('syncing'))
    push(status('synced'))
    cancel()
    vi.advanceTimersByTime(800)
    expect(apply).toHaveBeenCalledTimes(1) // only the leading edge ran
  })
})
