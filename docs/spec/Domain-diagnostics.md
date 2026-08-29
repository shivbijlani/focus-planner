# Domain: diagnostics

## Responsibility

A shared, dependency-free event bus for structured runtime diagnostics, usable from both
the main-thread app and the `folder-sync` service worker. It exists so debugging a sync
issue does not require sprinkling `console.log` through production code paths, and so
enabling verbose tracing carries near-zero cost when it's off.

## Principal module

`packages/diagnostics/src/index.js` (441 lines) is the entire domain. It exposes
enable/disable controls, a ring-buffered per-context event log, a pub/sub sink registry,
and the plumbing needed to pull a diagnostic dump out of the service worker (which cannot
be inspected with normal devtools console access from the page) through a message port.

## Public exports

`diag`, `enableDiagnostics`, `disableDiagnostics`, `isDiagEnabled`, `clearDiagnostics`,
`setDiagnosticsLimit`, `registerDiagSink`, `unregisterDiagSink`, `dumpDiagnostics`,
`dumpAllDiagnostics`, `printDiagnostics`, `resetDiagnosticsForTests`,
`advertiseDiagnosticsToWorker`, `findDiagnosticsWorker`, `requestWorkerDiagnostics`,
`requestWorkerDiagnosticClientStates`, `handleWorkerDiagnosticMessage`,
`setWorkerDiagnosticsForClient`, `reconcileWorkerDiagnosticClients`,
`reconcileWorkerDiagnosticsForClients`.

## Behavioural requirements (from tests)

- Diagnostics must be a **cheap no-op when disabled** — the whole point of a
  production-safe diagnostics layer is that instrumented call sites cost effectively
  nothing until someone opts in.
- Enabled events must **fan out to every registered sink**, and each context's event
  buffer must be a **bounded ring** (old events drop as new ones arrive) so long-running
  sessions cannot leak memory.
- Recording an event must not **emit live console traffic** by itself — console output is
  an explicit, separate action (`printDiagnostics`), not a side effect of recording.
- Events must share **one schema with per-context correlation fields**, so events from
  the main thread and the worker can be correlated into a single timeline.
- A **driven burst** of diagnostic activity must not create console or client-message
  backpressure — the ring buffer and fan-out must stay cheap even under load, which is the
  scenario diagnostics exists to be safe to enable during (a live sync burst).
- The worker buffer must be **pulled only when `dumpAll` is requested** — routine
  operation must not continuously ship the worker's buffer to the main thread.
- A dump request must correctly **select the folder-sync worker instead of the root app
  worker** when more than one worker is registered, and must **serve a worker dump through
  the request message port** rather than a broadcast.
- `printDiagnostics` must **print only an explicitly requested snapshot** — never an
  ambient stream.
- Enabling diagnostics for one client must **not disable it for another client still
  requesting it** — enablement is reference-counted per requester, not a single global
  toggle that the last unsubscriber turns off for everyone.
- A diagnostic client must be **pruned after its tab closes**, so a stale client cannot
  keep worker diagnostics artificially enabled forever.
- After a **worker restart**, the system must re-request and re-advertise enabled state —
  a worker recycling must not silently and permanently disable diagnostics that were
  previously on.

## Failure modes

- Because a service worker has no visible devtools console the way a page tab does,
  diagnostics that only logged to `console` inside the worker would be effectively
  invisible during exactly the kind of sync bug this package exists to help diagnose —
  this is why the message-port dump path exists as a first-class feature, not an
  afterthought.
- A non-ring buffer (unbounded growth) would turn "leave diagnostics on to catch an
  intermittent bug" into a slow memory leak, defeating the point of making the feature
  cheap enough to leave enabled.
