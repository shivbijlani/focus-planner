// Filesystem layer: journal in, paper out. Kept apart from `paper.js`/`render.js`
// so the transform stays pure and unit-testable without touching a disk.

import fs from 'node:fs'
import path from 'node:path'
import { buildPaper } from './paper.js'
import { renderPaper } from './render.js'
import { readSharedWriter } from './comment.js'

const JOURNAL_RE = /^task-(\d+)\.md$/i

// Papers go in a SUBFOLDER, not beside the journals. The planner app and several
// sweeps enumerate `journal\` and key off `task-<id>.md`; dropping a second file per
// task into that folder invites a reader somewhere to pick up the wrong one. A
// subfolder is unambiguous and makes the whole feature deletable in one step, which
// is what "additive, revertible" has to mean in practice.
export const PAPER_DIRNAME = 'paper'

export function paperFilename(taskId) {
  return `task-${taskId}.html`
}

/** Deep-link back to the Telegram topic, if the journal carries a `tg-meta` stamp. */
function telegramHrefFrom(content) {
  const m = /<!--\s*tg-meta\s+chatId=(-?\d+)\s+threadId=(\d+)/.exec(String(content ?? ''))
  if (!m) return null
  // Supergroup ids are `-100<internal>`; the t.me/c/ form wants the internal part.
  const internal = m[1].replace(/^-100/, '')
  return `https://t.me/c/${internal}/${m[2]}`
}

/**
 * Generate one paper. Returns `{ taskId, outPath, written, reason, bytes }`.
 *
 * `written: false` with `reason: 'unchanged'` is the normal steady state and is the
 * whole reason this is safe to run every night: rendering is deterministic, so an
 * untouched task produces byte-identical HTML and nothing is rewritten. Without that
 * property, regenerating would churn every file in OneDrive on every run and destroy
 * the only signal that matters -- whether the task actually moved.
 */
export function generatePaper(journalPath, { outDir = null, fsImpl = fs, writerSource = undefined } = {}) {
  const filename = path.basename(journalPath)
  const m = JOURNAL_RE.exec(filename)
  const taskId = m ? m[1] : null
  const content = fsImpl.readFileSync(journalPath, 'utf8')

  const paper = buildPaper(content, { taskId })
  const html = renderPaper(paper, {
    journalHref: path.posix.join('..', filename),
    telegramHref: telegramHrefFrom(content),
    // Read once per call unless the caller hoisted it (`generateAll` does, so a
    // 237-journal sweep reads the shared writer once rather than 237 times).
    writerSource: writerSource === undefined ? readSharedWriter() : writerSource,
  })

  const dir = outDir || path.join(path.dirname(journalPath), PAPER_DIRNAME)
  const outPath = path.join(dir, paperFilename(taskId || path.parse(filename).name))

  let existing = null
  try {
    existing = fsImpl.readFileSync(outPath, 'utf8')
  } catch {
    existing = null
  }
  if (existing === html) {
    return { taskId, outPath, written: false, reason: 'unchanged', bytes: Buffer.byteLength(html) }
  }

  fsImpl.mkdirSync(dir, { recursive: true })
  fsImpl.writeFileSync(outPath, html, 'utf8')
  return {
    taskId,
    outPath,
    written: true,
    reason: existing === null ? 'created' : 'updated',
    bytes: Buffer.byteLength(html),
  }
}

/**
 * Generate papers for every journal in `journalDir`.
 *
 * `onlyWithAgentBlock` (default) skips journals the agent has never written to:
 * a paper whose entire content is "no agent turn yet" is noise, and the point of
 * the format is to explain work that HAS happened.
 */
export function generateAll(journalDir, {
  outDir = null,
  fsImpl = fs,
  taskIds = null,
  onlyWithAgentBlock = true,
  writerSource = undefined,
} = {}) {
  const wanted = taskIds ? new Set(taskIds.map(String)) : null
  // Hoisted so a full sweep reads the shared writer once. Deliberately the REAL fs,
  // never `fsImpl`: the writer is a repo source file, not a file in the planner
  // folder the caller is sweeping, so a test's in-memory folder must not be asked
  // for it. A failure here must be loud, not silent — a paper generated without it
  // has no comment box, and the channel would go quiet with nothing to notice.
  const writer = writerSource === undefined ? readSharedWriter() : writerSource
  const results = []
  const entries = fsImpl.readdirSync(journalDir)
  for (const name of entries.slice().sort(compareJournalNames)) {
    const m = JOURNAL_RE.exec(name)
    if (!m) continue
    if (wanted && !wanted.has(m[1])) continue
    const full = path.join(journalDir, name)
    try {
      if (onlyWithAgentBlock) {
        const content = fsImpl.readFileSync(full, 'utf8')
        if (!/^\s{0,3}##\s*\u{1F319}/mu.test(content)) {
          results.push({ taskId: m[1], written: false, reason: 'no-agent-turn' })
          continue
        }
      }
      results.push(generatePaper(full, { outDir, fsImpl, writerSource: writer }))
    } catch (err) {
      // One unreadable journal must never abort the sweep -- these run unattended.
      results.push({ taskId: m[1], written: false, reason: 'error', error: String(err.message || err) })
    }
  }
  return results
}

function compareJournalNames(a, b) {
  const na = Number(JOURNAL_RE.exec(a)?.[1] ?? 0)
  const nb = Number(JOURNAL_RE.exec(b)?.[1] ?? 0)
  return na - nb || a.localeCompare(b)
}
