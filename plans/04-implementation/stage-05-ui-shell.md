# Stage 5 — UI shell

## Goal
The smallest possible React UI that lets a user pick a folder and see their
focus plan. Read-only.

## Deliverable
- `src/ui/App.tsx` — routes between "no folder picked" and "planner"
- `src/ui/FolderPicker.tsx` — one button, calls the adapter
- `src/ui/FocusPlan.tsx` — renders Today + Tomorrow tables
- `src/ui/Completed.tsx` — renders current week's completed list
- Playwright tests against the built app

## Tests (Playwright)
- First visit: shows "Open planner folder" button, nothing else.
- After picking folder (use `?storage=memory` query flag with a fixture): focus plan renders with correct rows.
- Reload after picking real folder (via stage-2 persistence): no picker, goes straight to plan.
- Priority icons render as-is (🔴🟡🔵⚪✅🐸📖). No substitution.

## Not tested here
- Writes. That's stage 6.

## Done when
- Manual demo: open GH Pages (or localhost), pick folder, see your real tasks.
- All Playwright tests green in CI against the `?storage=memory` fixture.

## Risks retired
- UI ↔ worker wiring (the typed proxy works under Vite build).
- First-run UX.

## Out of scope
- Editing, deferring, completing. Styling beyond "not broken".
