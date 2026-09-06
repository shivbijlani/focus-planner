# Domain: root

## Responsibility

The `root` domain is the project's own tooling seam: the Express backend that the desktop/dev
workflow talks to, and the two build-tool config files that decide how the frontend is bundled and
linted. It has no business logic of its own — its job is to make the `app`, `storage` and
`folder-sync` domains runnable and checkable.

## Principal modules

| Path | Lines | Role |
| --- | --- | --- |
| `server.js` | 316 | Express server: filesystem-backed `/api/*` endpoints used by the legacy/manual workflow described in `README.md` (list/read/write markdown files, extract todos, check journal existence). |
| `vite.config.js` | 25 | Vite build/dev-server configuration for the React frontend. |
| `eslint.config.js` | 61 | Flat ESLint config — the `lint` script gate that CI's `ci.yml` lint job runs on every PR. |

## Behavioural requirements

`server.js` exposes the endpoints documented in the custom instructions bundled with this
repository: `GET /api/files`, `GET /api/file?path=X`, `PUT /api/file?path=X`, `GET
/api/todos?path=X`, `GET /api/journal-exists?taskId=X`. These are a thin filesystem adapter over the
same markdown files the browser-based storage providers (`storage` domain) read directly — the
server exists for tooling that talks HTTP rather than File System Access API, IndexedDB, or a cloud
API.

There is no dedicated test file for `server.js` in `testFiles`; its correctness is exercised
indirectly through manual/agent-driven use of the endpoints, not vitest.

## Failure modes

- A stale `vite.config.js` or `eslint.config.js` cannot itself corrupt user data — the failure
  surface here is build/lint breakage, not data loss.
- `server.js` writing a file it read with the wrong path (`?path=X`) could clobber a markdown file
  outside the intended data folder; the endpoint contract restricts writes to the configured planner
  folder.
