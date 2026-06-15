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
/**
 * Mass-deletion circuit breaker. Returns true when a proposed local-delete set
 * looks like the remote was wiped or returned a partial/empty listing rather
 * than the user genuinely deleting files one-by-one on another device.
 *
 * Deleting local files because they're "absent from the remote" is inherently a
 * heuristic (plain files carry no remote tombstone). When *every* file we've
 * synced with a provider suddenly appears absent, the far more likely
 * explanations are a wiped/disconnected remote or a transient/partial listing —
 * not that the user deleted everything. In that case we must NOT propagate the
 * "deletion" locally; the push step will re-upload instead. Erring toward
 * keeping files means the worst case is a harmless ghost file, never data loss.
 *
 * @param {object} args
 * @param {number} args.deletableCount  How many sync-managed plain files were
 *   eligible for deletion (tracked candidates minus records/sidecars/pending).
 * @param {number} args.toDeleteCount   How many of those are absent from remote.
 * @returns {boolean} true ⇒ treat as anomaly and skip deletion entirely.
 */
export function isMassDeletion({ deletableCount, toDeleteCount }) {
  if (!deletableCount) return false              // no baseline → nothing to guard
  return toDeleteCount >= deletableCount         // the entire set vanished → wipe
}

/**
 * Decide how to reconcile ONE service-worker mirror entry into the app's active
 * local store. The SW pulls remote changes into an IndexedDB "mirror" and then
 * relies on a live `remote-update` postMessage to copy them into the active
 * store the UI actually reads. That message is easily missed (background sync,
 * or no controlled window on mobile), which strands pulled files — e.g.
 * journals — in the mirror while the UI shows nothing. Replaying the mirror into
 * the active store on load repairs that divergence.
 *
 * Safe by construction:
 *  - a mirror tombstone (deleted) only removes a file the active store still has
 *    (propagates a missed remote deletion); it never deletes what's already gone.
 *  - content is only written when the active copy differs, so it can't clobber an
 *    up-to-date file, and an absent active copy (read as '') gets rehydrated.
 *  Local edits mirror synchronously, so the mirror is never staler than the
 *  active store — making "mirror wins" the correct repair direction.
 *
 * @param {object} args
 * @param {boolean} args.mirrorDeleted   Mirror entry is a tombstone.
 * @param {string|null|undefined} args.mirrorContent  Mirror file content.
 * @param {string|null|undefined} args.activeContent  Active-store content
 *   (the adapter returns '' for a missing file).
 * @returns {'write'|'delete'|'skip'}
 */
export function planMirrorSync({ mirrorDeleted, mirrorContent, activeContent }) {
  const active = activeContent ?? ''
  if (mirrorDeleted) {
    return active !== '' ? 'delete' : 'skip'   // remove only if still present
  }
  const mirror = mirrorContent ?? ''
  return active !== mirror ? 'write' : 'skip'  // rehydrate / update when diverged
}

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
 * Decide whether the pull step should download a remote file into the local
 * store. The mtime comparison is only an optimization to skip re-downloading a
 * file we already hold; it must not suppress a genuinely missing local copy.
 *
 * The bug this fixes: after the earlier "phantom journal" cleanup, a device can
 * carry a stale `mtime:<provider>:<file>` entry from a previous sync session
 * while no longer holding the file locally (e.g. journals that were never
 * materialised into the active store, or were cleared). On reconnect the remote
 * still lists the file, but `lastSeen >= remoteMtime` made the pull skip it
 * forever, so journals "never come down". Here we re-pull whenever the local
 * copy is absent, since the remote listing is authoritative — a file that was
 * truly deleted remotely won't appear in the listing at all.
 *
 * @param {object} args
 * @param {number|null|undefined} args.lastSeen    Last remote mtime we recorded
 *   for this (provider,file), or falsy if we've never synced it.
 * @param {number} args.remoteMtime                 Mtime from the current listing.
 * @param {boolean} args.localPresent               Whether a local copy exists.
 * @returns {boolean} true if the file should be downloaded.
 */
export function shouldPullRemote({ lastSeen, remoteMtime, localPresent }) {
  if (!lastSeen) return true               // never synced → pull
  if (remoteMtime > lastSeen) return true  // remote changed → pull
  if (!localPresent) return true           // local copy missing → restore it
  return false                             // up to date and present → skip
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
/**
 * Whether a queued file name can legally exist as a path on a cloud provider.
 *
 * Cloud providers (OneDrive/Microsoft Graph in particular) reject a fixed set of
 * characters in path segments — notably `:` — so a name like `s2:focus-plan.md`
 * (a *source-scoped* key that leaked into the provider-agnostic sync queue) makes
 * every push 400. Because the push step aborts on the first error, a single such
 * poison entry wedges backup permanently behind a "Backup failed" state. The SW
 * uses this guard to skip + drop unsyncable names instead of pushing them.
 *
 * `/` is intentionally allowed: it is our path separator between segments. Each
 * segment, however, must be non-empty, free of illegal characters, not `.`/`..`,
 * and free of leading/trailing whitespace (also rejected by most providers).
 *
 * @param {string} name  Candidate file name (may contain `/` separators).
 * @returns {boolean} true when the name is safe to push to a remote provider.
 */
const ILLEGAL_REMOTE_CHARS = /[:*?"<>|\\]/
export function isValidRemotePath(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (ILLEGAL_REMOTE_CHARS.test(name)) return false
  for (const seg of name.split('/')) {
    if (seg.length === 0) return false        // empty segment (//, leading/trailing /)
    if (seg === '.' || seg === '..') return false
    if (seg !== seg.trim()) return false       // leading/trailing whitespace
  }
  return true
}

export function mtimeKeysForProvider(keys, providerId) {
  const prefix = `mtime:${providerId}:`
  const out = []
  for (const k of keys || []) {
    if (typeof k === 'string' && k.startsWith(prefix)) out.push(k)
  }
  return out
}
