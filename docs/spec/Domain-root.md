# Domain: root

The `root` domain contains the repository-level runtime and toolchain entry points: `server.js`, `vite.config.js`, and `eslint.config.js`. Unlike [Domain-app](Domain-app) or [Domain-storage](Domain-storage), these files are not planner data-model logic. They define how developers run the app locally, how the SPA is built and tested, and how repository-wide quality gates behave.

## Responsibility

`server.js` is a thin Express bridge for the local-folder workflow. It reads and writes markdown files from one configured planner directory, exposes simple JSON endpoints, and persists the chosen planner path in `planner-config.json`. It deliberately does **not** hold board business rules: todo extraction is the only parsing it performs, and even that mirrors the markdown conventions used elsewhere rather than defining a separate domain model.

`vite.config.js` defines the browser bundle and test collector behaviour. Its build identifier comment explains why `__APP_BUILD__` exists: users need to confirm whether a PWA is running a stale service worker, and support needs a visible build stamp. The same file also excludes `plugins/**` from Vitest because some `plugins/overnight-agent/checks/*.test.mjs` files are standalone self-tests that require `%LOCALAPPDATA%`, shell out, and call `process.exit()`; collecting them as Vitest suites would make Linux CI fail for the wrong reason.

`eslint.config.js` is the flat lint contract. It applies browser globals to `**/*.{js,jsx}`, switches Node globals on for `packages/telegram-bridge/**/*.js` and `packages/task-paper/**/*.js`, and intentionally disables `react-refresh/only-export-components` in those Node-only directories.

## Principal modules and exports

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `server.js` | `(none)` | Local API server for filesystem-backed planner editing. |
| `vite.config.js` | `default` | Vite/React build, define, and Vitest configuration. |
| `eslint.config.js` | `default` | Flat ESLint configuration used by `npm run lint`. |

```js
app.get('/api/files', async (req, res) => { ... })
app.get('/api/file', async (req, res) => { ... })
app.put('/api/file', async (req, res) => { ... })
app.delete('/api/file', async (req, res) => { ... })
app.get('/api/todos', async (req, res) => { ... })
app.get('/api/journal-exists', async (req, res) => { ... })
app.post('/api/pick-folder', (req, res) => { ... })
app.get('/api/config', (req, res) => { ... })
app.post('/api/config', async (req, res) => { ... })
```

Those route registrations in `server.js` are the whole backend surface. The implementation enforces required query/body parameters, checks that joined paths stay under the configured planner root, and returns conventional HTTP failures: `400` for missing input, `403` for access outside the planner root, `404` for missing reads, and `500` for write/config errors.

## Behavioural requirements and current test gap

`spec-facts.json` lists **no root-level `*.test.js` files** under `testFiles[]`. That is an important fact about this domain: its contract is presently enforced by code review, package scripts, and integration use rather than dedicated root-domain unit tests. The relevant repository scripts from `spec-facts.json` are `dev`, `server`, `start`, `build`, `lint`, `test`, and the `predev`/`prebuild` `copy-sw` step.

Even without direct root tests, the code makes several required behaviours explicit:

- The local API serves only markdown content under the configured planner directory and skips hidden files and `node_modules` when listing.
- `POST /api/pick-folder` shells out to `powershell.exe` and uses `System.Windows.Forms.FolderBrowserDialog`, so this endpoint is intentionally **Windows-specific**.
- `vite.config.js` injects a build ID through `define.__APP_BUILD__` and sets `base: '/'`, which the app’s update UI and service-worker registration depend on.
- `eslint.config.js` treats browser code and Node-side packages differently, so lint failures reflect the actual runtime environment of each subtree.

## Failure modes

The root domain’s failures are operational rather than data-model failures. If `server.js` is wrong, the local desktop workflow breaks: the browser cannot browse or edit the planner folder, or the Windows folder picker fails. If `vite.config.js` is wrong, service workers can be served from the wrong place, build IDs disappear, or CI starts collecting non-Vitest plugin self-tests and fails spuriously. If `eslint.config.js` is wrong, lint stops being a meaningful gate because globals or rules no longer match runtime reality. The absence of root-domain tests is itself a limitation worth preserving in the spec: rebuilders should not mistake these contracts for already-verified coverage.
