# Capabilities

What the user can do. No assumptions about how it looks or how they trigger it.

## Data the app manages

The app manages three kinds of things stored as markdown files in a user-chosen folder:

- **Tasks** — short items with a priority, a status (today / tomorrow / completed), and optional metadata.
- **Journals** — one optional long-form note per task.
- **Todos** — bullet items inside a journal, each either open or done.

See `file-formats.md` for exact on-disk formats. Those formats are part of the contract; the UI is not.

## Folder

- Pick a folder that will hold the app's markdown files.
- Change to a different folder later.
- Reopen the last folder on next launch without picking again.
- Work with a folder that is empty — the app scaffolds the files it needs.
- Work with a folder someone else edits out-of-band (text editor, Obsidian, etc.) without corrupting it.

## Tasks

Create:
- Add a new task to Today.
- Add a new task to Tomorrow.

Read:
- List all Today tasks.
- List all Tomorrow tasks.
- List all completed tasks, grouped by the week they were completed.

Update:
- Change a task's text.
- Change a task's priority icon.
- Set or clear a task's linked external ID.
- Set or clear a task's manager-priority label.
- Move a task between Today and Tomorrow.
- Mark a task completed (which moves it to the completed archive under the current week).
- Un-complete a task (move it back to Today).

Delete:
- Delete a task outright.

Sort / filter (read-only derivations):
- Group Today or Tomorrow by manager priority.
- Sort by priority icon.
- Sort by date added.

## Journals

- Open the journal for a task. If none exists, create it.
- Edit the journal as free-form markdown.
- Delete the journal.

## Todos (inside a journal)

- Add an open todo.
- Add a note (non-todo bullet).
- Mark an open todo done.
- Mark a done todo open again.
- Edit a todo's text.
- Delete a todo or note.
- See which tasks have at least one open todo.
- See how many open / done todos a task has.

## Manager priorities

- Maintain a short list of manager-priority labels.
- Add a label.
- Remove a label.
- Rename a label (and have existing tasks update).

## Portability & durability

- All data lives in plain markdown files the user owns.
- No lock-in — user can stop using the app and keep editing the files by hand.
- Placing the folder inside a sync service (OneDrive, iCloud, Dropbox, git, etc.) gives the user cross-device sync for free. The app is agnostic to that.

## Out of scope for V1

Search, tags beyond priority and manager priority, recurring tasks, due dates, reminders, calendar, multi-folder, collaboration, auth, cloud drive APIs, mobile/desktop shells.
