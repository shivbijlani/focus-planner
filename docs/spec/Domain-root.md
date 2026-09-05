# Domain: root

## Responsibility

The three files at the repository root that configure the build/lint toolchain and one legacy local
development helper — the smallest domain, but its build identifier and vitest-exclusion rules are
load-bearing for the rest of the system's CI correctness.

## Principal modules

| Module | Role |
| --- | --- |
| `vite.config.js` | The app's build config: defines `__APP_BUILD__` (a UTC timestamp) so Settings can show a build identifier, and excludes `plugins/**` from vitest collection. |
| `eslint.config.js` | Flat-config ESLint setup: browser globals + React rules for `src/**`, with a separate Node-side block for the Telegram bridge service. |
| `server.js` | A legacy Express server (port 3001) exposing `/api/files`, `/api/file`, `/api/todos`, `/api/journal-exists` against a locally-configured planner path. |

## `server.js` status

This file is **not part of the current architecture**. It predates the browser-storage-provider model
(see [Data-Formats](Data-Formats) and [Architecture](Architecture)): the shipped app talks to FSA,
IndexedDB, OneDrive, and Google Drive directly through `src/storage/storage.js`, and no `src/` module
references `/api/` or port 3001 anywhere. It remains as a local-dev convenience for working against a
plain local folder without going through a storage provider, not as a server the deployed app depends
on. A rebuilder should treat it as optional tooling, not as a required backend.

## `vite.config.js` — why `plugins/**` is excluded from vitest

`plugins/overnight-agent/checks/` holds the overnight agent's own standalone PowerShell-adjacent check
scripts. Some are named `*.test.mjs` by convention but are not vitest suites at all — they read
`%LOCALAPPDATA%`, shell out to external processes, and call `process.exit()` directly. Collecting them
into the ordinary `npm test` run would fail the whole suite on a Linux CI runner, where
`%LOCALAPPDATA%` is undefined and the assumptions those scripts make about the host don't hold. They
are run only by `run-sweeps.ps1`, which is the one caller that can supply the Windows environment they
require (see [Domain: overnight-agent](Domain-overnight-agent) and [Reliability](Reliability) for the
mutcheck harness these scripts belong to).

## Why a build identifier exists at all

`__APP_BUILD__` is a UTC timestamp computed at build time and surfaced in the Settings screen. Its
purpose is entirely about Service Worker staleness: because the app is a PWA with an update-on-reload
Service Worker, a user or support agent looking at a stuck/misbehaving install needs a way to confirm
whether the running tab is actually on the latest deployed build or is serving a cached, stale worker —
which is not otherwise observable from the UI without an explicit, deploy-time-stamped identifier.

## ESLint configuration shape

Two rule blocks target two different runtimes rather than one blanket config: browser globals plus
React Hooks/Refresh rules apply to `src/**` and `.jsx` files; a separate block (not shown above but
present in the file) relaxes browser-specific assumptions for the Node-side Telegram bridge service,
since it runs under Node rather than in a browser and would otherwise be flagged for using Node globals
ESLint doesn't expect in a browser-targeted block. `no-unused-vars` is configured to ignore identifiers
matching `^[A-Z_]`, an explicit allowance for intentionally-unused constant-style exports.

## Failure modes this domain guards against

- **A whole-suite CI failure from unrelated Windows-only scripts** — the `plugins/**` vitest exclusion
  exists precisely because a handful of files that merely look like test files would otherwise crash
  every `npm test` run on Linux CI.
- **An unverifiable "which build is this" support conversation** — the build-id surface exists because
  a stale Service Worker is otherwise indistinguishable from a genuinely broken new build.
