# Domain: root

## Responsibility

Top-level dev-server and build-tooling entry points that don't belong inside `src/` or
`packages/`: the optional local Express API for filesystem-backed planner storage, and
the Vite/ESLint configuration for the whole app.

## Principal modules

| Module | Role |
| --- | --- |
| `server.js` | Express API exposing the active planner folder over HTTP for the desktop/local-folder workflow described in the top-level README: `GET /api/files` (directory tree), `GET`/`PUT`/`DELETE /api/file` (read/write/delete a markdown file by path), `GET /api/todos` (extract checkbox todos from a journal), `GET /api/journal-exists`, `POST /api/pick-folder`, and `GET`/`POST /api/config` (the server's own `plannerPath` setting, persisted to `planner-config.json`). |
| `vite.config.js` | Build configuration for the React SPA. |
| `eslint.config.js` | Lint configuration; CI's lint job (see `.github/workflows/ci.yml`) blocks merges on this. |

## Design decision: a thin local server, not the source of truth

`server.js` resolves the active planner folder from `planner-config.json` (falling back
to a sibling `../planner` directory) and every file route re-validates that the resolved
absolute path still starts with that configured root before touching disk — a directory
traversal guard, since `path` is taken directly from a query parameter. This server is
explicitly a convenience passthrough for the local-folder storage mode; it holds no
business logic of its own (no merge, no ID allocation, no journal parsing beyond a
todo-extraction pass) and is not on the cross-device consistency path that
[Domain-folder-sync](Domain-folder-sync) owns. It exists so a user who doesn't want any
cloud provider can still point the app at a real folder on disk via a browser fetch API
rather than the File System Access API.

## Behavioural characteristics (no automated test suite)

`server.js` has no dedicated test file. The invariants a rebuild must preserve, read
directly from the route handlers:

- Every file route must resolve `req.query.path` against the configured planner root
  with `path.join`, then reject the request with `403` if the resolved absolute path does
  not start with that root — preventing `../../etc/passwd`-style traversal via the path
  query parameter.
- A read for a file that does not exist must respond `404`, not `500` — the read handler
  deliberately treats any read failure as "not found" rather than distinguishing failure
  causes, unlike the stricter cancellation/not-found distinction required of the browser
  storage providers in [Domain-storage](Domain-storage).
- `GET`/`POST /api/config` must persist the planner path across server restarts via
  `planner-config.json`, defaulting to a sibling `../planner` directory when no config
  file exists yet.

## Failure modes

- Because this server trusts a query-string path and only guards it with a prefix check,
  a rebuild must preserve that check exactly — a symlink or a path-join edge case that
  defeats the `startsWith` guard would turn a local convenience server into an arbitrary
  file read/write primitive.
- The server's own docs make clear it is not part of the sync/consistency guarantees:
  a rebuild must not be tempted to add merge or ID-allocation logic here, since that logic
  already lives once, correctly, in [Domain-app](Domain-app) and
  [Domain-folder-sync](Domain-folder-sync) — duplicating it in `server.js` would create a
  second, divergent implementation of the same rules.
