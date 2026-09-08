# Domain: diagnostics

`diagnostics` is a single-module package that gives the app and its service worker one structured event system. It is designed to be left in production code permanently: cheap when disabled, bounded when enabled, and explicit about how page and worker traces are correlated. `folder-sync` depends on it heavily, but the module itself stays generic. See [Architecture](Architecture), [Reliability](Reliability), and [Domain-folder-sync](Domain-folder-sync).

## Responsibility

`packages/diagnostics/src/index.js` owns four jobs: emit structured events, retain a bounded in-memory ring buffer, coordinate enablement across page and worker contexts, and retrieve a combined snapshot on demand. The module auto-installs its default buffer sink and exposes a window global `__plannerDiag` for manual inspection. Its event schema carries both wall-clock time and per-context sequencing so logs from the page and service worker can be merged deterministically.

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
export function diag(channel, event, fields = {}) {
  if (!state.enabled) return false
  emit(makeEvent(channel, event, fields))
  return true
}

function makeEvent(channel, event, fields = {}) {
  const context = eventContext()
  return {
    schema: EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    t: Date.now(),
    context: context.kind,
    contextId: context.id,
    sequence: context.sequence,
    channel,
    event,
    fields: cloneFields(fields),
  }
}
```


</details>
## Module and exports

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `packages/diagnostics/src/index.js` | `advertiseDiagnosticsToWorker`, `clearDiagnostics`, `diag`, `disableDiagnostics`, `dumpAllDiagnostics`, `dumpDiagnostics`, `enableDiagnostics`, `findDiagnosticsWorker`, `handleWorkerDiagnosticMessage`, `isDiagEnabled`, `printDiagnostics`, `reconcileWorkerDiagnosticClients`, `reconcileWorkerDiagnosticsForClients`, `registerDiagSink`, `requestWorkerDiagnosticClientStates`, `requestWorkerDiagnostics`, `resetDiagnosticsForTests`, `setDiagnosticsLimit`, `setWorkerDiagnosticsForClient`, `unregisterDiagSink` | Entire diagnostics surface: emission, buffering, worker coordination, dumps, and sink management. |

## Principal mechanics

Enablement is shared rather than local. `enableDiagnostics()` persists a flag in `localStorage` and broadcasts `planner-diag-enable` messages to service workers. The worker side tracks a set of requesting client ids so one page closing cannot disable diagnostics for another page that still wants them. `requestWorkerDiagnostics()` uses a `MessageChannel` and timeout to ask the active folder-sync worker for its snapshot. `findDiagnosticsWorker()` prefers the registration whose scope or script URL identifies `folder-sync/sw.js`, avoiding accidental dumps from the root app worker.

The module is intentionally conservative about cost. The ring buffer limit defaults to `250`, `diag()` returns immediately when disabled, and dump requests clone event fields rather than returning live references. Console printing only happens through explicit `printDiagnostics()`. That separation matters because diagnostic floods are themselves a failure mode the package is meant to expose, not create.

## Behavioural requirements from tests

The behavioural spec is `packages/diagnostics/src/index.test.js`.

- `diag()` is a cheap no-op when disabled.
- Enabled events fan out to every registered sink.
- The in-memory buffer behaves as a ring capped by `setDiagnosticsLimit()`.
- Diagnostics record silently; they do not produce live console traffic by default.
- Every event uses the shared schema with per-context correlation fields.
- A driven burst does not create console or client-message backpressure.
- Worker buffers are only pulled when `dumpAllDiagnostics()` requests them.
- Worker selection prefers the folder-sync worker over unrelated service workers.
- Worker dumps are served over the request message port, not by speculative polling.
- `printDiagnostics()` prints only the explicitly requested snapshot.
- Worker diagnostics stay enabled while any client still requests them.
- Stale worker-client registrations are pruned after a tab closes.
- After a worker restart, the page re-advertises the enabled state so diagnostics do not appear to disable themselves randomly.

## Failure modes

Without this package, the likely failure modes are all diagnostic self-sabotage: instrumentation too expensive to leave enabled, logs too noisy to read, and page/worker traces that cannot be joined after the fact. The module counters those by making the disabled path trivial, bounding retention, separating emission from printing, and persisting enablement as a negotiated state between live pages and transient workers.
