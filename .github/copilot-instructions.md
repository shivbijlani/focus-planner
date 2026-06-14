# Planner App - Copilot Instructions

You are helping with a markdown-backed planner application. This app uses markdown files in `C:\Users\shivb\planner` as its database.

## Bootstrap Command

When the user says "start planner", "open planner", "bootstrap", or "let's work on the planner":

1. **Start the servers** (if not already running):
   ```powershell
   cd C:\Users\shivb\planner-app
   Start-Process -FilePath "node" -ArgumentList "server.js" -WindowStyle Hidden
   Start-Process npm -ArgumentList "run dev" -WindowStyle Hidden
   ```

2. **Wait for servers to be ready** (2-3 seconds)

3. **Open the planner app with Playwright**:
   ```
   Use playwright-browser_navigate to open http://localhost:5173/
   ```

4. **Confirm ready**: Tell the user the planner is open and ready for collaboration.

## Architecture

- **Frontend**: React + Vite on port 5173
- **Backend**: Express.js on port 3001
- **Data**: Markdown files in `C:\Users\shivb\planner`

### Key Files
- `focus-plan.md` - Main task list (Today/Tomorrow sections)
- `focus-plan-completed.md` - Completed tasks archive
- `journal/task-XX.md` - Individual task journals with todos

### API Endpoints
- `GET /api/files` - Directory tree of markdown files
- `GET /api/file?path=X` - Read a markdown file
- `PUT /api/file?path=X` - Update a markdown file
- `GET /api/todos?path=X` - Extract todos from a journal file
- `GET /api/journal-exists?taskId=X` - Check if journal exists for task

## Features You Can Help With

1. **View tasks** - Focus plan shows Today/Tomorrow with priority colors
2. **Defer tasks** - Right-click to move between Today/Tomorrow
3. **Edit markdown** - Click any file to edit inline
4. **Journal todos** - Tasks with journals show expandable todo lists
5. **Complete tasks** - Move tasks to focus-plan-completed.md

## Task Management Patterns

### Adding a new task to Today:
Add a row to the Today table in focus-plan.md:
```markdown
| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |
| 70 | 🟡 | New task description | Sydney rollout | 2026-01-27 | |
```

### Creating / updating a journal for a task:
Journals render as a **chat thread** (messaging yourself). Plain markdown works
out of the box — an agent that knows nothing still produces a valid bubble. The
renderer understands bold/italic/code, links, lists, tables, blockquotes,
`- [ ]`/`- [x]` checkboxes, and `TODO:`/`DONE:` prefixes.

Minimal journal (renders as one "me" bubble):
```markdown
# Task XX: Title

- First note
- TODO: Something to do
- DONE: Completed item
```

**Chat schema (for grouping into dated bubbles + agent attribution):**
- `# Task XX: Title` — thread title (first line).
- `## YYYY-MM-DD` — starts a new day group. Consecutive same-day "me" notes
  merge into one bubble. **Append new entries at the bottom under today's date.**
- `<!-- from: agent-name -->` — marks following content as an AI agent message
  (renders left-side under a 🤖 banner). `<!-- from: me -->` switches back.
- A marker comment containing `AUTO` (e.g. `<!-- DANCE-CHURCH-AUTO -->`) also
  flags an auto-generated agent block.
- Multi-line HTML comments (e.g. `<!-- dc-meta ... -->`) are hidden from the
  chat — safe for machine metadata.
- Content before the first `##`/agent marker is "earlier notes" (undated).

See **`AGENTS.md` at the data-folder root** for the full spec. The app scaffolds
that file into every connected folder (local / OneDrive / Google Drive) and keeps
it version-updated, so the folder is self-documenting for any external agent. It
is the single source of truth (generated from `src/config/agentsDoc.js`, which
mirrors the renderer in `src/journalChat.js`). Do **not** embed schema docs in
individual journals.

**Guidelines:**
- Plain markdown is fine; you only need the markers above for dated/agent bubbles.
- Top-down flow: add new items at the bottom.
- Mix todos and notes freely.

### Completing a task:
1. Remove from focus-plan.md
2. Add to focus-plan-completed.md under the current week
3. Update journal status to "Completed" and mark all todos done

## Priority Icons
- 🔴 Urgent & Important
- 🟡 Important, Not Urgent  
- 🔵 Urgent, Not Important
- ⚪ Not Urgent, Not Important
- ✅ Done
- 🐸 Frog (eat first)
- 📖 Learning

## Manager Priorities
1. Sydney rollout
2. Vibe Agenda
