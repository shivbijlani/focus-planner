// The comment channel: how a note typed into a paper becomes an instruction the
// agent reads (issue #286, second half).
//
// THE REQUIREMENT, which is load-bearing rather than a nicety. Shiv: "we will need a
// way for me to add comments. When continuing a task, you will have to read my
// comments because I might instruct there instead of journal or telegram."
//
// THE DESIGN, in one sentence: a comment is not stored anywhere new -- it is appended
// to the task's own journal, by the app's own writer, as an ordinary attributed user
// message.
//
// Everything the issue asks for then falls out of that single choice instead of being
// built:
//
//   - "Where do comments live such that they SURVIVE REGENERATION?" In the journal.
//     The paper is a pure function of the journal, so the next regeneration renders
//     the comment under "Your instructions". A comment cannot be clobbered by the
//     regeneration because it is not in the file being regenerated.
//   - "How does the agent detect NEW ones (reuse `oa-state.ps1`'s reopen model rather
//     than inventing a second one)?" It already does. `mark` stamps a turn-end
//     boundary and snapshots the journal hash; text appearing after that boundary is
//     `reopened: true` on the next `scan`. A comment is that text. Zero new detection.
//   - "CONSENT implications ... the consent reader has to understand that channel too,
//     or it becomes a way to approve irreversible actions that the fail-closed reader
//     cannot see." It reads it already, for the same reason: the bytes are a normal
//     `<!-- from: me -->` message, byte-identical to what the app and the Telegram
//     bridge write. There is no fourth shape to teach anybody.
//
// WHY THE WRITER IS EMBEDDED VERBATIM RATHER THAN REIMPLEMENTED. #325 established that
// these journals already have four writers, and that the expensive failures come from
// two of them disagreeing about who wrote something -- a typed approval that reads as
// SILENCE, indistinguishable from never replying. #400's own build surfaced another:
// building a third consumer on the shared readers immediately exposed a turn-splitting
// defect neither had shown. So a comment channel must be a fifth writer taught to the
// SHARED reader, not a second bespoke parser.
//
// Taken literally, that means the page must run the same `appendJournalMessage` the
// app runs -- not a port of it. `src/journalChat.js` is dependency-free (zero imports),
// so the whole file is inlined into the paper's `<script type="module">` at generation
// time, read from disk, never transcribed. An inline module script tolerates the
// `export` declarations (verified in Edge 152 on a `file://` origin), so the bytes need
// no transformation at all and `assertEmbedsSharedWriterVerbatim` can hold the embed
// byte-identical to the source. If the two ever drift, a test fails rather than a
// user's approval going quiet.
//
// WHY THE FILE SYSTEM ACCESS API. Measured on the live setup rather than assumed: on a
// `file://` origin Edge 152 reports `isSecureContext: true` and exposes
// `showDirectoryPicker`, and IndexedDB persists across pages because every `file://`
// document shares one origin. That last property is what makes this usable instead of
// a chore: the folder is granted ONCE and all 237 papers can then write, rather than
// each paper asking separately.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The app's journal writer/reader. The one implementation, shared by every surface. */
export const SHARED_WRITER_PATH = path.resolve(HERE, '..', '..', '..', 'src', 'journalChat.js')

/**
 * Read the shared writer's source verbatim.
 *
 * Refuses on a source that would break out of the `<script>` element. Embedding is
 * byte-exact by design, so escaping is not an option -- the only safe response is to
 * fail loudly at generation time rather than emit a paper whose comment box silently
 * does nothing.
 */
export function readSharedWriter(fsImpl = fs, sourcePath = SHARED_WRITER_PATH) {
  const src = fsImpl.readFileSync(sourcePath, 'utf8')
  if (/<\/script/i.test(src)) {
    throw new Error(
      `${path.basename(sourcePath)} contains "</script", which cannot be embedded verbatim in a paper`,
    )
  }
  return src
}

