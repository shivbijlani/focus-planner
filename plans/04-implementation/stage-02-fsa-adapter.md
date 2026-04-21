# Stage 2 — FileSystemAccessAdapter

**This is the riskiest stage. Do it second so we fail fast if the whole
premise of the app doesn't hold.**

## Goal
A real FSA adapter that passes the conformance suite against a real folder on
disk, and survives a page reload.

## Deliverable
- `src/storage/FileSystemAccessAdapter.ts`
- `src/storage/handleStore.ts` — persists the `FileSystemDirectoryHandle` in IndexedDB via `idb-keyval`
- `src/storage/FileSystemAccessAdapter.test.ts` — Playwright-driven test
- A throwaway dev page `/dev-fsa.html` that exposes picker + read/write buttons for manual verification

## The unknowns this stage retires
1. **Does `showDirectoryPicker` actually work on GH Pages?** (HTTPS, user-gesture, same-origin)
2. **Can a `FileSystemDirectoryHandle` be stored in IndexedDB and retrieved after reload?** (Yes, per spec, but verify.)
3. **What does the permission prompt look like on reload?** (`queryPermission` returns `prompt`; must call `requestPermission` from a user gesture.)
4. **Does writing a file flush to disk fast enough for OneDrive to pick up?**
5. **What happens when the user moves/deletes the folder externally?**

Each becomes a test or a documented caveat.

## Tests
- Conformance suite (from stage 1) runs against the real adapter in a Playwright test with an auto-granted folder (`--use-fake-ui-for-media-stream`-equivalent, or manual one-time grant in a persistent profile).
- `handleStore.test.ts`: store a fake handle, retrieve it, verify `isSameEntry`.
- Manual test script in `stage-02-fsa-adapter.md`:
  1. Pick folder X.
  2. Write `test.md`.
  3. Reload.
  4. Adapter restores, `exists('test.md')` is true.
  5. Delete folder externally.
  6. Next operation throws `NotFoundError` with a recognizable code.

## Done when
- Conformance suite green against a real disk folder.
- Reload-survives-permission test green.
- `/dev-fsa.html` demos end-to-end for a human in 30 seconds.

## Risks retired
- The single biggest "does this whole architecture work" question.
- If this stage fails, we pivot to OPFS or server-backed before writing any UI.

## Out of scope
- UI styling. Worker integration. Markdown parsing. This is adapter-only.
