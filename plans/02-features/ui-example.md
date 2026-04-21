# UI Example

This document is **illustrative, not prescriptive**. It describes one reasonable UI that would satisfy `capabilities.md`. Any UI that covers those capabilities is acceptable.

## Views

- **Today** — scrollable table of today's tasks.
- **Tomorrow** — same, for tomorrow.
- **Completed** — collapsible sections, one per week, most recent first.
- **Journal** — shown inline under a task that has a journal, or in a side panel.

## Task row

A single row shows: priority icon, task text, manager-priority label, linked ID badge, and an indicator when a journal exists (e.g. a dot with the count of open todos).

## Task interactions

- Click the icon to cycle priority, or open a picker.
- Click the text to edit inline.
- Right-click (or long-press on touch) for a menu: defer, complete, delete, open journal, set linked ID, set manager priority.
- Drag between Today and Tomorrow lists to defer.

## Journal interactions

- An expand affordance on each task row opens its journal below the row.
- Inside the journal: one input field that adds a new bullet. A prefix toggle chooses note / TODO.
- Each bullet has: a checkbox (toggles TODO ↔ DONE), inline edit on click, delete on a secondary action.
- "Edit raw" button drops into a plain markdown textarea for the whole file.

## Folder onboarding

- First visit: centered card with one button, "Open planner folder".
- After picking: the app remembers the handle. Next visit shows a spinner and "Continue with <folder name>" if permission must be re-granted.
- Settings has "Change folder".

## Error surfaces

- Non-Chromium browser: full-page message explaining the limitation and linking to Edge/Chrome downloads.
- Permission denied: inline banner with a re-grant button.
- Parse error on a file: that file's view shows a raw-markdown editor with a warning banner; the rest of the app stays usable.
- Empty folder: offer to scaffold `focus-plan.md` and `focus-plan-completed.md`.

## What's intentionally unspecified

Colors, typography, exact layout, animations, keyboard shortcuts, dark mode, mobile breakpoints. An LLM rebuilding the app should make reasonable choices and iterate with the user.