/** True when `html` embeds `writerSource` byte-for-byte. Used by the drift test. */
export function assertEmbedsSharedWriterVerbatim(html, writerSource) {
  return String(html).includes(writerSource)
}

export function journalFilename(taskId) {
  return `task-${taskId}.md`
}

// The controller. Deliberately small: all journal semantics live in the embedded
// shared writer above it, and this only moves bytes between a textarea and a file.
//
// The append-only guard is the important line. `createWritable()` truncates and
// rewrites the whole file, so a bug that produced a short string would destroy a
// journal rather than fail. `appendJournalMessage` only ever appends to the
// whitespace-trimmed original, so anything that is NOT an append is a defect by
// definition and is refused before the handle is opened. A comment is worth losing;
// a journal is not.
const CONTROLLER = `
const OA_DB = 'oa-paper-comments'
const OA_STORE = 'handles'
const OA_KEY = 'journalDir'

// Whether this browser can write files at all. Named rather than inlined so the
// fallback path has one anchor a mutation test can remove.
const OA_CAN_WRITE = typeof window.showDirectoryPicker === 'function'

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OA_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(OA_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  try {
    const db = await idb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(OA_STORE, 'readonly')
      const req = tx.objectStore(OA_STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch { return null }
}

async function idbSet(key, value) {
  try {
    const db = await idb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(OA_STORE, 'readwrite')
      tx.objectStore(OA_STORE).put(value, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    return true
  } catch { return false }
}

/**
 * The journal folder handle, or null. Never prompts unless \`interactive\`, so a page
 * load can restore a previous grant silently while a click can ask for a new one.
 */
async function journalDirHandle({ interactive = false } = {}) {
  let handle = await idbGet(OA_KEY)
  if (handle) {
    const opts = { mode: 'readwrite' }
    let state = 'prompt'
    try { state = await handle.queryPermission(opts) } catch { state = 'prompt' }
    if (state === 'granted') return handle
    if (!interactive) return null
    try { state = await handle.requestPermission(opts) } catch { state = 'denied' }
    if (state === 'granted') return handle
    handle = null
  }
  if (!interactive) return null
  if (!OA_CAN_WRITE) return null
  handle = await window.showDirectoryPicker({ id: 'oa-journal', mode: 'readwrite' })
  await idbSet(OA_KEY, handle)
  return handle
}

async function saveComment(text) {
  const dir = await journalDirHandle({ interactive: true })
  if (!dir) return { ok: false, code: 'no-folder' }

  let fileHandle
  try {
    fileHandle = await dir.getFileHandle(OA_JOURNAL_FILE)
  } catch {
    return { ok: false, code: 'no-journal', detail: OA_JOURNAL_FILE }
  }

  const before = await (await fileHandle.getFile()).text()
  const after = appendJournalMessage(before, text)

  // Append-only invariant: refuse anything that is not the original plus new text.
  const trimmed = before.replace(/\\s+$/, '')
  if (!after.startsWith(trimmed) || after.length <= trimmed.length) {
    return { ok: false, code: 'not-an-append' }
  }

  const w = await fileHandle.createWritable()
  await w.write(after)
  await w.close()

  // Read back rather than trust the write: this is the user's instruction channel,
  // and a comment that silently did not land is the exact failure this whole design
  // exists to avoid.
  const verify = await (await fileHandle.getFile()).text()
  if (verify !== after) return { ok: false, code: 'verify-failed' }
  return { ok: true, bytes: after.length - before.length }
}

const els = {
  box: document.getElementById('oa-comment-text'),
  save: document.getElementById('oa-comment-save'),
  copy: document.getElementById('oa-comment-copy'),
  status: document.getElementById('oa-comment-status'),
  fallback: document.getElementById('oa-comment-fallback'),
}

function say(msg, kind) {
  if (!els.status) return
  els.status.textContent = msg
  els.status.className = 'oa-status' + (kind ? ' oa-status--' + kind : '')
}

function markdownBlock(text) {
  return '## ' + localISODate() + '\\n\\n' + FROM_ME + '\\n' + text + '\\n'
}

if (els.save && els.box) {
  if (!OA_CAN_WRITE) {
    els.save.disabled = true
    if (els.fallback) els.fallback.hidden = false
    say('This browser cannot write files, so use Copy instead and paste into the journal.', 'warn')
  }
  els.save.addEventListener('click', async () => {
    const text = els.box.value.trim()
    if (!text) { say('Nothing to save yet.', 'warn'); return }
    els.save.disabled = true
    say('Saving…')
    try {
      const res = await saveComment(text)
      if (res.ok) {
        els.box.value = ''
        say('Saved to the journal. The agent picks it up on its next run.', 'ok')
      } else if (res.code === 'no-folder') {
        if (els.fallback) els.fallback.hidden = false
        say('No folder access, so nothing was written. Use Copy and paste into the journal.', 'warn')
      } else if (res.code === 'no-journal') {
        say('Could not find ' + res.detail + ' in that folder — pick the journal folder itself.', 'warn')
      } else if (res.code === 'not-an-append') {
        say('Refused to write: the change was not a clean append. Nothing was modified.', 'warn')
      } else {
        say('Wrote the file but could not verify it. Check the journal before relying on this.', 'warn')
      }
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) say('Cancelled — nothing was written.', 'warn')
      else say('Could not save: ' + ((err && err.message) || err), 'warn')
      if (els.fallback) els.fallback.hidden = false
    } finally {
      els.save.disabled = false
    }
  })
}

if (els.copy && els.box) {
  els.copy.addEventListener('click', async () => {
    const text = els.box.value.trim()
    if (!text) { say('Nothing to copy yet.', 'warn'); return }
    try {
      await navigator.clipboard.writeText(markdownBlock(text))
      say('Copied. Paste it at the bottom of the journal and it reads exactly the same.', 'ok')
    } catch {
      say('Could not reach the clipboard — select the text above and copy it manually.', 'warn')
    }
  })
}
`.trim()

