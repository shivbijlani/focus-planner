# Domain: diagnostics

`diagnostics` is a single package, `packages/diagnostics/src/index.js`, providing a shared,
low-overhead event/tracing sink used across the app's main thread, its service worker, and the
`folder-sync` engine.

## Responsibility

Give every part of the system — main thread, service worker, folder-sync — one place to emit
structured diagnostic events, and one place for a developer (or the app's own Settings →
Diagnostics panel) to pull them back out, without adding console noise or backpressure during
normal operation.

## Public exports

`advertiseDiagnosticsToWorker`, `clearDiagnostics`, `diag`, `disableDiagnostics`,
`dumpAllDiagnostics`, `dumpDiagnostics`, `enableDiagnostics`, `findDiagnosticsWorker`,
`handleWorkerDiagnosticMessage`, `isDiagEnabled`, `printDiagnostics`,
`reconcileWorkerDiagnosticClients`, `reconcileWorkerDiagnosticsForClients`, `registerDiagSink`,
`requestWorkerDiagnosticClientStates`, `requestWorkerDiagnostics`, `resetDiagnosticsForTests`,
`setDiagnosticsLimit`, `setWorkerDiagnosticsForClient`, `unregisterDiagSink`.

## Behavioural requirements (from `packages/diagnostics/src/index.test.js`)

- It **is a cheap no-op when disabled** — calling `diag()` costs effectively nothing until
  `enableDiagnostics()` is called, so instrumentation can be left in shipped code everywhere.
- It **fans out enabled events to every registered sink** — multiple consumers (e.g. a console sink
  and a UI panel) can subscribe independently via `registerDiagSink`.
- It **keeps each context buffer bounded as a ring** — a long-running session cannot grow the buffer
  unboundedly; `setDiagnosticsLimit` bounds retention per context.
- It **records without emitting live console traffic** — diagnostics are captured silently and only
  surfaced on demand (`printDiagnostics`/`dumpDiagnostics`), so normal operation is not noisier with
  diagnostics on than off.
- It **uses a shared event schema with per-context correlation fields**, so events from the main
  thread and from the service worker can be correlated into one timeline.
- It **does not create console or client-message backpressure during a driven burst** — a flood of
  events (e.g. a rapid sync cycle) cannot itself slow the app down or flood postMessage.
- Worker-side dumps are selective: it **pulls the worker buffer only when `dumpAll` is requested**,
  **selects the folder-sync worker instead of the root app worker** when both exist, **serves a
  worker dump through the request message port**, and **prints only an explicitly requested
  snapshot** — nothing is pulled from a worker speculatively.
- Multi-client coordination: it **keeps worker diagnostics enabled while another client still
  requests them** (reference-counted, not last-writer-wins), **prunes a diagnostic client after its
  tab closes**, and **requests and re-advertises enabled state after a worker restart** — a service
  worker can be killed and restarted by the browser at any time, and diagnostics state must survive
  that without a client having to notice and re-enable it.

## Failure modes guarded against

A diagnostics system that is expensive when idle would be disabled in practice (the very thing it
exists to avoid); one that is noisy would train developers to mute it; one that forgets state across
a service-worker restart would appear "randomly" disabled. Each behavioural requirement above exists
to close one of those specific failure shapes.
