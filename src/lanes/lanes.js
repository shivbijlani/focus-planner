// Lanes — the app's half of docs/spec/Domain-lanes.md: read and validate agent-lanes.json,
// resolve each task's lane from planner.md (#lane: tags, app assignments, first lane-bearing
// parent through Linked ID), and say which announced devices serve it. Mirrors
// plugins/overnight-agent/skills/overnight-agent/oa-state-lib/plan/lanes.mjs; both run every
// vector in plugins/overnight-agent/tests/lanes/vectors.json, which is what keeps them equal.
//
// The app is the ONLY writer of agent-lanes.json (serializeLanesFile). Absent file = lanes off:
// no lane UI anywhere.

export const LANES_FILE = 'agent-lanes.json'
export const LANES_SCHEMA = 'fp-agent-lanes@1'
export const LANE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
export const RESERVED_LANES = ['none', 'any', 'all', 'catchall', 'default']
export const LIMITS = { bytes: 256 * 1024, devices: 64, deviceLanes: 16, tasks: 2000, depth: 16 }
const TAG_RE = /(?<![\p{L}\p{N}])#[Ll][Aa][Nn][Ee]:([A-Za-z0-9_-]*)/gu
const LINKED_MIN_INDEX = 5

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function isLaneName(name, { allowNone = false } = {}) {
  if (typeof name !== 'string' || !LANE_NAME_RE.test(name)) return false
  if (name === 'none') return allowNone
  return !RESERVED_LANES.includes(name)
}

export function canonicalTaskId(id) {
  const s = String(id ?? '').replace(/^0+(?=\d)/, '')
  return /^\d+$/.test(s) ? s : null
}

/** Validates the text of agent-lanes.json. `null` text = absent = lanes off. */
export function parseLanesFile(text, byteLength = null) {
  if (text === null || text === undefined) return null
  const bad = (reason) => ({ state: 'invalid', reason, devices: {}, tasks: {}, revision: 0 })
  const size = byteLength ?? new TextEncoder().encode(text).length
  if (size > LIMITS.bytes) return bad('too_large')
  const body = String(text).replace(/^\uFEFF/, '')
  if (body.trim() === '') return bad('empty')
  let doc
  try { doc = JSON.parse(body) } catch { return bad('not_json') }
  return validateLanesDoc(doc)
}

export function validateLanesDoc(doc) {
  const bad = (reason) => ({ state: 'invalid', reason, devices: {}, tasks: {}, revision: 0 })
  if (!isPlainObject(doc)) return bad('not_object')
  if (doc.schema !== LANES_SCHEMA) return bad('schema')
  const devices = {}
  if (own(doc, 'devices')) {
    if (!isPlainObject(doc.devices)) return bad('devices')
    const keys = Object.keys(doc.devices)
    if (keys.length > LIMITS.devices) return bad('too_many_devices')
    if (keys.some((k) => !/^[0-9a-f]{32}$/.test(k))) return bad('device_key')
    for (const k of keys) {
      const e = doc.devices[k]
      if (!isPlainObject(e)) return bad('device_entry')
      const lanes = []
      if (own(e, 'lanes')) {
        if (!Array.isArray(e.lanes)) return bad('device_lanes')
        if (e.lanes.length > LIMITS.deviceLanes) return bad('too_many_lanes')
        for (const l of e.lanes) {
          if (!isLaneName(l)) return bad('device_lanes')
          if (!lanes.includes(l)) lanes.push(l)
        }
      }
      let catchAll = false
      if (own(e, 'catchAll')) {
        if (typeof e.catchAll !== 'boolean') return bad('device_catch_all')
        catchAll = e.catchAll
      }
      devices[k] = { lanes: lanes.sort(ordinal), catchAll, name: typeof e.name === 'string' ? e.name : '' }
    }
  }
  const tasks = {}
  if (own(doc, 'tasks')) {
    if (!isPlainObject(doc.tasks)) return bad('tasks')
    const keys = Object.keys(doc.tasks)
    if (keys.length > LIMITS.tasks) return bad('too_many_tasks')
    if (keys.some((k) => !/^(?:0|[1-9][0-9]*)$/.test(k))) return bad('task_id')
    if (keys.some((k) => !isLaneName(doc.tasks[k], { allowNone: true }))) return bad('task_lane')
    for (const k of keys) tasks[k] = doc.tasks[k]
  }
  const revision = Number.isInteger(doc.revision) && doc.revision >= 1 ? doc.revision : 0
  return { state: 'ok', reason: null, devices, tasks, revision }
}

