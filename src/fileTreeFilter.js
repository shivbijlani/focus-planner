/**
 * Prunes a provider file tree down to just the files the planner cares about,
 * so the sidebar doesn't drown in noise (renumber backups, cycle snapshots,
 * build output, stray notes, legacy focus-plan.md duplicates, etc.).
 *
 * Kept (per source root):
 *  - The curated core files, by basename: planner.md, planner-completed.md
 *    (see CARED_ABOUT_FILES).
 *  - The `journal/` directory and its per-task journals (task-<n>.md).
 *
 * Dropped:
 *  - EVERY other directory, regardless of its contents. A folder such as
 *    `connect2026.1/`, `2026-cycle-3/`, `dist/`, `outputs/`, or
 *    `_backup_renumber_…/` is hidden even if it holds its own copy of a core
 *    file — the sidebar only surfaces the source's own top-level plan files.
 *  - Any loose `.md` not in the allow-list (e.g. focus-plan.md,
 *    6-week-cycle-plan.md, agent-email-setup.md).
 *
 * The tree shape is the provider shape: { name, type: 'file'|'directory',
 * path, children? }. This operates on the UNPREFIXED tree (basenames), so it is
 * applied before any multi-source `sourceId::` path prefixing.
 */
import { PLAN_FILE, COMPLETED_FILE } from './config/branding.js'

export const CARED_ABOUT_FILES = new Set([PLAN_FILE, COMPLETED_FILE])

const JOURNAL_DIR = 'journal'
const JOURNAL_FILE_RE = /^task-\d+\.md$/i

export function filterPlannerTree(items) {
  const out = []
  for (const item of items || []) {
    if (item.type === 'directory') {
      // The only directory we surface is the journal folder (task files only).
      if (item.name === JOURNAL_DIR) {
        const children = (item.children || []).filter(
          (c) => c.type === 'file' && JOURNAL_FILE_RE.test(c.name)
        )
        if (children.length) out.push({ ...item, children })
      }
      // Every other directory is dropped wholesale.
      continue
    }

    if (item.type === 'file' && CARED_ABOUT_FILES.has(item.name)) {
      out.push(item)
    }
  }
  return out
}
