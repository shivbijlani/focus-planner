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
export function setLastPostedMessageIds(state, taskId, ids) {
  const prev = state.tasks[taskId] || {}
  const list = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : []
  state.tasks[taskId] = { ...prev, lastPostedMessageIds: list.length ? list : undefined }
  return state
}

// Monotonic count of user replies folded into this task, ever.
//
// This is the collapse boundary (#278), and it exists because `userEngaged`
// answers a DIFFERENT question. `userEngaged` means "the user is owed an
// answer" and is consumed the moment any turn goes out — including a turn that
// was authored before their message existed. Read as a collapse guard it
// therefore means "did a post happen since", not "was this message answered",
// and `run-telegram-mirror.ps1` runs sync-down then once in a single pass, so
// the two are routinely different things.
//
// A counter cannot be consumed by a post. Comparing it against the value
// captured when the ids were posted (`lastPostedReplyCount`) answers exactly
// the right question — "has a reply landed since those ids went out?" — and
// gives the same answer every time it is asked, which is what observation 2 in
// #278 (same task, no reply, opposite outcome) was missing.
export function bumpReplyCount(state, taskId) {
  const prev = state.tasks[taskId] || {}
  const next = (Number.isInteger(prev.replyCount) ? prev.replyCount : 0) + 1
  state.tasks[taskId] = { ...prev, replyCount: next }
  return state
}

export function getReplyCount(state, taskId) {
  const task = state.tasks[taskId]
  return task && Number.isInteger(task.replyCount) ? task.replyCount : 0
}

// Snapshot, taken when a turn is posted, of the two facts a later collapse has
// to check before it may delete that turn:
//
//   replyCount — how many replies had been folded at post time. If it has moved
//                since, the user has spoken and the turn is frozen forever.
//   links      — the URLs that turn carried. Collapsing is only lossless if the
//                replacement still carries them, so a turn holding a link the
//                new one drops is kept rather than deleted (#278 observation 1
//                lost a YouTube link exactly this way).
export function setLastPostedContext(state, taskId, { replyCount, links } = {}) {
  const prev = state.tasks[taskId] || {}
  const list = Array.isArray(links) ? links.filter((l) => typeof l === 'string' && l) : []
  state.tasks[taskId] = {
    ...prev,
    lastPostedReplyCount: Number.isInteger(replyCount) ? replyCount : 0,
    lastPostedLinks: list.length ? list : undefined,
  }
  return state
}

// The catch-up link message for a task (#424): which doc it points at, and the
// Telegram message id it was posted as.
//
// WHY THE MESSAGE ID LIVES HERE AND THE DOC ID DOES NOT.
// #424 says the suppression state "belongs with the doc binding in #423, not in
// a second store", and that is respected: the bridge never decides which doc a
// task has — it READS the `<!-- doc-meta ... -->` stamp #423 writes. What is
// kept here is the half #423 cannot know, because it is Telegram's: the id of
// the message the link went out as. `docId` is stored alongside it only so a
// REBINDING is detectable — if the stamp now names a different doc, the old link
// message is stale and must be replaced rather than left pointing at the wrong
// document.
//
// This is NOT the "already posted, therefore stay quiet" flag by itself. On its
// own it would make silence and success identical: a link that was deleted, or
// whose send failed, would leave the task permanently quiet with no trace. The
// id is a place to PROBE, not a promise — see verifyLinkMessage in bridge.js.
export function setDocLink(state, taskId, { docId, messageId } = {}) {
  const prev = state.tasks[taskId] || {}
  state.tasks[taskId] = {
    ...prev,
    docLinkDocId: docId || undefined,
    docLinkMessageId: Number.isInteger(messageId) ? messageId : undefined,
  }
  return state
}

// The last short exception line (a blocking ask, or a terminal state change)
// delivered for a task in link mode. Hashed, so an unchanged ask is not re-sent
// every run — the whole point of #424 is that the steady state is silent, and an
// exception that repeats itself nightly is just the old behaviour wearing a
// smaller hat.
//
// The MESSAGE ID is kept beside the hash so a CHANGED ask can replace the notice
// already in the topic instead of stacking a second one under it. Storing only the
// hash made "say it once" true per ask and false per topic: three runs with three
// slightly different asks left three messages, which is the stack this whole
// feature exists to remove, arriving through the one path still allowed to post.
// A hash can prove a notice was sent; only an id can go back and change it.
export function setDocLinkNoticeHash(state, taskId, hash, messageId) {
  const prev = state.tasks[taskId] || {}
  state.tasks[taskId] = {
    ...prev,
    docLinkNoticeHash: hash || undefined,
    // Cleared together with the hash. An id kept after the ask was resolved points
    // at a message that no longer represents anything, and editing it later would
    // silently rewrite a line Shiv has already read and acted on.
    docLinkNoticeMessageId: hash && Number.isInteger(messageId) ? messageId : undefined,
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
