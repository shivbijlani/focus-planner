import * as storage from './storage.js'

export const SETTINGS_FILE = 'settings.json'

const DEFAULT_SETTINGS = {
  version: 1,
  missionStatement: '',
}

let storageAdapter = {
  read: (path) => storage.read(path),
  write: (path, content) => storage.write(path, content),
}

function normalizeSettings(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    ...input,
    version: Number.isFinite(input.version) ? input.version : DEFAULT_SETTINGS.version,
    missionStatement: typeof input.missionStatement === 'string' ? input.missionStatement : DEFAULT_SETTINGS.missionStatement,
  }
}

async function readRawSettings() {
  const raw = await storageAdapter.read(SETTINGS_FILE)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function readSettings() {
  return normalizeSettings(await readRawSettings())
}

export async function writeSettings(settings) {
  const next = normalizeSettings(settings)
  await storageAdapter.write(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export const __testing = {
  DEFAULT_SETTINGS,
  setStorageAdapter(adapter) {
    storageAdapter = adapter || {
      read: (path) => storage.read(path),
      write: (path, content) => storage.write(path, content),
    }
  },
}
