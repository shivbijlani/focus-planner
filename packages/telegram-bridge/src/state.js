// Persistent bridge state: which task maps to which forum topic, the last
// agent message we posted per task (so we don't repost), and the Telegram
// getUpdates offset (so we don't reprocess replies). Stored as JSON outside
// the repo and outside OneDrive (see config.stateDir).

import fs from 'fs/promises'
import path from 'path'

export const STATE_VERSION = 1

export function emptyState() {
  return { version: STATE_VERSION, updateOffset: 0, tasks: {} }
}

export function getTask(state, taskId) {
  return state.tasks[taskId] || null
}

export function setTopic(state, taskId, topicId, name) {
  const prev = state.tasks[taskId] || {}
  state.tasks[taskId] = { ...prev, topicId, name }
  return state
}

export function setLastPosted(state, taskId, hash) {
  const prev = state.tasks[taskId] || {}
  state.tasks[taskId] = { ...prev, lastPostedHash: hash }
  return state
}

export function setOffset(state, offset) {
  state.updateOffset = offset
  return state
}

/** Reverse lookup: which task owns a given forum topic id. */
export function findTaskByTopic(state, topicId) {
  for (const [taskId, entry] of Object.entries(state.tasks)) {
    if (entry.topicId === topicId) return taskId
  }
  return null
}

const STATE_FILE = 'state.json'

export async function loadState(stateDir) {
  try {
    const raw = await fs.readFile(path.join(stateDir, STATE_FILE), 'utf-8')
    const parsed = JSON.parse(raw)
    return { ...emptyState(), ...parsed, tasks: parsed.tasks || {} }
  } catch {
    return emptyState()
  }
}

export async function saveState(stateDir, state) {
  await fs.mkdir(stateDir, { recursive: true })
  await fs.writeFile(
    path.join(stateDir, STATE_FILE),
    JSON.stringify(state, null, 2),
    'utf-8',
  )
}
