// Board-row hook for the 🤖 agent session link (docs/spec/Domain-agent-metadata.md).
//
// One reader per storage provider, shared by every row. A provider that cannot list a folder
// (no `listDir`) or a planner folder with no `agent-metadata/` folder means the feature is off:
// no reads beyond that one listing and no UI, so a user without an agent sees no change.
import { useEffect, useState } from 'react'
import { canonicalId, fingerprint } from './agentMetadata/fingerprint.js'
import { createAgentMetadataReader, METADATA_DIR } from './storage/agent-metadata-reader.js'
import { onLocalChange } from './storage/storage.js'
import { recordDiagnosticEvent } from './storage/diagnostics.js'

const readers = new WeakMap()
const notifiedGeneration = new WeakMap()
const listeners = new Set()
let wired = false

function notify() {
  for (const fn of listeners) { try { fn() } catch { /* ignore */ } }
}

export function readerFor(provider) {
  if (!provider || typeof provider.listDir !== 'function') return null
  let r = readers.get(provider)
  if (!r) {
    r = createAgentMetadataReader({
      listDir: (dir) => provider.listDir(dir),
      read: (path) => provider.read(path),
      diag: (event, detail) => {
        try { recordDiagnosticEvent('agent-metadata', `${event} ${JSON.stringify(detail || {})}`) } catch { /* never break the board */ }
      },
    })
    readers.set(provider, r)
  }
  return r
}

let activeProvider = null
function refreshActive() {
  const r = readerFor(activeProvider)
  if (!r) return
  r.refresh().then(() => {
    if (r.generation !== notifiedGeneration.get(r)) { notifiedGeneration.set(r, r.generation); notify() }
  }, () => {})
}

function ensureWired() {
  if (wired || typeof document === 'undefined') return
  wired = true
  // The reader itself enforces "at most once every 5 minutes"; these only offer it a chance.
  setInterval(refreshActive, 60 * 1000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshActive() })
  try {
    onLocalChange((name) => { if (String(name || '').startsWith(`${METADATA_DIR}/`)) refreshActive() })
  } catch { /* no engine yet */ }
}

function rowCells(row) {
  const idCell = row?.ID && typeof row.ID === 'object' ? row.ID.id : row?.ID
  return { id: canonicalId(idCell), idCell: String(idCell ?? ''), added: String(row?.Added ?? ''), title: String(row?.Task ?? '') }
}

/** Live session bindings for this board row whose binding-time fingerprint matches the row. */
export function useAgentSessionLinks(provider, row) {
  const [state, setState] = useState({ key: null, links: [] })
  const [tick, setTick] = useState(0)
  const { id, idCell, added, title } = rowCells(row)
  const key = `${id}\n${added}\n${title}`

  useEffect(() => {
    ensureWired()
    const on = () => setTick((t) => t + 1)
    listeners.add(on)
    return () => { listeners.delete(on) }
  }, [])

  useEffect(() => {
    const reader = readerFor(provider)
    if (!reader || !id) return undefined
    activeProvider = provider
    let cancelled = false
    ;(async () => {
      const [fp] = await Promise.all([fingerprint(idCell, added, title), reader.refresh()])
      if (cancelled) return
      setState({ key, provider, links: reader.bindingsFor(id, fp) })
      // One notification per completed refresh, however many rows were waiting on it.
      if (reader.generation !== notifiedGeneration.get(reader)) {
        notifiedGeneration.set(reader, reader.generation)
        notify()
      }
    })().catch(() => {})
    return () => { cancelled = true }
  }, [provider, id, idCell, added, title, key, tick])

  if (state.key !== key || state.provider !== provider) return []
  return state.links
}

/** Every announced device ({ key, name, stale, lastSeenMs }), refreshed with the session links. */
export function useAnnouncedDevices(provider) {
  const [state, setState] = useState({ provider: null, devices: [] })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    ensureWired()
    const on = () => setTick((t) => t + 1)
    listeners.add(on)
    return () => { listeners.delete(on) }
  }, [])

  useEffect(() => {
    const reader = readerFor(provider)
    if (!reader) return undefined
    activeProvider = provider
    let cancelled = false
    reader.refresh().then(() => {
      if (cancelled) return
      setState({ provider, devices: reader.devices() })
      if (reader.generation !== notifiedGeneration.get(reader)) {
        notifiedGeneration.set(reader, reader.generation)
        notify()
      }
    }, () => {})
    return () => { cancelled = true }
  }, [provider, tick])

  return state.provider === provider ? state.devices : []
}
