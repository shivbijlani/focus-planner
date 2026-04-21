# File Formats

The on-disk format is part of the contract. The UI is not. An LLM rebuilding the app must read and write exactly these shapes.

## Folder layout

```
focus-plan.md
focus-plan-completed.md
journal/
  task-12.md
  task-13.md
```

## `focus-plan.md`

Two markdown tables under `## Today` and `## Tomorrow` headings. Columns in order:

| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |

- `ID` — integer, unique per task across the whole app, never reused.
- `🎯` — priority icon (see below).
- `Task` — freeform text; may contain inline markdown.
- `Mngr Priority` — one of the user's manager-priority labels, or empty.
- `Added` — ISO date `YYYY-MM-DD`.
- `Linked ID` — optional external reference string, or empty.

## `focus-plan-completed.md`

Same table shape, grouped under `## Week of YYYY-MM-DD` headings in reverse-chronological order. The date is the Monday of that week. When a task is completed it moves from `focus-plan.md` into the current week's section here.

## Journal files (`journal/task-XX.md`)

```
# Task XX: Title

- A note
- TODO: Something to do
- DONE: Something finished
- Another note
```

Rules:
- Title line is `# Task XX: ...` where XX matches the task ID.
- Body is a flat bullet list. No nested headings, no sections, no GFM checkboxes.
- Bullets starting `TODO:` are open todos.
- Bullets starting `DONE:` are completed todos.
- All other bullets are free-form notes.
- New items are appended at the bottom (top-down reading order).

## Priority icons

- 🔴 Urgent & Important
- 🟡 Important, Not Urgent
- 🔵 Urgent, Not Important
- ⚪ Not Urgent, Not Important
- ✅ Done
- 🐸 Frog (eat first)
- 📖 Learning

## Invariants

- Task IDs are stable forever. Completing a task preserves its ID. Journals remain linked by ID.
- Files must stay parseable by a human with a text editor. If the app can't parse a file, it surfaces the raw content rather than discarding it.
- Round-trip: reading a file and writing it back unchanged produces byte-identical content (modulo trailing newline).
