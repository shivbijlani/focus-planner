# Domain: diagnostics

## Responsibility

A single dependency-free event bus (`packages/diagnostics/src/index.js`, 441 lines) that every other
domain can safely import without creating a cycle. It gives the app, the `folder-sync` service
worker, and the storage layer one place to record "what just happened" — writes, sync events, merge
decisions — without any of them needing to know who, if anyone, is listening.

## Principal modules

| Path | Exports |
| --- | --- |
| `packages/diagnostics/src/index.js` | `diag`, `registerDiagSink`, `unregisterDiagSink`, `enableDiagnostics`, `disableDiagnostics`, `isDiagEnabled`, `setDiagnosticsLimit`, `dumpDiagnostics`, `dumpAllDiagnostics`, `clearDiagnostics`, `printDiagnostics`, `resetDiagnosticsForTests`, `advertiseDiagnosticsToWorker`, `findDiagnosticsWorker`, `requestWorkerDiagnostics`, `requestWorkerDiagnosticClientStates`, `setWorkerDiagnosticsForClient`, `handleWorkerDiagnosticMessage`, `reconcileWorkerDiagnosticClients`, `reconcileWorkerDiagnosticsForClients` |

## Design

`diag(context, event)` is a cheap no-op when disabled (a test in `index.test.js` pins exactly this),
so call sites can instrument liberally without a runtime cost in production. When enabled, each
context (e.g. `"merge"`, `"sync"`) keeps a **bounded ring buffer** of its own events rather than one
unbounded log, so a long-running tab cannot leak memory through diagnostics. Consumers are **sinks**
registered via `registerDiagSink` — the module fans an event out to every registered sink rather than
picking one, so the browser console, a UI diagnostics panel, and a test spy can all observe the same
stream independently.

Because the module runs in three separate JS realms (the main-thread app, the folder-sync service
worker, and any test harness), a large part of its surface is **cross-realm plumbing**: the main
thread cannot read the service worker's ring buffers directly, so `advertiseDiagnosticsToWorker`,
`findDiagnosticsWorker`, `requestWorkerDiagnostics`, and `reconcileWorkerDiagnosticClients` implement
a request/response protocol over `postMessage`/`BroadcastChannel` so a snapshot dump on the main
thread can pull in the worker's buffer without holding it live for every enabled client all the time.

## Behavioural requirements (from `packages/diagnostics/src/index.test.js`)

- Is a cheap no-op when disabled.
- Fans out enabled events to every registered sink.
- Keeps each context buffer bounded as a ring.
- Records without emitting live console traffic.
- Uses a shared event schema with per-context correlation fields.
- Does not create console or client-message backpressure during a driven burst.
- Pulls the worker buffer only when `dumpAll` is requested.
- Selects the folder-sync worker instead of the root app worker.
- Serves a worker dump through the request message port.
- Prints only an explicitly requested snapshot.
- Keeps worker diagnostics enabled while another client still requests them.
- Prunes a diagnostic client after its tab closes.
- Requests and reconciles worker diagnostic client state without leaking a stale client.

## Failure modes

- A sink that throws must not break the event source — diagnostics are advisory, and an instrumented
  call site (a merge, a write) must succeed or fail on its own merits regardless of what diagnostics
  does with the event.
- A worker that never answers a diagnostics request must not hang the requester; `dumpAllDiagnostics`
  degrades to the main-thread buffer alone rather than blocking indefinitely.
