const STORAGE_KEY = 'planner.diag'
const DEFAULT_LIMIT = 250

const state = {
  enabled: false,
  limit: DEFAULT_LIMIT,
  buffer: [],
  sinks: new Map(),
}
const workerDiagnosticClients = new Set()

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

function consoleSink(item) {
  if (typeof console === 'undefined') return
  const prefix = `[planner:${item.channel}] ${item.event}`
  // Keep this to one CDP event. console.table emits another, comparatively
  // expensive event for every diagnostic record; a normal mirror pass can scan
  // hundreds of files, flooding the automation transport while the page itself
  // remains visually responsive.
  if (typeof console.debug === 'function') console.debug(prefix, item.fields)
}

function bufferSink(item) {
  pushBuffer(item)
}

function relaySink(item) {
  const g = root()
  const clients = g.self?.clients
  if (!clients || typeof clients.matchAll !== 'function') return
  clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((windows) => {
      for (const client of windows) client.postMessage({ type: 'planner-diag-event', event: item })
    })
    .catch(() => {})
}

function emit(item) {
  for (const sink of state.sinks.values()) {
    try { sink(item) } catch { /* keep diagnostics non-fatal */ }
  }
}

function makeEvent(channel, event, fields = {}) {
  return {
    ts: new Date().toISOString(),
    t: Date.now(),
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

export function clearDiagnostics() {
  state.buffer.length = 0
}

export function dumpDiagnostics() {
  return state.buffer.map((item) => ({
    ...item,
    fields: cloneFields(item.fields),
  }))
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
  state.sinks.set('console', consoleSink)
  state.sinks.set('buffer', bufferSink)
  if (isWorkerGlobal()) state.sinks.set('relay', relaySink)
}

function ingestRelayedEvent(item) {
  if (!state.enabled || !item || typeof item !== 'object') return
  emit({
    ...item,
    fields: cloneFields(item.fields),
    relayed: true,
  })
}

function installWindowGlobal() {
  const w = win()
  if (!w) return
  w.__plannerDiag = {
    enable: () => { enableDiagnostics(); return true },
    disable: () => { disableDiagnostics(); return true },
    dump: dumpDiagnostics,
    clear: clearDiagnostics,
    isEnabled: isDiagEnabled,
    setLimit: setDiagnosticsLimit,
  }
  try {
    w.navigator?.serviceWorker?.addEventListener?.('message', (evt) => {
      if (evt.data?.type === 'planner-diag-event') ingestRelayedEvent(evt.data.event)
    })
  } catch { /* ignore */ }
}

function installWorkerListener() {
  if (!isWorkerGlobal()) return
  root().self.addEventListener('message', (evt) => {
    if (evt.data?.type !== 'planner-diag-enable') return
    setWorkerDiagnosticsForClient(evt.source?.id, Boolean(evt.data.enabled))
  })
}

export function resetDiagnosticsForTests() {
  state.enabled = false
  state.limit = DEFAULT_LIMIT
  state.buffer.length = 0
  state.sinks.clear()
  workerDiagnosticClients.clear()
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
