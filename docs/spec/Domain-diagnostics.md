# Domain: diagnostics

## Responsibility

A single, dependency-free package (`packages/diagnostics/src/index.js`, one file) providing a shared,
opt-in event-tracing facility that spans two runtime contexts — the main app and its dedicated Service
Workers (folder-sync, others) — without adding console noise or backpressure when it is off, which is
its default state.

## Principal module

`packages/diagnostics/src/index.js` — the entire domain. It exposes a producer side (`diag`, per-context
correlation fields, sink registration) and a worker-bridging side (`advertiseDiagnosticsToWorker`,
`findDiagnosticsWorker`, `requestWorkerDiagnostics`, `handleWorkerDiagnosticMessage`), because a Service
Worker has no console a developer is normally looking at, so its diagnostic events must be pulled into
the page on request rather than assumed visible.

## Public surface

`diag, registerDiagSink, unregisterDiagSink, isDiagEnabled, enableDiagnostics, disableDiagnostics,
setDiagnosticsLimit, clearDiagnostics, dumpDiagnostics, dumpAllDiagnostics, printDiagnostics,
resetDiagnosticsForTests` (producer/consumer API); `advertiseDiagnosticsToWorker,
findDiagnosticsWorker, requestWorkerDiagnostics, requestWorkerDiagnosticClientStates,
handleWorkerDiagnosticMessage, reconcileWorkerDiagnosticClients,
reconcileWorkerDiagnosticsForClients, setWorkerDiagnosticsForClient` (worker bridge).

## Behavioural requirements (from tests)

- **A cheap no-op when disabled** — calling `diag(...)` while diagnostics are off must not do
  meaningful work, so instrumenting a hot path costs nothing in production.
- **Fan-out to every registered sink**, using one shared event schema carrying per-context correlation
  fields, so events from the app and a worker can be joined by a caller without bespoke per-context
  parsing.
- **A bounded ring buffer per context** — enabling diagnostics must not grow memory without limit; the
  buffer for a given context discards its oldest entries once its cap is reached.
- **No live console traffic from recording alone** — `diag(...)` records; only an explicit
  `printDiagnostics`/`dumpDiagnostics` call emits to the console, and only for what was actually asked
  for (`dumpAllDiagnostics` pulls a worker's buffer only when a full dump is requested).
- **No backpressure on the message channel during a driven burst** — a rapid sequence of diagnostic
  events between page and worker must not itself become a performance problem.
- **Correct worker targeting**: a request must select the folder-sync worker specifically, not the
  root app worker, when both exist.
- **Multi-client correctness**: worker diagnostics must stay enabled while *any* client still wants
  them, and a client must be pruned from the tracked set once its tab closes — otherwise a closed tab
  would either silently disable diagnostics for a still-open tab, or leak state forever.
- **State survives a worker restart**: enabled clients re-request and the worker re-advertises its
  enabled state after it restarts, so a page doesn't have to know a restart happened.

## Failure modes this domain guards against

- **Diagnostics costing something when off** — the explicit no-op-when-disabled contract exists so this
  facility can be left wired into hot paths across the whole app without a performance argument against
  doing so.
- **A worker's problems being invisible** — the reason a bridging half exists at all: without it, a
  Service Worker failure has no console a developer is looking at and no path to surface state to the
  page that can display it.
- **Cross-tab diagnostic state stepping on itself** — the per-client enable/prune tracking exists
  because multiple tabs can share one Service Worker; a naive single global flag would let one tab's
  close silently turn diagnostics off for every other tab still open against the same worker.
