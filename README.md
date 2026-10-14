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

## Journals and supporting documents

In the sidebar's `journal` folder, `task-<ID>.md` is labeled **Journal**.
An optional primary Markdown briefing may use the exact filename
`task-<ID>-briefing.md` and is labeled **Briefing**.
Descriptive files such as `task-431-webmcp-evaluation.md` are labeled
**Supporting doc** for the same task, not a second journal. Both retain their
original filenames, remain independently accessible, and keep their contents
and links; these labels do not rename, combine, or remove any files. A Docs
primary remains a separate link from the Markdown briefing.

## Native Docs agent reviews

Native Docs is enabled only when the planner folder already has `docs/index.json`.
The Node Overnight Agent scanner reads submitted primary/supporting reviews, including
parked tasks; the task session uses the shipped `docs-publish` skill to acknowledge, amend,
and publish per-comment dispositions. A `needs-you` reply is blocking. Task closure, snooze,
pauses, lanes, ownership, attribution and consent still apply; approving a span is not
whole-document approval. Google documents and Markdown briefings are not migrated.

For installed plugins, configure `FOCUS_PLANNER_REPO` to the matching deployed repository
and `PLANNER_PATH` to the planner data folder for `fp-docs`. Run
`node scripts\fp-docs.js --help` from that repository. This consumer launcher enforces
the agent's sandbox, lane, task-status, and session-ownership guards. The standalone
`@focus/docs-publisher` package has no plugin dependency; its CLI requires explicit
deployment guards rather than silently permitting writes.

Docs deployments can replace `#planner/docs-bootstrap` through
`VITE_DOCS_BOOTSTRAP_MODULE`, alongside the existing host/profile/storage-bootstrap
aliases. See [Docs deployment seams](docs/docs-deployment-seams.md) for boot policy,
account/source draft isolation, embedded styling, and publisher guard contracts.
See [the behavior contract](docs/spec/Domain-docs.md) and
[the publishing procedure](plugins/overnight-agent/skills/docs-publish/SKILL.md).

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

## Testing

| Command | What it runs |
|---|---|
| `npm test` | Vitest unit tests (includes `server.test.js`, which runs the local API server against a temp folder) |
| `npm run lint` | ESLint |
| `npm run test:smoke` | Playwright app smoke suite in `e2e/` (Chromium, ~1 min) |

The smoke suite builds the app (`npm run build`), serves it with `vite preview` on port 4317
(override with `SMOKE_PORT`), and drives the real UI in a fresh browser context per test using
the browser-only **Browser Storage** (IndexedDB) provider — no sign-in or network needed. It is a
characterization suite for today's mainline flows (first run, add/prioritise/move/snooze/search,
linked tasks, journal chat and unread star, complete/delete, reload persistence, agent gate and
settings editors, phone layout, storage choices), asserting on both the DOM and the stored files.

The optional `e2e/docs-agent.spec.js` acceptance test invokes real unattended Copilot task
runs against synthetic isolated data. It opens native Docs from a task row, submits a
concrete primary revision request and a linked supporting-doc request in the UI, then
reopens the published answers and preserved comments after two actual agent cycles.
It uses the real IndexedDB provider, with an explicit harness bridge to mirror files to
the isolated Node planner; it does not prove live cloud sync or deployed-site acceptance.
Run with `$env:DOCS_AGENT_ACCEPTANCE='1'` and
`npm run test:smoke -- e2e/docs-agent.spec.js --workers=1`.
`DOCS_ACCEPTANCE_ROOT` selects an artifact parent; fixtures, build SHA, transcripts,
actual events, before/after files and browser screenshots are retained there. No live
planner is touched and no automation is enabled. The default CI smoke run skips real
model invocations; deterministic Node/publisher tests always run.

First time only: `npx playwright install chromium`. Useful flags: `npm run test:smoke -- --headed`,
`-- --ui`, `-- e2e/journal.spec.js`. Locally an already-running server on the port is reused, so
restart it after changing app code. CI runs it as the **App smoke (Playwright)** job.

## Working in a git worktree

Run `npm ci` **inside** the worktree, and remove it with
`pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path <worktree>`.

Do **not** junction `node_modules` to the main checkout: `git worktree remove --force`
deletes *through* a junction and empties the shared install for the main checkout and
every other worktree at once, silently ([#321](https://github.com/shivbijlani/focus-planner/issues/321)).
See [`docs/worktrees.md`](./docs/worktrees.md).

## Copilot CLI plugin marketplace

This repo is also a **GitHub Copilot CLI plugin marketplace**. It publishes
plugins that pair with the planner workflow — starting with the
[`overnight-agent`](./plugins/overnight-agent) plugin.

```shell
# Register the marketplace, then install the overnight-agent plugin
copilot plugin marketplace add shivbijlani/focus-planner
copilot plugin install overnight-agent@focus-planner
```

The marketplace registry is [`.github/plugin/marketplace.json`](./.github/plugin/marketplace.json)
and plugins live under [`plugins/`](./plugins). See [`plugins/README.md`](./plugins/README.md)
for details and instructions on adding new plugins.

## Packages

Vendored (private, not published) packages under `packages/`:

- **`@focus/mcp-cred-vault`** — Portable Windows launcher that keeps Copilot CLI
  MCP secrets in Credential Manager (DPAPI) instead of plaintext config, with a
  `npm run setup` bootstrap to reproduce it on any machine. See
  [`packages/mcp-cred-vault/README.md`](packages/mcp-cred-vault/README.md).