/**
 * The paper's comment `<script>`: the shared writer verbatim, then the controller.
 *
 * `taskId` is baked in as `OA_JOURNAL_FILE` so the page can only ever write to its own
 * journal -- there is no code path that names a different file.
 */
export function buildCommentScript(writerSource, { taskId }) {
  const file = journalFilename(taskId)
  return [
    '<script type="module">',
    '// --- BEGIN src/journalChat.js (embedded verbatim; see comment.js) ---',
    writerSource.replace(/\n+$/, ''),
    '// --- END src/journalChat.js ---',
    `const OA_JOURNAL_FILE = ${JSON.stringify(file)}`,
    CONTROLLER,
    '</script>',
  ].join('\n')
}

/** The comment box markup. Static and scriptless, so it degrades to a visible note. */
export function commentSectionHtml({ taskId }) {
  const file = journalFilename(taskId)
  return [
    '<section class="comment" id="comment">',
    '<h2>Leave a comment</h2>',
    '<p class="meta">Saved straight into this task\u2019s journal as a message from you, so the agent reads it ' +
      'on its next run exactly as it reads a Telegram reply. The first time, your browser asks which folder ' +
      `the journals are in \u2014 pick the <code>journal</code> folder once and every paper can use it.</p>`,
    '<textarea id="oa-comment-text" rows="4" placeholder="Type an instruction, a correction, or an approval\u2026" aria-label="Comment"></textarea>',
    '<div class="comment-actions">',
    '<button type="button" id="oa-comment-save">Save to journal</button>',
    '<button type="button" id="oa-comment-copy" class="secondary">Copy as markdown</button>',
    '<span class="oa-status" id="oa-comment-status" role="status" aria-live="polite"></span>',
    '</div>',
    `<p class="meta" id="oa-comment-fallback" hidden>Paste it at the end of <code>${file}</code>. ` +
      'The copied block already carries the date and the <code>from: me</code> marker, which is what makes an ' +
      'approval count.</p>',
    '</section>',
  ].join('\n')
}
