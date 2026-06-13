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
