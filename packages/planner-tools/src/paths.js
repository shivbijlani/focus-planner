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

export function journalPath(taskId) {
  return `journal/task-${taskId}.md`
}

export function isReadable(name) {
  return [BOARD, BOARD_SIDECAR, COMPLETED, TASK_SETTINGS, JOURNAL_DIR].includes(name) || JOURNAL_RE.test(name)
}

export function isWritable(name) {
  return [BOARD, BOARD_SIDECAR, COMPLETED].includes(name) || JOURNAL_RE.test(name)
}

export function assertReadable(name) {
  if (typeof name !== 'string' || !isReadable(name)) {
    throw new ToolError('POLICY_DENIED', 'Planner tools only read planner.md, its sync sidecar, planner-completed.md, task-settings.json and journal/task-<id>.md.')
  }
}

export function assertWritable(name) {
  if (typeof name !== 'string' || !isWritable(name)) {
    throw new ToolError('POLICY_DENIED', 'Planner tools only write planner.md, its sync sidecar, planner-completed.md and journal/task-<id>.md. Guardrail and configuration files are never writable.')
  }
}

/** Graph path form: every segment percent-encoded, separators kept. */
export function encodePath(name) {
  return name.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/')
}
