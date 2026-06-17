/**
 * Prunes a provider file tree down to just the files the planner cares about,
 * so the sidebar doesn't drown in noise (renumber backups, stray notes, legacy
 * focus-plan.md duplicates, etc.).
 *
 * Kept rules:
 *  - The curated core files, by basename: planner.md, planner-completed.md,
 *    AGENTS.md (see CARED_ABOUT_FILES).
 *  - The `journal/` directory and its per-task journals (task-<n>.md).
 *
 * Pruned:
 *  - Any directory whose name starts with `_` or `.` (e.g. `_backup_renumber_…`,
 *    dotfolders) — even if it contains copies of the core files.
 *  - Any other loose `.md` not in the allow-list (e.g. focus-plan.md,
 *    agent-email-setup.md).
 *  - Directories left empty after pruning.
 *
 * The tree shape is the provider shape: { name, type: 'file'|'directory',
 * path, children? }. This operates on the UNPREFIXED tree (basenames), so it is
 * applied before any multi-source `sourceId::` path prefixing.
 */
import { PLAN_FILE, COMPLETED_FILE } from './config/branding.js'
import { AGENTS_FILE } from './config/agentsDoc.js'

export const CARED_ABOUT_FILES = new Set([PLAN_FILE, COMPLETED_FILE, AGENTS_FILE])

const JOURNAL_DIR = 'journal'
const JOURNAL_FILE_RE = /^task-\d+\.md$/i

function isHiddenDir(name) {
  return name.startsWith('_') || name.startsWith('.')
}

export function filterPlannerTree(items) {
  const out = []
  for (const item of items || []) {
    if (item.type === 'directory') {
      if (isHiddenDir(item.name)) continue

      if (item.name === JOURNAL_DIR) {
        const children = (item.children || []).filter(
          (c) => c.type === 'file' && JOURNAL_FILE_RE.test(c.name)
        )
        if (children.length) out.push({ ...item, children })
        continue
      }

      const children = filterPlannerTree(item.children)
      if (children.length) out.push({ ...item, children })
      continue
    }

    if (item.type === 'file' && CARED_ABOUT_FILES.has(item.name)) {
      out.push(item)
    }
  }
  return out
}
