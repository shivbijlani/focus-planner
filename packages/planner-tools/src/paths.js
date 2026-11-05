// The complete set of Planner app-folder files these tools may touch (#836).
//
// This allowlist is the guardrail boundary: every snapshot a caller supplies,
// every write a tool plans and every request the direct Graph client sends is
// checked against it. Policy and configuration files (agent-gate.md,
// user-settings.md, AGENTS.md, settings.json, plugin/skill/MCP config, ...)
// are simply not in it, so no tool can read, write, rename or delete them.
// task-settings.json is readable only, for ID allocation parity with the UI.
import { ToolError } from './errors.js'

export const BOARD = 'planner.md'
export const BOARD_SIDECAR = 'planner.md.sync.json'
export const COMPLETED = 'planner-completed.md'
export const TASK_SETTINGS = 'task-settings.json'
export const JOURNAL_DIR = 'journal/'

const JOURNAL_RE = /^journal\/task-(\d{1,6})\.md$/

// Docs (native catch-up documents). Publisher-owned files are written only by
// the publisher code (docs_publish); review.json is app-owned and read only.
const DOC_ID = 'd-[a-z0-9]{6,40}'
export const DOCS_INDEX = 'docs/index.json'
const DOCS_PUBLISHED_RE = new RegExp(`^docs/${DOC_ID}/(?:doc\\.md|response\\.json|history/r\\d{4,6}\\.md)$`)
const DOCS_REVIEW_RE = new RegExp(`^docs/${DOC_ID}/review\\.json$`)
const DOCS_HISTORY_DIR_RE = new RegExp(`^docs/${DOC_ID}/history/$`)

export function journalPath(taskId) {
  return `journal/task-${taskId}.md`
}

export function isListing(name) {
  return name === JOURNAL_DIR || DOCS_HISTORY_DIR_RE.test(name)
}

export function isReadable(name) {
  return [BOARD, BOARD_SIDECAR, COMPLETED, TASK_SETTINGS, JOURNAL_DIR, DOCS_INDEX].includes(name) || JOURNAL_RE.test(name) ||
    DOCS_PUBLISHED_RE.test(name) || DOCS_REVIEW_RE.test(name) || DOCS_HISTORY_DIR_RE.test(name)
}

export function isWritable(name) {
  return [BOARD, BOARD_SIDECAR, COMPLETED, DOCS_INDEX].includes(name) || JOURNAL_RE.test(name) || DOCS_PUBLISHED_RE.test(name)
}

export function assertReadable(name) {
  if (typeof name !== 'string' || !isReadable(name)) {
    throw new ToolError('POLICY_DENIED', 'Planner tools only read planner.md, its sync sidecar, planner-completed.md, task-settings.json, journal/task-<id>.md and Docs files under docs/.')
  }
}

export function assertWritable(name) {
  if (typeof name !== 'string' || !isWritable(name)) {
    throw new ToolError('POLICY_DENIED', 'Planner tools only write planner.md, its sync sidecar, planner-completed.md, journal/task-<id>.md and publisher-owned Docs files. Guardrail and configuration files and the user\'s review.json are never writable.')
  }
}

/** Graph path form: every segment percent-encoded, separators kept. */
export function encodePath(name) {
  return name.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/')
}
