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

### Creating a journal for a task:
Create `journal/task-XX.md` with a **simple format** - just title and bullet points:
```markdown
# Task XX: Title

- First note
- TODO: Something to do
- DONE: Completed item
- More notes as needed
```

**Journal guidelines:**
- Keep journals super simple - just a title and bullet points
- No metadata headers, no sections, no date headers
- No checkbox syntax ([ ] or [x]) - use TODO: and DONE: prefixes instead
- Top-down flow (add new items at bottom)
- Mix todos and notes freely

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
