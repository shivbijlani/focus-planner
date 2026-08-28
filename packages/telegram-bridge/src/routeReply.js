// Route a free-form Telegram reply to the task journal(s) it answers.
//
// Why this exists
// ---------------
// syncDown originally understood exactly one shape of reply: a message posted
// *inside* a task's forum topic, routed by `message_thread_id`. Everything else
// was dropped on the floor:
//
//   if (!msg || msg.message_thread_id == null) continue
//
// But the agent also posts *cross-task* digests (the approval queue) in the
// group's General thread, and the natural way to answer those from a phone is
// one batched message:
//
//   "merge 394, 386, 407; go on 348; 432 is 4 people"
//
// General carries no `message_thread_id`, so those replies were silently
// discarded — the worst possible failure mode, because the user sees their
// message sitting in the chat and reasonably believes they answered.
//
// parseReplyRouting splits such a message into per-task segments so each answer
// lands in the journal it actually belongs to.
//
// Design notes
// ------------
// * Task IDs are validated against the journals that actually exist
//   (`knownTaskIds`). Without that check, ordinary prose in an answer —
//   "1000W", "$3,046", "slot 9225", "2026" — would be misread as task IDs and
//   scatter the reply across journals that were never mentioned.
// * A segment's text is folded in **verbatim**. The user's own words are the
//   source of truth; paraphrasing an approval is exactly the kind of helpful
//   rewrite that loses meaning.
// * Returning `[]` is meaningful: it tells the caller "this reply mentions no
//   known task", so it can fall back rather than guess.

// Task IDs on this board are 2–6 digits (e.g. 120 … 432, plus imported ids like
// 426565). Word boundaries keep us off digits embedded in words.
const TASK_ID_RE = /\b(\d{2,6})\b/g

// Split a reply into independent answers. Newlines and semicolons are the
// separators people actually reach for when batching ("merge 394; go on 348"),
// and bullet lists come through as newlines.
function splitSegments(text) {
  return text
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function idsIn(segment, known) {
  const found = []
  for (const match of segment.matchAll(TASK_ID_RE)) {
    const id = match[1]
    if (known.has(id) && !found.includes(id)) found.push(id)
  }
  return found
}

/**
 * Split a batched reply into per-task entries.
 *
 * @param {string} text            the raw reply text
 * @param {object} [options]
 * @param {string[]} [options.knownTaskIds]  task IDs that actually have journals
 * @returns {{taskId: string, text: string}[]} one entry per (task, segment);
 *          empty when the reply names no known task.
 */
export function parseReplyRouting(text, { knownTaskIds = [] } = {}) {
  if (!text || !text.trim()) return []
  const known = new Set(knownTaskIds.map(String))
  if (known.size === 0) return []

  const routed = []
  const seen = new Set()

  for (const segment of splitSegments(text)) {
    for (const taskId of idsIn(segment, known)) {
      // A segment can name several tasks ("merge 394, 386"). Each gets the
      // whole segment, which reads correctly from inside any one journal.
      const key = `${taskId}\u0000${segment}`
      if (seen.has(key)) continue
      seen.add(key)
      routed.push({ taskId, text: segment })
    }
  }

  return routed
}

/**
 * Merge the segments destined for the same task into one journal entry, so a
 * reply like "merge 394\nand also 394 needs a changelog" appends once rather
 * than twice.
 *
 * @param {{taskId: string, text: string}[]} routed
 * @returns {{taskId: string, text: string}[]}
 */
export function coalesceByTask(routed) {
  const byTask = new Map()
  for (const { taskId, text } of routed) {
    if (byTask.has(taskId)) byTask.set(taskId, `${byTask.get(taskId)}\n${text}`)
    else byTask.set(taskId, text)
  }
  return [...byTask.entries()].map(([taskId, text]) => ({ taskId, text }))
}