/** The file the app writes: keys in spec order, devices by key, tasks numerically, LF, 2 spaces. */
export function serializeLanesFile({ revision, devices = {}, tasks = {} }, now = new Date()) {
  const outDevices = {}
  for (const k of Object.keys(devices).sort(ordinal)) {
    const d = devices[k]
    const e = {}
    if (d.name) e.name = String(d.name).slice(0, 64)
    e.lanes = [...new Set(d.lanes ?? [])].filter((l) => isLaneName(l)).sort(ordinal)
    e.catchAll = !!d.catchAll
    outDevices[k] = e
  }
  const outTasks = {}
  for (const k of Object.keys(tasks).filter((t) => canonicalTaskId(t) === t).sort((a, b) => Number(a) - Number(b))) {
    if (isLaneName(tasks[k], { allowNone: true })) outTasks[k] = tasks[k]
  }
  const doc = { schema: LANES_SCHEMA, revision, updatedAt: now.toISOString(), devices: outDevices, tasks: outTasks }
  return `${JSON.stringify(doc, null, 2)}\n`
}

const splitCells = (line) => String(line).trim().replace(/^\|+|\|+$/g, '').split('|').map((x) => x.trim())

function boardRowId(line) {
  if (!/^\s*\|/.test(line)) return null
  const first = splitCells(line)[0]
  const m = /^(\d+)/.exec(String(first ?? '').trim())
  return m ? m[1] : null
}

// The engine's Get-BoardRowLinkedIds: header index when it names Linked ID, else the last
// non-empty cell; a date there is not a link.
function linkedIds(line, linkedIndex) {
  const cells = splitCells(String(line).replace(/<!--.*?-->/g, ''))
  let last = cells.length - 1
  while (last >= 0 && cells[last].trim() === '') last--
  if (last < LINKED_MIN_INDEX) return []
  const idx = linkedIndex >= LINKED_MIN_INDEX && linkedIndex <= last ? linkedIndex : last
  const cell = cells[idx] ?? ''
  if (/^\d{4}-\d{2}-\d{2}/.test(cell)) return []
  const ids = []
  for (const m of cell.matchAll(/(?<!\d)\d{1,6}(?!\d)/g)) if (!ids.includes(m[0])) ids.push(m[0])
  return ids
}

/** Per canonical ID: the #lane: tags of every row, and the Linked IDs of the last row. */
export function readLaneBoard(markdown) {
  const tags = {}
  const linked = {}
  let taskIdx = -1
  let linkedIdx = -1
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (/^##\s/.test(line)) { taskIdx = -1; linkedIdx = -1; continue }
    if (!/^\s*\|/.test(line)) continue
    const cells = splitCells(line)
    if (/\bLinked\s*ID\b/i.test(line)) {
      const i = cells.findIndex((c) => /^Linked\s*ID$/i.test(c))
      if (i >= 0) linkedIdx = i
    }
    const raw = boardRowId(line)
    if (!raw) {
      const t = cells.findIndex((c) => c.toLowerCase() === 'task')
      if (t >= 0) taskIdx = t
      continue
    }
    const id = canonicalTaskId(raw)
    if (!id) continue
    if (!own(tags, id)) tags[id] = []
    if (taskIdx >= 0 && taskIdx < cells.length) {
      const cell = cells[taskIdx].replace(/<!--.*?-->/g, '')
      for (const m of cell.matchAll(TAG_RE)) tags[id].push(m[1].toLowerCase())
    }
    linked[id] = linkedIds(line, linkedIdx).map(canonicalTaskId).filter(Boolean)
  }
  return { tags, linked }
}

