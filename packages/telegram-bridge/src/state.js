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

// Remember the turn hash we DECLINED to post because the task looked finished.
//
// Deliberately a separate field from `lastPostedHash`: recording a suppressed
// turn as "posted" is what made suppression permanent (#186). syncUp's
// unchanged-turn check reads `lastPostedHash` and fires BEFORE the completed
// guard, so a turn absorbed into that field could never be delivered later —
// not even once the task became eligible again. Keeping the two apart means a
// suppression is a pause, not a delete: the turn is still pending, and the day
// the task is active or the user replies, it goes out.
export function setSuppressedHash(state, taskId, hash) {
  const prev = state.tasks[taskId] || {}
  state.tasks[taskId] = { ...prev, suppressedHash: hash }
  return state
}

// Track whether a task's forum topic is currently archived (closed). Used so
// syncArchive only calls closeForumTopic/reopenForumTopic when the desired
// state actually changes — making the archive pass idempotent across runs.
export function setArchived(state, taskId, archived) {
  const prev = state.tasks[taskId] || {}
  state.tasks[taskId] = { ...prev, archived: !!archived }
  return state
}

// Remember that the user has spoken about this task since we last posted. syncUp
// stays silent on tasks that have reached the completed board, but that must not
// swallow a genuine conversation: once the user replies about a finished task,
// they are owed the agent's answer even though the task is closed. This flag is
// what distinguishes "the agent touched an old journal" from "the user reopened
// the conversation". It is cleared as soon as that answer goes out, so a closed
// task delivers exactly one agent turn per user message and cannot drift back
// into posting unprompted.
export function setUserEngaged(state, taskId, engaged) {
  const prev = state.tasks[taskId] || {}
  state.tasks[taskId] = { ...prev, userEngaged: !!engaged }
  return state
}

export function setOffset(state, offset) {
  state.updateOffset = offset
  return state
}

// Content hash of the last "waiting on you" digest we posted. Stored so an
// unchanged approval queue is not re-posted on every run — the digest is meant
// to fire every run, which is only tolerable if a no-change run stays silent.
export function setLastDigest(state, hash) {
  state.lastDigestHash = hash
  return state
}

// Remember the forum topic the digest is posted into, when the user has asked
// for a dedicated topic by NAME rather than by id. Persisting the resolved id
// is what makes that safe to re-run: without it, every night would create
// another "Waiting on you" topic. The name is stored alongside so that renaming
// the setting is detected and resolved to a fresh topic rather than silently
// continuing to post into the old one.
export function setDigestTopic(state, topicId, name) {
  state.digestTopicId = topicId
  state.digestTopicName = name
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
