import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  TASK_SETTINGS_FILE,
  DEFAULT_TASK_SETTINGS,
  normalizeTaskSettingsFile,
  parseTaskSettingsFile,
  serializeTaskSettingsFile,
  getTaskSettings,
  withTaskSetting,
  moveTaskSettingsEntries,
  readTaskSettings,
  writeTaskSettings,
  setTaskSetting,
  __testing,
} from './taskSettings.js'

describe('taskSettings storage', () => {
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

  describe('pure helpers', () => {
    it('normalizes a missing/empty file to version 1 with no tasks', () => {
      expect(normalizeTaskSettingsFile(undefined)).toEqual({ version: 1, tasks: {} })
      expect(normalizeTaskSettingsFile(null)).toEqual({ version: 1, tasks: {} })
      expect(normalizeTaskSettingsFile({})).toEqual({ version: 1, tasks: {} })
    })

    it('coerces malformed per-task entries to defaults', () => {
      const normalized = normalizeTaskSettingsFile({ tasks: { '379': null, '400': 'nope', '401': [] } })
      expect(normalized.tasks['379']).toEqual(DEFAULT_TASK_SETTINGS)
      expect(normalized.tasks['400']).toEqual(DEFAULT_TASK_SETTINGS)
      expect(normalized.tasks['401']).toEqual(DEFAULT_TASK_SETTINGS)
    })

    it('preserves unknown per-task keys for forward compatibility', () => {
      const normalized = normalizeTaskSettingsFile({
        tasks: { '379': { aiAssisted: true, model: 'claude-sonnet-5' } },
      })
      expect(normalized.tasks['379']).toEqual({
        aiAssisted: true,
        persistentSession: false,
        model: 'claude-sonnet-5',
      })
    })

    it('parseTaskSettingsFile tolerates missing/corrupt JSON', () => {
      expect(parseTaskSettingsFile('')).toEqual({ version: 1, tasks: {} })
      expect(parseTaskSettingsFile(null)).toEqual({ version: 1, tasks: {} })
      expect(parseTaskSettingsFile('{not json')).toEqual({ version: 1, tasks: {} })
    })

    it('serializeTaskSettingsFile writes pretty, normalized JSON with a trailing newline', () => {
      const out = serializeTaskSettingsFile({ tasks: { '379': { aiAssisted: true } } })
      expect(out.endsWith('\n')).toBe(true)
      expect(JSON.parse(out)).toEqual({
        version: 1,
        tasks: { '379': { aiAssisted: true, persistentSession: false } },
      })
    })

    it('getTaskSettings returns defaults for a task absent from the file', () => {
      expect(getTaskSettings({ version: 1, tasks: {} }, '379')).toEqual(DEFAULT_TASK_SETTINGS)
      expect(getTaskSettings(undefined, '379')).toEqual(DEFAULT_TASK_SETTINGS)
    })

    it('getTaskSettings returns a task entry merged with defaults', () => {
      const file = { version: 1, tasks: { '379': { aiAssisted: true } } }
      expect(getTaskSettings(file, '379')).toEqual({ aiAssisted: true, persistentSession: false })
    })

    it('withTaskSetting merges a patch into an existing entry without mutating the input', () => {
      const file = normalizeTaskSettingsFile({ tasks: { '379': { aiAssisted: true } } })
      const next = withTaskSetting(file, '379', { persistentSession: true })
      expect(next.tasks['379']).toEqual({ aiAssisted: true, persistentSession: true })
      // Original untouched.
      expect(file.tasks['379']).toEqual({ aiAssisted: true, persistentSession: false })
    })

    it('withTaskSetting creates a new entry (with defaults) for a task not yet in the file', () => {
      const next = withTaskSetting({ version: 1, tasks: {} }, '379', { aiAssisted: true })
      expect(next.tasks['379']).toEqual({ aiAssisted: true, persistentSession: false })
    })

    it('moves settings to renumbered target IDs without disturbing unrelated entries', () => {
      const result = moveTaskSettingsEntries(
        { tasks: { '10': { aiAssisted: true }, '11': { persistentSession: true } } },
        { tasks: { '20': { aiAssisted: true } } },
        new Map([['10', '21']]),
      )
      expect(result.source.tasks).toEqual({
        '11': { aiAssisted: false, persistentSession: true },
      })
      expect(result.target.tasks).toEqual({
        '20': { aiAssisted: true, persistentSession: false },
        '21': { aiAssisted: true, persistentSession: false },
      })
    })

    it('withTaskSetting leaves other tasks in the file untouched', () => {
      const file = normalizeTaskSettingsFile({
        tasks: { '379': { aiAssisted: true }, '400': { persistentSession: true } },
      })
      const next = withTaskSetting(file, '379', { persistentSession: true })
      expect(next.tasks['400']).toEqual({ aiAssisted: false, persistentSession: true })
    })
  })

  describe('active-source read/write', () => {
    it('returns an empty, normalized file when task-settings.json does not exist', async () => {
      await expect(readTaskSettings()).resolves.toEqual({ version: 1, tasks: {} })
    })

    it('treats a provider NotFoundError as a fresh settings file', async () => {
      __testing.setStorageAdapter({
        read: async () => {
          const error = new Error('missing')
          error.name = 'NotFoundError'
          throw error
        },
        write: async (path, content) => files.set(path, content),
      })
      await expect(readTaskSettings()).resolves.toEqual({ version: 1, tasks: {} })
    })

    it('writeTaskSettings then readTaskSettings round-trips', async () => {
      await writeTaskSettings({ tasks: { '379': { aiAssisted: true, persistentSession: false } } })
      expect(files.get(TASK_SETTINGS_FILE)).toContain('"379"')
      await expect(readTaskSettings()).resolves.toEqual({
        version: 1,
        tasks: { '379': { aiAssisted: true, persistentSession: false } },
      })
    })

    it('setTaskSetting performs a read-modify-write for a single task', async () => {
      await writeTaskSettings({ tasks: { '379': { aiAssisted: true } } })
      const result = await setTaskSetting('379', { persistentSession: true })
      expect(result.tasks['379']).toEqual({ aiAssisted: true, persistentSession: true })
      await expect(readTaskSettings()).resolves.toEqual(result)
    })

    it('setTaskSetting on a fresh file creates the task entry with defaults merged in', async () => {
      const result = await setTaskSetting('379', { aiAssisted: true })
      expect(result.tasks['379']).toEqual({ aiAssisted: true, persistentSession: false })
    })

    it('setTaskSetting does not disturb other tasks already recorded', async () => {
      await writeTaskSettings({ tasks: { '400': { aiAssisted: true, persistentSession: true } } })
      await setTaskSetting('379', { aiAssisted: true })
      const file = await readTaskSettings()
      expect(file.tasks['400']).toEqual({ aiAssisted: true, persistentSession: true })
      expect(file.tasks['379']).toEqual({ aiAssisted: true, persistentSession: false })
    })

    it('serializes concurrent toggles so neither update is lost', async () => {
      let raw = ''
      __testing.setStorageAdapter({
        read: async () => raw,
        write: async (_path, content) => {
          await new Promise(resolve => setTimeout(resolve, 5))
          raw = content
        },
      })
      await Promise.all([
        setTaskSetting('379', { aiAssisted: true }),
        setTaskSetting('379', { persistentSession: true }),
      ])
      await expect(readTaskSettings()).resolves.toEqual({
        version: 1,
        tasks: { '379': { aiAssisted: true, persistentSession: true } },
      })
    })

    it('refuses to overwrite a malformed existing sidecar', async () => {
      files.set(TASK_SETTINGS_FILE, '{not json')
      await expect(setTaskSetting('379', { aiAssisted: true }))
        .rejects.toThrow('existing file is not valid JSON')
      expect(files.get(TASK_SETTINGS_FILE)).toBe('{not json')
    })

    it('refuses to overwrite a valid JSON document with a malformed schema', async () => {
      files.set(TASK_SETTINGS_FILE, '{"version":1,"tasks":[]}')
      await expect(setTaskSetting('379', { aiAssisted: true }))
        .rejects.toThrow('must contain a "tasks" object')
      expect(files.get(TASK_SETTINGS_FILE)).toBe('{"version":1,"tasks":[]}')
    })
  })
})
