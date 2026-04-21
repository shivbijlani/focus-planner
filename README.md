# Planner App

A markdown-backed planner application that uses files in `C:\Users\shivb\planner` as its database.

## Quick Start with Copilot

1. Open terminal in this folder: `cd C:\Users\shivb\planner-app`
2. Start Copilot CLI: `ghcs`
3. Say: **"start planner"**

Copilot will automatically:
- Start the backend and frontend servers
- Open the planner app in Playwright browser
- Be ready to help you manage your tasks

## What Copilot Can Do

- View and navigate your tasks
- Move tasks between Today/Tomorrow
- Create and edit task journals
- Mark tasks as complete
- Edit any markdown file directly

## Manual Start

```powershell
npm start
```
Then open http://localhost:5173

## Architecture

- **Frontend**: React + Vite (port 5173)
- **Backend**: Express.js (port 3001)
- **Data**: Markdown files in `../planner`

See `.github/copilot-instructions.md` for full Copilot integration details.
