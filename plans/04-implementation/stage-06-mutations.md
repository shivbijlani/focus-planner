# Stage 6 — Mutations

## Goal
Every capability in `02-features/capabilities.md` that mutates state works from
the UI and persists to disk.

## Deliverable
- Right-click / long-press context menu on tasks: defer, complete, edit
- Inline edit for task fields
- Journal panel: toggle `TODO:` ↔ `DONE:`
- "New task" input on Today
- Optimistic UI updates with rollback on write failure

## Tests (Playwright, real FSA adapter in a temp folder)
For each capability:
1. Perform the action in the UI.
2. Assert the UI reflects the change.
3. Read the file directly from disk (via Node `fs` in the test runner).
4. Assert the file matches the expected serialized form.
5. Reload the page.
6. Assert the UI still reflects the change.

Capabilities covered:
- Add task to Today
- Defer Today → Tomorrow, and back
- Complete task (row leaves focus-plan.md, appears in focus-plan-completed.md under this week's heading, journal `Status` becomes `Completed`)
- Edit task title / priority / manager priority inline
- Toggle todo in a journal
- Add a bullet to a journal (note or TODO)

## Error paths tested
- Write fails (simulate by revoking permission mid-session): UI shows recoverable error, state rolls back, no file corruption.
- External edit happens between read and write: app detects mtime skew, shows conflict UI (may be minimal: "file changed on disk, reload").

## Done when
- Every capability in 02-features/capabilities.md has a green Playwright test.
- No code path exists that writes a file without going through the worker.

## Risks retired
- Concurrent write hazards.
- File format drift (caught by the "read disk, assert bytes" step).

## Out of scope
- Sort/filter UI (falls under future features).
- Undo/redo.
