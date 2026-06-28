import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SETTINGS_FILE,
  readSettings,
  readSettingsMetadata,
  writeSettings,
  __testing,
} from './settings.js'

describe('settings storage', () => {
  let files

  beforeEach(() => {
    files = new Map()
    __testing.setStorageAdapter({
      read: async (path) => files.get(path) ?? '',
      write: async (path, content) => files.set(path, content),
    })
  })

  afterEach(() => {
    __testing.setStorageAdapter(null)
  })

  it('returns defaults when settings.json does not exist', async () => {
    await expect(readSettings()).resolves.toEqual({
      version: 1,
      missionStatement: '',
    })
  })

  it('writes pretty JSON to settings.json', async () => {
    await writeSettings({ missionStatement: 'Build calm tools.' })
    expect(files.get(SETTINGS_FILE)).toBe('{\n  "missionStatement": "Build calm tools.",\n  "version": 1\n}\n')
    await expect(readSettings()).resolves.toEqual({
      version: 1,
      missionStatement: 'Build calm tools.',
    })
  })

  it('reports whether the mission key was present for one-shot migration', async () => {
    await expect(readSettingsMetadata()).resolves.toMatchObject({
      exists: false,
      hasMissionStatement: false,
    })

    files.set(SETTINGS_FILE, '{ "version": 1, "missionStatement": "" }')
    await expect(readSettingsMetadata()).resolves.toMatchObject({
      exists: true,
      hasMissionStatement: true,
      settings: { version: 1, missionStatement: '' },
    })
  })
})
