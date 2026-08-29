# Domain: folder-sync

## Responsibility

A transport-agnostic, provider-agnostic sync engine that replicates markdown files
between a local adapter (browser storage or the File System Access API) and a cloud
remote (OneDrive, Google Drive, or an in-memory mock), doing **record-level** conflict
resolution instead of whole-file last-write-wins. This is the domain that makes
multi-device use of the planner safe.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/folder-sync/src/merge.js` | The conflict-resolution core: per-record last-write-wins with tombstones, sidecar (de)serialization, fingerprinting, and the collapse/zero-clock guards. Pure, dependency-free, and the single most heavily tested module in the repository. |
| `packages/folder-sync/src/records.js` | Wires a codec + the merge core + sidecar I/O into one end-to-end "reconcile this file" operation, transport-agnostic by taking plain async read/write closures. |
| `packages/folder-sync/src/reconcile.js` | Pure decision logic for whole-file propagation: which locally-tracked files a remote deletion should also remove locally, and the plain-push / mirror-sync planning functions used when a file has no record structure. |
| `packages/folder-sync/src/codecs/mdTable.js` | The generic "markdown table sections" codec: turns a planner-style file into id-keyed records plus a frame capturing every non-row line, so the file can be reconstructed faithfully. |
| `packages/folder-sync/src/engine.js` | The consumer-facing API: routes local reads/writes, enqueues dirty files for the service worker, launches OAuth consent, and relays status events back via `BroadcastChannel`. |
| `packages/folder-sync/src/sw.js` | The Service Worker: drains the dirty-file queue and pulls remote changes, registered as an ES module so it can import the same pure codec/merge/reconcile code as the main thread. |
| `packages/folder-sync/src/providers/oneDrive.js`, `.../googleDrive.js`, `.../mock.js` | Remote provider descriptors — serializable configs (no closures) so they can cross the `postMessage` boundary into the service worker, plus pure HTTP helper functions usable from either context. |
| `packages/folder-sync/src/queue.js` | The IndexedDB-persisted dirty-file queue, so pending writes survive a reload before the service worker drains them. |

## Public exports (selected)

`merge.js`: `mergeCollections`, `stampWrite`, `stampDelete`, `stampLocalChanges`,
`reconcileExternal`, `fingerprint`, `gcTombstones`, `serializeSidecar`, `parseSidecar`,
`isCollapse`. `records.js`: `reconcileRecordsFile`, `sidecarPath`, `isSidecarPath`,
`frameHasStructure`, `preferStructuredFrame`, `preferPopulatedPriorityFrame`.
`reconcile.js`: `planMirrorSync`, `planPlainPush`, `filesToDeleteLocally`,
`shouldPullRemote`, `isMassDeletion`, `isValidRemotePath`. `codecs/mdTable.js`: `parse`,
`serialize`, `mdTableCodec`, `FRAME_ID`. `engine.js`: `createSyncEngine`,
`registerServiceWorker`.

## Design decision: per-record merge, not whole-file diff

The rejected alternative is a classic 3-way file merge or plain last-write-wins on the
whole file's bytes. Both fail the same way: neither can express "this specific row was
deliberately deleted" as distinct from "this row was never present in the version being
merged." A stale replica that still contains a row another device deleted would, under
either alternative, either win outright (last-write-wins) or require heuristic diffing
that cannot distinguish an intentional delete from a merge artifact. The chosen design
makes every record carry its own logical clock and an explicit tombstone flag
(`{clock, deleted}` in the sidecar — see [Data-Formats](Data-Formats)), so a stale
replica's copy of a deleted row can never outrank the tombstone regardless of file-level
timing.

## Behavioural requirements (from tests)

- **`mergeCollections`** must keep records added on either side; must not resurrect a
  delete when a stale full-file replica still contains the old content; must not let an
  alive sidecar entry with no matching record win as `undefined` content (a historical
  OneDrive crash); must drop an alive-but-contentless entry when neither side has the
  record; must let an intentional re-add after a delete win when its clock is newer than
  the tombstone; must let the newer edit win on the same record; must let a delete beat an
  alive write at an *equal* clock (delete is the conservative default at a tie); must be
  deterministic and convergent on alive/alive clock ties; and must report no change at all
  when both sides already agree.
- **The zero-clock freeze fix** (issue 280 in project history): a remote record with no
  meta entry must not be persisted at a durable clock of `0` — that value is only a
  sentinel meaning "no information," valid for losing ties *within one merge*, and must
  never be frozen into the sidecar as the row's real clock, or every future merge will
  treat the row as infinitely old and let any stale replica re-win it forever. A
  tombstone must never be "strengthened" — a clock-0 delete keeps its clock. An
  *explicitly* stamped clock-0 (a deliberate "this side is weak" marker used when
  `records.js` first meets a remote with content but no sidecar) must be left weak, not
  normalized away.
- **`stampLocalChanges`** must stamp new and edited records (detected via fingerprint
  comparison) and tombstone removed ones while ignoring unchanged records; must NOT
  resurrect a tombstoned row that merely reappears in a stale file (a "ghost"); must NOT
  resurrect under a legacy tombstone with no recorded fingerprint (nothing to compare
  against, so the tombstone is honored conservatively); must revive a tombstoned row only
  when its content has genuinely changed since the delete; and tombstones must preserve
  the deleted row's fingerprint for this later classification.
- **The collapse guard** (project-history issue tracked as "371 collapse guard"): an empty
  parsed record set combined with two or more still-tracked alive rows must be treated as
  a load failure, not a full-board delete — `stampLocalChanges` and `reconcileExternal`
  must both skip their delete pass in that case, though the guard is opt-out so a genuine
  full clear can still be stamped when the caller asserts it deliberately. A normal
  single-row (or all-but-one) removal must still be tombstoned correctly — the guard must
  not swallow real deletions.
- **`reconcile.js`'s `filesToDeleteLocally`** must delete a synced file that vanished from
  the remote listing, must never delete a file with a pending local change made offline,
  must ignore sidecar/record-level files entirely, must deduplicate candidates from
  overlapping sources, and must never delete a local-only file on a fresh connect (only
  previously-tracked files are eligible).
- **`planPlainPush`** must write a brand-new untracked local file, must skip overwriting a
  pre-existing remote file on first contact (never clobber an existing remote on first
  sync), must correctly distinguish `undefined` local content (a deletion) from an
  empty-string file (real, empty content — not a deletion).
- **`isMassDeletion`** must flag a full wipe (every deletable file vanished) but not a
  normal single deletion, must not flag anything when there is no tracked baseline yet,
  and must still allow deleting all-but-one tracked file (a per-file pattern, not a
  suspicious wipe).
- **`planMirrorSync`** must rehydrate a file that is missing from the active store but
  present in the mirror (the "stranded journal" bug), and must propagate a missed remote
  deletion (tombstone present, file still physically present) while skipping a tombstone
  whose file is already gone locally.
- **`isValidRemotePath`** must reject a source-scoped key that leaked into the sync
  queue (a historical OneDrive 400-error bug) and every character a provider forbids in a
  path segment, while accepting ordinary and nested journal paths.
- **The mdTable codec** must round-trip unchanged content byte-for-byte, drop a deleted
  row on serialize, insert a row added on another device under the correct section, and
  extract a record id from a composite first cell (e.g. an ADO-linked task id).

## Failure modes

- A codec frame with no `## ` heading structure winning a merge against a structured
  frame strips every section heading from the file, rendering as a blank planner with
  only its title — guarded by `preferStructuredFrame`/`frameHasStructure`.
- A merged frame that keeps structure but loses every `Priorities` list item still
  silently breaks manager-priority ordering across the whole board — guarded by
  `preferPopulatedPriorityFrame`/`framePriorityCount`.
- Diagnostic logging that emits a record for every unchanged file during a large sync
  would drown the signal a developer actually needs (real pulls, real conflicts) in noise
  from routine no-ops — this is why the diagnostic-volume tests specifically require
  summarizing unchanged collections instead of logging every record.
