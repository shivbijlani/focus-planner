import { readSettings, writeSettings } from './storage/settings.js'

const CHANGE_EVENT = 'fp-mission-changed'

let missionCache = ''

function emitMissionChanged(value) {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }))
  } catch {
    // No window (tests/SSR) — nothing to notify.
  }
}

// Read the cached mission statement. Call loadMissionStatement() after the
// planner storage provider is ready to hydrate this from settings.json.
export function getMissionStatement() {
  return missionCache
}

export async function loadMissionStatement() {
  try {
    const settings = await readSettings()
    missionCache = settings.missionStatement || ''
  } catch {
    missionCache = ''
  }
  emitMissionChanged(missionCache)
  return missionCache
}

// Persist the mission statement and notify listeners. Trims surrounding
// whitespace; an empty/whitespace-only value clears it.
export function setMissionStatement(value) {
  const next = (value || '').trim()
  missionCache = next
  emitMissionChanged(next)
  return readSettings()
    .then(settings => writeSettings({ ...settings, missionStatement: next }))
    .then(() => next)
    .catch(() => next)
}

// Subscribe to mission-statement changes. Fires the listener with the new value.
// Returns an unsubscribe function.
export function subscribeMissionStatement(listener) {
  const handler = (e) => listener(e?.detail ?? getMissionStatement())
  try {
    window.addEventListener(CHANGE_EVENT, handler)
    return () => window.removeEventListener(CHANGE_EVENT, handler)
  } catch {
    return () => {}
  }
}

export const __testing = {
  CHANGE_EVENT,
  resetCache() { missionCache = '' },
}
