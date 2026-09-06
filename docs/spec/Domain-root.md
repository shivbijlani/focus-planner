# Domain: root

The `root` domain is the repository's own toolchain — the pieces that are not part of the shipped
product but make building, serving and linting it possible. It has three modules: `server.js`,
`vite.config.js`, and `eslint.config.js`.

## Responsibility

Provide (1) a minimal local backend for the desktop/Copilot-CLI workflow, (2) the Vite build/dev
configuration for the React SPA, and (3) the lint rule set that CI's `lint` job enforces.

## `server.js`

An Express app exposing a small file-oriented API over one local folder:

| Route | Purpose |
| --- | --- |
| `GET /api/files` | Directory tree of markdown files in the configured planner folder. |
| `GET /api/file?path=X` | Read a file's contents. |
| `PUT /api/file?path=X` | Write a file's contents. |
| `DELETE /api/file?path=X` | Delete a file. |
| `GET /api/todos?path=X` | Extract todo items from a journal file. |
| `GET /api/journal-exists?taskId=X` | Check whether a task's journal file exists. |
| `POST /api/pick-folder` | Native folder picker for choosing the planner directory. |
| `GET /api/config` / `POST /api/config` | Read/write the server's own small config (e.g. which folder is active). |

This exists specifically so a locally-run Copilot CLI session (see the repository `README.md`'s
"start planner" workflow) can read and edit the exact same markdown files the browser app uses,
without going through a browser storage provider — it is a thin filesystem proxy, not an
application backend. It holds no board or journal business logic; every transform (adding a task,
completing it, parsing a journal) still happens in `src/` and is invoked by whatever client calls
this API.

## `vite.config.js`

Configures the Vite dev server and production build for the React 19 SPA (`@vitejs/plugin-react`).
Notably, `npm run predev`/`prebuild` run `scripts/copy-sw.mjs` first, copying the `folder-sync`
package's source tree into `public/folder-sync/` — a service worker can only be registered from a
URL on the page's own origin, so the sync engine's code must be served from the app's static asset
tree rather than imported the normal bundler way.

## `eslint.config.js`

The flat ESLint config (`@eslint/js`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`)
that CI's `lint` job runs unmodified via `npm run lint`. The `ci.yml` job comment records that main
is lint-clean and the job is a **blocking** gate — it was previously non-blocking because two
pre-existing errors made it permanently red, which trained reviewers to ignore it; both were fixed
specifically so the gate could start meaning something again.

## Failure modes

None of this domain's three files hold user data or business state, so its failure modes are
build/dev-time only: a broken `vite.config.js` breaks every build and every developer's dev server
identically (there is no per-environment drift to chase), and `server.js` failing merely disables
the local-folder Copilot workflow — the browser app, with any other storage provider configured,
is unaffected.