function ownLane(id, board, tasks) {
  const tagNames = own(board.tags, id) ? board.tags[id] : []
  const names = [...tagNames]
  if (own(tasks, id)) names.push(tasks[id])
  if (names.length === 0) return null
  const source = tagNames.length > 0 ? 'tag' : 'map'
  const candidates = [...new Set(names)].sort(ordinal)
  if (candidates.some((n) => !isLaneName(n, { allowNone: true }))) return { lane: null, source, problem: 'invalid', candidates }
  if (candidates.length > 1) return { lane: null, source, problem: 'conflict', candidates }
  return { lane: candidates[0] === 'none' ? null : candidates[0], source, problem: null, candidates: [] }
}

/** { lane, source: 'tag'|'map'|'inherited'|null, from, problem: null|'conflict'|'invalid', candidates } */
export function resolveTaskLane(id, board, tasks) {
  const visited = new Set([id])
  const walk = (tid, depth) => {
    const o = ownLane(tid, board, tasks)
    if (o) return { ...o, from: tid }
    if (depth >= LIMITS.depth) return null
    for (const p of own(board.linked, tid) ? board.linked[tid] : []) {
      if (visited.has(p)) continue
      visited.add(p)
      const r = walk(p, depth + 1)
      if (r) return r
    }
    return null
  }
  const self = ownLane(id, board, tasks)
  if (self) return { lane: self.lane, source: self.source, from: null, problem: self.problem, candidates: self.candidates }
  for (const p of own(board.linked, id) ? board.linked[id] : []) {
    if (visited.has(p)) continue
    visited.add(p)
    const r = walk(p, 1)
    if (r) return { lane: r.lane, source: 'inherited', from: r.from, problem: r.problem, candidates: r.candidates }
  }
  return { lane: null, source: null, from: null, problem: null, candidates: [] }
}

/** What a device serves: its entry in the file, else unassigned (catch-all). */
export function deviceServes(config, key) {
  const e = config?.state === 'ok' && key && own(config.devices, key) ? config.devices[key] : null
  return { assigned: !!e, lanes: e ? [...e.lanes] : [], catchAll: e ? e.catchAll : true }
}

export function servesLane(serves, lane) {
  return lane === null ? serves.catchAll : serves.lanes.includes(lane)
}

/**
 * The row's lane as the user sees it. `devices` are the announced devices
 * ({ key, name, stale, lastSeenMs }) from the agent-metadata reader.
 * status: 'none' (no lane: nothing to show) | 'served' | 'waiting' | 'problem'
 */
export function laneView(resolution, config, devices) {
  const { lane, problem } = resolution
  if (problem) return { ...resolution, status: 'problem', servedBy: [], assigned: [] }
  if (lane === null) return { ...resolution, status: 'none', servedBy: [], assigned: [] }
  const assigned = Object.keys(config.devices).filter((k) => config.devices[k].lanes.includes(lane))
  const announced = new Map(devices.map((d) => [d.key, d]))
  const servedBy = assigned.map((k) => announced.get(k)).filter((d) => d && !d.stale)
  const assignedInfo = assigned.map((k) => ({
    key: k,
    name: announced.get(k)?.name || config.devices[k].name || k.slice(0, 8),
    lastSeenMs: announced.get(k)?.lastSeenMs ?? null,
  }))
  return { ...resolution, status: servedBy.length ? 'served' : 'waiting', servedBy, assigned: assignedInfo }
}

/** Fresh catch-all devices: two or more can both pick the same task with no lane. */
export function freshCatchAll(config, devices) {
  return devices.filter((d) => !d.stale && deviceServes(config, d.key).catchAll)
}
