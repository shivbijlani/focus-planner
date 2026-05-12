/**
 * One-time rename migration: `focus-plan.md` → `planner.md` and
 * `focus-plan-completed.md` → `planner-completed.md`.
 *
 * Strategy: for every registered source, if the legacy file exists and the
 * new file does not, copy content to the new path and delete the legacy
 * one. Idempotent — safe to run on every startup; a per-source flag in
 * localStorage prevents re-running once successful.
 *
 * Storage failures (e.g. cloud reauth needed) are non-fatal: the migration
 * skips that source and tries again next startup. The user never sees
 * data loss because we only delete the legacy file after a successful
 * write of the new file.
 *
 * For the ACTIVE source we route writes/deletes through storage.write/remove
 * so folder-sync picks up the changes and propagates them to OneDrive /
 * Google Drive (otherwise the cloud copies would still hold legacy names
 * until the user manually edited each file).
 */
import { PLAN_FILE, COMPLETED_FILE, LEGACY_PLAN_FILE, LEGACY_COMPLETED_FILE } from '../config/branding.js'

const RENAME_FLAG_PREFIX = 'fp-rename-v1:'

const RENAMES = [
  [LEGACY_PLAN_FILE, PLAN_FILE],
  [LEGACY_COMPLETED_FILE, COMPLETED_FILE],
]

function flagKey(sourceId) {
  return RENAME_FLAG_PREFIX + sourceId
}

/**
 * Run the rename migration against a provider.
 *
 * @param {string}   sourceId   Source id (used for the idempotency flag).
 * @param {object}   provider   Provider with read/write/remove.
 * @param {object}  [syncedIO]  Optional. When set, write/remove calls go
 *                              through these (typically storage.write /
 *                              storage.remove) so folder-sync picks up
 *                              the changes and pushes them to sync targets.
 * @returns {Promise<boolean>}  True when everything migrated cleanly.
 */
export async function migrateProviderFileNames(sourceId, provider, syncedIO = null) {
  if (localStorage.getItem(flagKey(sourceId)) === 'done') return true
  if (!provider) return false

  const write = syncedIO?.write ?? ((p, c) => provider.write(p, c))
  const remove = syncedIO?.remove ?? (provider.remove ? (p => provider.remove(p)) : null)

  let allOk = true
  for (const [oldPath, newPath] of RENAMES) {
    try {
      const newContent = await safeRead(provider, newPath)
      if (newContent) continue // new file already there, leave it alone

      const oldContent = await safeRead(provider, oldPath)
      if (oldContent == null) continue // nothing to migrate

      await write(newPath, oldContent)
      // Verify the write before removing the legacy file.
      const written = await safeRead(provider, newPath)
      if (written !== oldContent) {
        allOk = false
        continue
      }
      if (remove) {
        try { await remove(oldPath) } catch { /* leave it; harmless duplicate */ }
      }
    } catch {
      allOk = false
    }
  }
  if (allOk) localStorage.setItem(flagKey(sourceId), 'done')
  return allOk
}

async function safeRead(provider, path) {
  try {
    const c = await provider.read(path)
    if (c == null || c === '') return null
    return c
  } catch {
    return null
  }
}
