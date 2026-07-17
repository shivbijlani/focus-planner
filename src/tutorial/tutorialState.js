/**
 * Persistence for the first-run tutorial's lesson progress.
 *
 * PROTOTYPE NOTE: this stores to `localStorage` so the walkthrough is
 * deterministic and doesn't depend on a chosen storage source. For the shipped
 * version this will move into the source's `settings.json` (alongside
 * `missionStatement`) so progress travels with the user's data. The public
 * API below is deliberately storage-agnostic to make that swap trivial.
 */

import {
  normalizeLessonProgress,
  emptyLessonProgress,
  advanceLesson as advance,
} from './lessons.js'

const STORAGE_KEY = 'fp-tutorial-state'
const CHANGE_EVENT = 'fp-tutorial-changed'

function readRaw() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeRaw(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Private mode / no storage — progress is session-only, which is fine.
  }
}

function emit(state) {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: state }))
  } catch {
    // No window (tests/SSR).
  }
}

/** Full tutorial state, normalized to the current lesson schema. */
export function getTutorialState() {
  const raw = readRaw()
  return {
    version: 1,
    startedAt: raw?.startedAt || null,
    dismissed: !!raw?.dismissed,
    graduatedAt: raw?.graduatedAt || null,
    lessons: normalizeLessonProgress(raw?.lessons),
  }
}

export function saveTutorialState(state) {
  const next = {
    version: 1,
    startedAt: state.startedAt || new Date().toISOString(),
    dismissed: !!state.dismissed,
    graduatedAt: state.graduatedAt || null,
    lessons: normalizeLessonProgress(state.lessons),
  }
  writeRaw(next)
  emit(next)
  return next
}

/** Advance a lesson and persist. Returns the new full state. */
export function recordLesson(id) {
  const cur = getTutorialState()
  const lessons = advance(cur.lessons, id)
  return saveTutorialState({ ...cur, lessons })
}

export function markDismissed() {
  return saveTutorialState({ ...getTutorialState(), dismissed: true })
}

export function markGraduated() {
  return saveTutorialState({
    ...getTutorialState(),
    graduatedAt: new Date().toISOString(),
  })
}

/** Wipe progress — used by the "Restart tutorial" affordance / demos. */
export function resetTutorialState() {
  return saveTutorialState({
    startedAt: new Date().toISOString(),
    dismissed: false,
    graduatedAt: null,
    lessons: emptyLessonProgress(),
  })
}

export function subscribeTutorialState(listener) {
  const handler = (e) => listener(e?.detail ?? getTutorialState())
  try {
    window.addEventListener(CHANGE_EVENT, handler)
    return () => window.removeEventListener(CHANGE_EVENT, handler)
  } catch {
    return () => {}
  }
}

export const __testing = { STORAGE_KEY, CHANGE_EVENT }
