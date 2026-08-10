const STORAGE_KEY = 'planner.diag'
const DEFAULT_LIMIT = 250
const EVENT_SCHEMA_VERSION = 1
const WORKER_DUMP_TIMEOUT_MS = 1500

const state = {
  enabled: false,
  limit: DEFAULT_LIMIT,
  buffer: [],
  sinks: new Map(),
}
const workerDiagnosticClients = new Set()
let workerReconcilePromise = null
let contextId = null
let contextKind = null
let contextSequence = 0

function root() {
  return typeof globalThis !== 'undefined' ? globalThis : {}
}

function win() {
  const g = root()
  return typeof g.window !== 'undefined' ? g.window : null
}

function isWorkerGlobal() {
  const g = root()
  return !win() && typeof g.self !== 'undefined' && typeof g.self.addEventListener === 'function'
}

function safeLocalStorage() {
  const w = win()
  if (!w || !w.localStorage) return null
  return w.localStorage
}

function shouldAutoEnable() {
  const w = win()
  if (w?.location?.search) {
    try {
      const value = new URLSearchParams(w.location.search).get('diag')
      if (['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase())) return true
    } catch { /* ignore */ }
  }
  try {
    const value = safeLocalStorage()?.getItem(STORAGE_KEY)
    return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase())
  } catch {
    return false
  }
}

function cloneFields(fields) {
  if (!fields || typeof fields !== 'object') return {}
  return { ...fields }
}

function pushBuffer(item) {
  state.buffer.push(item)
  if (state.buffer.length > state.limit) {
    state.buffer.splice(0, state.buffer.length - state.limit)
  }
}

function bufferSink(item) {
  pushBuffer(item)
}

function emit(item) {
  for (const sink of state.sinks.values()) {
    try { sink(item) } catch { /* keep diagnostics non-fatal */ }
  }
}

function makeContextId(kind) {
  const randomId = root().crypto?.randomUUID?.()
  if (randomId) return `${kind}:${randomId}`
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
}

function eventContext() {
  const kind = isWorkerGlobal() ? 'worker' : 'page'
  if (contextKind !== kind || !contextId) {
    contextKind = kind
    contextId = makeContextId(kind)
    contextSequence = 0
  }
  return { kind, id: contextId, sequence: ++contextSequence }
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

function persistEnabled(enabled) {
  try {
    const storage = safeLocalStorage()
    if (!storage) return
    if (enabled) storage.setItem(STORAGE_KEY, '1')
    else storage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}

function postWorkerToggle(enabled) {
  const w = win()
  const sw = w?.navigator?.serviceWorker
  if (!sw) return
  const msg = { type: 'planner-diag-enable', enabled }
  try { sw.controller?.postMessage(msg) } catch { /* ignore */ }
  try {
    sw.ready?.then((reg) => {
      try { reg.active?.postMessage(msg) } catch { /* ignore */ }
    }).catch(() => {})
  } catch { /* ignore */ }
  try {
    sw.getRegistrations?.()
      .then((regs) => {
        for (const reg of regs) {
          for (const worker of [reg.active, reg.waiting, reg.installing]) {
            try { worker?.postMessage(msg) } catch { /* ignore */ }
          }
        }
      })
      .catch(() => {})
  } catch { /* ignore */ }
}

export function advertiseDiagnosticsToWorker(worker) {
  if (typeof worker?.postMessage !== 'function') return false
  const msg = { type: 'planner-diag-enable', enabled: state.enabled }
  try {
    worker.postMessage(msg)
    return true
  } catch {
    return false
  }
}

export function diag(channel, event, fields = {}) {
  if (!state.enabled) return false
  emit(makeEvent(channel, event, fields))
  return true
}

export function isDiagEnabled() {
  return state.enabled
}

export function enableDiagnostics({ persist = true } = {}) {
  state.enabled = true
  if (persist) persistEnabled(true)
  postWorkerToggle(true)
}

export function disableDiagnostics({ persist = true } = {}) {
  state.enabled = false
  if (persist) persistEnabled(false)
  postWorkerToggle(false)
}

export function setWorkerDiagnosticsForClient(clientId, enabled) {
  const id = String(clientId || 'unknown-client')
  if (enabled) workerDiagnosticClients.add(id)
  else workerDiagnosticClients.delete(id)

  if (workerDiagnosticClients.size > 0) {
    if (!state.enabled) enableDiagnostics({ persist: false })
  } else if (state.enabled) {
    disableDiagnostics({ persist: false })
  }
}

export function reconcileWorkerDiagnosticsForClients(clientIds) {
  const liveClients = new Set((clientIds ?? []).map(String))
  for (const clientId of workerDiagnosticClients) {
    if (!liveClients.has(clientId)) workerDiagnosticClients.delete(clientId)
  }
  if (workerDiagnosticClients.size > 0) {
    if (!state.enabled) enableDiagnostics({ persist: false })
  } else if (state.enabled) {
    disableDiagnostics({ persist: false })
  }
}

export function reconcileWorkerDiagnosticClients() {
  if (!isWorkerGlobal()) return Promise.resolve()
  if (workerReconcilePromise) return workerReconcilePromise
  const clients = root().self.clients
  if (!clients?.matchAll) return Promise.resolve()
  workerReconcilePromise = clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((windows) => {
      reconcileWorkerDiagnosticsForClients(windows.map(client => client.id))
    })
    .catch(() => {})
    .finally(() => { workerReconcilePromise = null })
  return workerReconcilePromise
}

export function requestWorkerDiagnosticClientStates(
  clients = isWorkerGlobal() ? root().self.clients : null,
) {
  if (!clients?.matchAll) return Promise.resolve()
  return clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((windows) => {
      reconcileWorkerDiagnosticsForClients(windows.map(client => client.id))
      for (const client of windows) {
        try { client.postMessage({ type: 'planner-diag-state-request' }) } catch { /* ignore */ }
      }
    })
    .catch(() => {})
}

export function clearDiagnostics() {
  state.buffer.length = 0
}

export function dumpDiagnostics() {
  return state.buffer.map((item) => ({
    ...item,
    fields: cloneFields(item.fields),
  }))
}

function isFolderSyncRegistration(registration) {
  try {
    const scopePath = new URL(registration?.scope).pathname
    if (scopePath.endsWith('/folder-sync/')) return true
  } catch { /* fall through to script URLs */ }
  return [registration?.active, registration?.waiting, registration?.installing]
    .some((worker) => {
      try {
        return new URL(worker?.scriptURL).pathname.endsWith('/folder-sync/sw.js')
      } catch {
        return false
      }
    })
}

export function findDiagnosticsWorker(registrations) {
  const registration = (registrations ?? []).find(isFolderSyncRegistration)
  return registration?.active ?? registration?.waiting ?? registration?.installing ?? null
}

function activeServiceWorker() {
  const sw = win()?.navigator?.serviceWorker
  if (!sw?.getRegistrations) return Promise.resolve(null)
  try {
    return sw.getRegistrations()
      .then(findDiagnosticsWorker)
      .catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

export function requestWorkerDiagnostics(
  worker,
  {
    timeoutMs = WORKER_DUMP_TIMEOUT_MS,
    messageChannelFactory,
  } = {},
) {
  const factory = messageChannelFactory
    ?? (typeof root().MessageChannel === 'function' ? () => new (root().MessageChannel)() : null)
  if (typeof worker?.postMessage !== 'function' || !factory) {
    return Promise.resolve({ available: false, events: [] })
  }

  return new Promise((resolve) => {
    const requestId = `diag-dump:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const channel = factory()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      root().clearTimeout?.(timer)
      channel.port1?.close?.()
      resolve(result)
    }
    const timer = root().setTimeout?.(
      () => finish({ available: false, events: [], reason: 'timeout' }),
      timeoutMs,
    )
    channel.port1.onmessage = (evt) => {
      if (evt.data?.type !== 'planner-diag-dump-response' || evt.data.requestId !== requestId) return
      finish({
        available: true,
        events: Array.isArray(evt.data.events) ? evt.data.events : [],
      })
    }
    channel.port1.start?.()
    try {
      worker.postMessage(
        { type: 'planner-diag-dump-request', requestId },
        [channel.port2],
      )
    } catch {
      finish({ available: false, events: [], reason: 'post-failed' })
    }
  })
}

function compareEvents(a, b) {
  const time = Number(a?.t ?? 0) - Number(b?.t ?? 0)
  if (time !== 0) return time
  const context = String(a?.contextId ?? '').localeCompare(String(b?.contextId ?? ''))
  if (context !== 0) return context
  return Number(a?.sequence ?? 0) - Number(b?.sequence ?? 0)
}

export async function dumpAllDiagnostics({ worker, ...requestOptions } = {}) {
  const page = dumpDiagnostics()
  const target = worker === undefined ? await activeServiceWorker() : worker
  const workerSnapshot = await requestWorkerDiagnostics(target, requestOptions)
  const workerEvents = workerSnapshot.events.map(item => ({
    ...item,
    fields: cloneFields(item.fields),
  }))
  return {
    page,
    worker: workerEvents,
    events: [...page, ...workerEvents].sort(compareEvents),
    workerAvailable: workerSnapshot.available,
  }
}

export async function printDiagnostics(options) {
  const snapshot = await dumpAllDiagnostics(options)
  if (typeof console !== 'undefined' && typeof console.log === 'function') {
    console.log('[planner:diagnostics] snapshot', snapshot)
  }
  return snapshot
}

export function setDiagnosticsLimit(limit) {
  const n = Number(limit)
  state.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT
  if (state.buffer.length > state.limit) {
    state.buffer.splice(0, state.buffer.length - state.limit)
  }
}

export function registerDiagSink(name, sink) {
  if (!name || typeof sink !== 'function') throw new Error('registerDiagSink: name and sink are required')
  state.sinks.set(name, sink)
  return () => state.sinks.delete(name)
}

export function unregisterDiagSink(name) {
  state.sinks.delete(name)
}

function installDefaultSinks() {
  state.sinks.set('buffer', bufferSink)
}

function installWindowGlobal() {
  const w = win()
  if (!w) return
  w.__plannerDiag = {
    enable: () => { enableDiagnostics(); return true },
    disable: () => { disableDiagnostics(); return true },
    dump: dumpDiagnostics,
    dumpAll: dumpAllDiagnostics,
    print: printDiagnostics,
    clear: clearDiagnostics,
    isEnabled: isDiagEnabled,
    setLimit: setDiagnosticsLimit,
  }
  try {
    const serviceWorker = w.navigator?.serviceWorker
    serviceWorker?.addEventListener?.('message', (evt) => {
      if (evt.data?.type === 'planner-diag-state-request') {
        if (!advertiseDiagnosticsToWorker(evt.source)) postWorkerToggle(state.enabled)
      }
    })
    serviceWorker?.addEventListener?.('controllerchange', () => postWorkerToggle(state.enabled))
    w.addEventListener?.('pagehide', () => postWorkerToggle(false))
    w.addEventListener?.('pageshow', () => postWorkerToggle(state.enabled))
  } catch { /* ignore */ }
}

function installWorkerListener() {
  if (!isWorkerGlobal()) return
  root().self.addEventListener('message', handleWorkerDiagnosticMessage)
  void requestWorkerDiagnosticClientStates()
}

export function handleWorkerDiagnosticMessage(evt) {
  if (evt.data?.type === 'planner-diag-enable') {
    setWorkerDiagnosticsForClient(evt.source?.id, Boolean(evt.data.enabled))
    void reconcileWorkerDiagnosticClients()
    return true
  }
  if (evt.data?.type === 'planner-diag-dump-request') {
    evt.ports?.[0]?.postMessage({
      type: 'planner-diag-dump-response',
      requestId: evt.data.requestId,
      events: dumpDiagnostics(),
    })
    return true
  }
  return false
}

export function resetDiagnosticsForTests() {
  state.enabled = false
  state.limit = DEFAULT_LIMIT
  state.buffer.length = 0
  state.sinks.clear()
  workerDiagnosticClients.clear()
  workerReconcilePromise = null
  contextId = null
  contextKind = null
  contextSequence = 0
  installDefaultSinks()
}

resetDiagnosticsForTests()
installWindowGlobal()
installWorkerListener()
if (shouldAutoEnable()) {
  enableDiagnostics({ persist: false })
} else {
  // Remove only this page from the worker's enabled-client set. A normal tab
  // must not disable worker diagnostics requested by a separate ?diag=1 tab.
  postWorkerToggle(false)
}
