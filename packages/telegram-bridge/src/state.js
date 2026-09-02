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
//
// Raising it also bumps `foldSeq`, a monotonic count of replies folded into this
// task, because this setter is called at exactly one place: the moment a reply is
// folded. The two fields answer different questions and #278 was the cost of
// pretending they were one. `userEngaged` is a debt ("we owe this task an answer")
// and is CONSUMED when a turn goes out. `foldSeq` is a timestamp ("the user has
// spoken N times") and is never consumed, so it can still answer "has the user
// spoken since we posted message 2511?" long after the debt was settled.
export function setUserEngaged(state, taskId, engaged) {
  const prev = state.tasks[taskId] || {}
  const foldSeq = Number.isInteger(prev.foldSeq) ? prev.foldSeq : 0
  state.tasks[taskId] = {
    ...prev,
    userEngaged: !!engaged,
    foldSeq: engaged ? foldSeq + 1 : foldSeq,
  }
  return state
}

// Remember the Telegram message ids of the last agent turn we posted for a task,
// so a FOLLOWING unanswered turn can delete them instead of stacking on top (#205).
//
// Shiv, 2026-08-27: "if I haven't responded, and you are planning to post, you need
// to update the last one or delete it and post a new merged one. If I haven't
// responded, assume it's unread and can be clobbered." He raised it again on
// 2026-08-31 ("too many stacked consecutive messages on telegram"), which is what
// finally made this a code change rather than a rule the run had to remember.
//
// A LIST, not a single id: a long turn is split into an ordered run of parts by
// formatForTelegramParts, so "the last message" is genuinely several of them and
// collapsing must remove the whole run or it leaves orphaned fragments.
//
// Cleared rather than kept once consumed, so a stale id can never be re-deleted —
// deleting a message id that has been reused or already removed is the one
// irreversible mistake available here.
//
// That same property is how a turn is FROZEN (#278). When `supersedable` is
// false — the turn went out while one of the user's replies was still
// outstanding, so it may be the answer he is reading — the ids are simply not
// remembered. Freezing by forgetting rather than by a "do not delete" flag means
// no later bug can talk itself past the guard: an id we never stored cannot be
// passed to deleteMessage.
//
// `lastPostedFoldSeq` stamps the fold count at the moment these ids went out, so
// the next pass can ask "has a reply been folded since?" by comparing two stored
// numbers instead of consulting a flag another code path consumes. It is stamped
// only when something was actually sent: a run that posted nothing must not move
// the boundary forward.
export function setLastPostedMessageIds(state, taskId, ids, { foldSeq = 0, supersedable = true } = {}) {
  const prev = state.tasks[taskId] || {}
  const list = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : []
  const sent = list.length > 0
  state.tasks[taskId] = {
    ...prev,
    lastPostedMessageIds: sent && supersedable ? list : undefined,
    lastPostedFoldSeq: sent ? foldSeq : prev.lastPostedFoldSeq,
  }
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
