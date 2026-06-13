// Pure decision logic for propagating remote deletions to the local store.
//
// A file that a device previously synced with a provider but which has now
// disappeared from the authoritative remote listing was deleted on another
// device. We must delete the local copy too, otherwise stale local files
// reappear like ghosts after the app is reopened.
//
// This module is intentionally side-effect free so it can be unit tested
// without IndexedDB, a service-worker context, or network access. The service
// worker supplies the concrete sets and predicates.

/**
 * @param {object} args
 * @param {Iterable<string>} args.candidates   Sync-managed file names to consider
 *   (e.g. union of files with a tracked remote mtime and files in the local mirror).
 * @param {Set<string>|Iterable<string>} args.remoteNames  Names present in the
 *   authoritative (recursive) remote listing.
 * @param {Set<string>|Iterable<string>} [args.pending]    Names with a local
 *   change still queued to push — never delete these.
 * @param {(name:string)=>boolean} [args.isSidecar]    True for sync-metadata files.
 * @param {(name:string)=>boolean} [args.isRecordFile]  True for row-level merge
 *   files (handled by tombstones, never blob-deleted here).
 * @returns {string[]} names that should be deleted locally.
 */
export function filesToDeleteLocally({
  candidates,
  remoteNames,
  pending = [],
  isSidecar = () => false,
  isRecordFile = () => false,
}) {
  const remote = remoteNames instanceof Set ? remoteNames : new Set(remoteNames)
  const pend = pending instanceof Set ? pending : new Set(pending)
  const out = []
  for (const name of new Set(candidates)) {
    if (remote.has(name)) continue       // still on remote
    if (isSidecar(name)) continue        // sync metadata, not user data
    if (isRecordFile(name)) continue     // row-level files use tombstones
    if (pend.has(name)) continue         // local change not yet pushed
    out.push(name)
  }
  return out
}

/**
 * Decide what a single queued plain (non-record) file should do to the remote
 * during the push step, in a way that NEVER destroys pre-existing remote data
 * on the first sync after a provider is connected.
 *
 * The danger this guards against: when a provider is freshly connected, the
 * local device's queued changes (deletions and overwrites accumulated while no
 * provider was connected, or on a brand-new/empty device) would otherwise be
 * pushed blindly over whatever already lives in the cloud — wiping a user's
 * pre-existing OneDrive/Drive data. We only allow a destructive push (delete,
 * or overwrite of a file the remote already has) once we've *seen* that file on
 * this remote before, proven by a tracked remote mtime. Until then the pull
 * step is authoritative: the cloud copy is downloaded rather than clobbered.
 *
 * @param {object} args
 * @param {string|null|undefined} args.localContent  Local file content, or null
 *   when the local file was deleted/absent.
 * @param {boolean} args.tracked   True if we have a stored remote mtime for this
 *   (provider, file) — i.e. we have synced it with this provider before.
 * @param {boolean} args.remoteHas True if the file currently exists on the remote.
 * @returns {'delete'|'write'|'skip'}
 *   - 'delete': remove the file from the remote (a genuine local deletion of a
 *     file we previously synced).
 *   - 'write':  upload local content (a new file, or an update to a tracked file).
 *   - 'skip':   do nothing destructive this pass; let the pull step reconcile
 *     (first contact with pre-existing remote data).
 */
export function planPlainPush({ localContent, tracked, remoteHas }) {
  const localDeleted = localContent === null || localContent === undefined
  if (localDeleted) {
    // Only delete remote files we've synced before. An untracked local deletion
    // on first contact must not wipe pre-existing cloud data.
    return tracked ? 'delete' : 'skip'
  }
  // Local has content. Creating a brand-new remote file is always safe.
  // Overwriting a file the remote already has, when we've never synced it, would
  // clobber pre-existing cloud data — defer to the pull/merge step instead.
  if (!tracked && remoteHas) return 'skip'
  return 'write'
}

/**
 * Select the IndexedDB meta keys that hold a provider's remote-mtime tracking
 * (`mtime:<providerId>:<file>`), so they can be purged when that provider is
 * disconnected. Pure helper to keep the filtering testable. Only the matching
 * provider's keys are returned — other providers' tracking and unrelated meta
 * keys (e.g. `local:*`) are left untouched.
 *
 * @param {Iterable<string>} keys       All keys present in the meta store.
 * @param {string} providerId           Provider being disconnected.
 * @returns {string[]} keys to delete.
 */
export function mtimeKeysForProvider(keys, providerId) {
  const prefix = `mtime:${providerId}:`
  const out = []
  for (const k of keys || []) {
    if (typeof k === 'string' && k.startsWith(prefix)) out.push(k)
  }
  return out
}
