import { describe, expect, it } from 'vitest'

import { TARGET_STATUS, PROVIDERS, syncStatusEqual } from './storage.js'

const LOCAL_FOLDER_ID = 'browser-storage'

function status(oneDrive, googleDrive = TARGET_STATUS.DISCONNECTED, aggregate) {
  return {
    aggregate: aggregate ?? oneDrive,
    folders: {
      [LOCAL_FOLDER_ID]: {
        targets: {
          [PROVIDERS.ONEDRIVE]: { status: oneDrive, message: '' },
          [PROVIDERS.GOOGLE_DRIVE]: { status: googleDrive, message: '' },
        },
      },
    },
  }
}

describe('syncStatusEqual', () => {
  it('treats two freshly-built identical statuses as equal (dedupe case)', () => {
    // The SW re-emits status on every nudge; mapEngineStatus returns a new
    // object each time. Different references, same meaning must compare equal.
    const a = status(TARGET_STATUS.SYNCING)
    const b = status(TARGET_STATUS.SYNCING)
    expect(a).not.toBe(b)
    expect(syncStatusEqual(a, b)).toBe(true)
  })

  it('detects a changed aggregate', () => {
    expect(
      syncStatusEqual(status(TARGET_STATUS.SYNCING), status(TARGET_STATUS.SYNCED)),
    ).toBe(false)
  })

  it('detects a changed per-target status', () => {
    const a = status(TARGET_STATUS.SYNCED, TARGET_STATUS.SYNCED, TARGET_STATUS.SYNCED)
    const b = status(TARGET_STATUS.SYNCED, TARGET_STATUS.ERROR, TARGET_STATUS.SYNCED)
    expect(syncStatusEqual(a, b)).toBe(false)
  })

  it('detects a changed per-target message', () => {
    const a = status(TARGET_STATUS.ERROR)
    const b = status(TARGET_STATUS.ERROR)
    b.folders[LOCAL_FOLDER_ID].targets[PROVIDERS.ONEDRIVE].message = 'quota exceeded'
    expect(syncStatusEqual(a, b)).toBe(false)
  })

  it('ignores non-status fields like lastRemoteUpdate', () => {
    // mapEngineStatus drops lastRemoteUpdate, but guard against a caller that
    // passes extra keys: equality is defined purely over aggregate + targets.
    const a = { ...status(TARGET_STATUS.SYNCING), lastRemoteUpdate: { name: 'a', at: 1 } }
    const b = { ...status(TARGET_STATUS.SYNCING), lastRemoteUpdate: { name: 'b', at: 2 } }
    expect(syncStatusEqual(a, b)).toBe(true)
  })

  it('handles null / identity', () => {
    const a = status(TARGET_STATUS.SYNCED)
    expect(syncStatusEqual(a, a)).toBe(true)
    expect(syncStatusEqual(null, a)).toBe(false)
    expect(syncStatusEqual(a, null)).toBe(false)
  })
})
