// Lanes store (docs/spec/Domain-lanes.md): agent-lanes.json as the app sees it, one per storage
// provider, shared by the board rows, the row menu and the Devices & lanes settings section.
//
// Absent file = lanes off = no lane UI. Reads are cheap but may be remote, so a refresh runs at
// most once every 5 minutes unless forced (a local edit, a save, the settings section opening).
// The app is the only writer of the file; every write re-reads it first and refuses to build on a
// copy that does not validate.
import { createContext, useCallback, useEffect, useSyncExternalStore } from 'react'
import { LANES_FILE, parseLanesFile, serializeLanesFile } from './lanes/lanes.js'
import { onLocalChange } from './storage/storage.js'

const REFRESH_MS = 5 * 60 * 1000
const stores = new WeakMap()
let wired = false
const allStores = new Set()

/** The board markdown (planner.md) rows resolve inherited lanes against. */
export const LanesBoardContext = createContext('')

function storeFor(provider) {
  if (!provider || typeof provider.read !== 'function') return null
  let s = stores.get(provider)
  if (s) return s
  s = {
    provider,
    snapshot: { status: 'unknown', config: null },
    lastAt: null,
    inflight: null,
    listeners: new Set(),
    notify() { for (const fn of this.listeners) { try { fn(this.snapshot) } catch { /* ignore */ } } },
    async load({ force = false } = {}) {
      if (this.inflight) return this.inflight
      if (!force && this.lastAt !== null && Date.now() - this.lastAt < REFRESH_MS) return this.snapshot
      this.lastAt = Date.now()
      this.inflight = (async () => {
        let text
        try {
          text = await this.provider.read(LANES_FILE)
        } catch (e) {
          // A missing file reads as an error on some providers; anything else keeps what we had.
          if (isMissing(e)) text = null
          else return this.snapshot
        }
        const config = parseLanesFile(asPresent(text))
        const next = config === null ? { status: 'off', config: null } : { status: config.state, config }
        if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) { this.snapshot = next; this.notify() }
        return this.snapshot
      })().finally(() => { this.inflight = null })
      return this.inflight
    },
  }
  stores.set(provider, s)
  allStores.add(s)
  return s
}

// Browser storage reads a missing file as '', so an empty file cannot be told from an absent one:
// the app treats both as absent (lanes off). Writers never produce an empty file; the engine, which
// can tell, still fails closed on one.
function asPresent(text) {
  return text === null || text === undefined || String(text).trim() === '' ? null : text
}

function isMissing(e) {
  const msg = String(e?.message ?? e ?? '')
  return e?.code === 'ENOENT' || e?.name === 'NotFoundError' || e?.status === 404 || /not.?found|no such file|does not exist/i.test(msg)
}

function ensureWired() {
  if (wired) return
  wired = true
  try {
    onLocalChange((name) => {
      if (String(name || '') !== LANES_FILE) return
      for (const s of allStores) s.load({ force: true }).catch(() => {})
    })
  } catch { /* no engine yet */ }
}

/** { status: 'unknown' | 'off' | 'ok' | 'invalid', config } for the provider's planner folder. */
export function useLanes(provider, { force = false } = {}) {
  const store = storeFor(provider)
  const subscribe = useCallback((cb) => {
    if (!store) return () => {}
    store.listeners.add(cb)
    return () => { store.listeners.delete(cb) }
  }, [store])
  const snap = useSyncExternalStore(subscribe, () => (store ? store.snapshot : OFF))
  useEffect(() => {
    if (!store) return
    ensureWired()
    store.load({ force }).catch(() => {})
  }, [store, force])
  return snap
}

const OFF = Object.freeze({ status: 'off', config: null })

/**
 * Read-modify-write of agent-lanes.json. `mutate(draft)` edits { devices, tasks } in place.
 * Refuses when the current file does not validate (it would build on a broken copy).
 */
export async function updateLanes(provider, write, mutate) {
  let text = null
  try { text = await provider.read(LANES_FILE) } catch (e) { if (!isMissing(e)) throw e }
  const current = parseLanesFile(asPresent(text))
  if (current && current.state !== 'ok') throw new Error(`agent-lanes.json does not validate (${current.reason}); replace it first`)
  const draft = {
    devices: Object.fromEntries(Object.entries(current?.devices ?? {}).map(([k, d]) => [k, { ...d, lanes: [...d.lanes] }])),
    tasks: { ...(current?.tasks ?? {}) },
  }
  mutate(draft)
  const next = serializeLanesFile({ revision: (current?.revision ?? 0) + 1, ...draft })
  await write(LANES_FILE, next)
  const store = storeFor(provider)
  if (store) await store.load({ force: true })
}

/** Replace a broken file with an empty valid one (every PC becomes catch-all, tags still count). */
export async function resetLanes(provider, write) {
  await write(LANES_FILE, serializeLanesFile({ revision: 1, devices: {}, tasks: {} }))
  const store = storeFor(provider)
  if (store) await store.load({ force: true })
}

/** Turn lanes off: delete the file, returning every PC to today's behaviour. */
export async function removeLanes(provider, remove) {
  await remove(LANES_FILE)
  const store = storeFor(provider)
  if (store) await store.load({ force: true })
}
