// lanes.mjs -- lanes: which tasks THIS PC's agent may work (docs/spec/Domain-lanes.md).
//
// READ ONLY. `agent-lanes.json` (beside planner.md) is written by the app alone; nothing in either
// engine writes it, and write-turn's G20 refuses it as a target. Its ABSENCE turns lanes off, and
// with lanes off nothing here changes a single byte of any command's output (readLanes returns
// null and every caller short-circuits). oa-state.ps1 carries the same functions under the same
// names (Read-AgentLanes, Resolve-TaskLane, ...); the characterization goldens pin both.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { joinPath, splitParent } from '../core/context.mjs';
import { readJournalText, testPath } from '../core/fsx.mjs';
import { psIsMatch, psSplit, rxReplace } from '../core/net.mjs';
import { getBoardRowId, getBoardRowLinkedIds } from '../collect/board.mjs';

export const LanesFile = 'agent-lanes.json';
export const LanesSchema = 'fp-agent-lanes@1';
export const DeviceSchema = 'fp-agent-device@1';
export const LaneNameRe = /^[a-z][a-z0-9-]{0,31}$/;
export const ReservedLanes = ['none', 'any', 'all', 'catchall', 'default'];
export const LanesMaxBytes = 256 * 1024;
export const LanesMaxDevices = 64;
export const LanesMaxDeviceLanes = 16;
export const LanesMaxTasks = 2000;
export const LaneWalkMaxDepth = 16;
// `#lane:` (any case) not preceded by a letter or digit; the name is the run of [A-Za-z0-9_-] after
// it, validated afterwards so a malformed name makes the lane INVALID rather than silently absent.
export const LaneTagRe = /(?<![\p{L}\p{N}])#[Ll][Aa][Nn][Ee]:([A-Za-z0-9_-]*)/gu;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function testLaneName(name, { allowNone = false } = {}) {
  if (typeof name !== 'string' || !LaneNameRe.test(name)) return false;
  if (name === 'none') return allowNone;
  return !ReservedLanes.includes(name);
}

export function canonicalTaskId(id) {
  const s = String(id ?? '').replace(/^0+(?=\d)/, '');
  return /^\d+$/.test(s) ? s : null;
}

export function lanesPath(ctx) { return joinPath(splitParent(ctx.p.PlannerBoard), LanesFile); }

// The file as a verdict: null = absent (lanes OFF); { state: 'ok', devices, tasks } or
// { state: 'invalid', reason }. Any violation invalidates the whole file (fail closed).
export function readLanesFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const bad = (reason) => ({ state: 'invalid', reason, devices: {}, tasks: {} });
  if (!st.isFile()) return bad('not_a_file');
  if (st.size > LanesMaxBytes) return bad('too_large');
  let buf;
  try { buf = fs.readFileSync(file); } catch { return bad('unreadable'); }
  if (buf.length > LanesMaxBytes) return bad('too_large');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  const text = new TextDecoder('utf-8').decode(buf);
  if (text.trim() === '') return bad('empty');
  let doc;
  try { doc = JSON.parse(text); } catch { return bad('not_json'); }
  return validateLanesDoc(doc);
}

export function validateLanesDoc(doc) {
  const bad = (reason) => ({ state: 'invalid', reason, devices: {}, tasks: {} });
  if (!isPlainObject(doc)) return bad('not_object');
  if (doc.schema !== LanesSchema) return bad('schema');
  // Keys are checked before values, so the reason reported never depends on key order (JavaScript
  // enumerates integer-like keys first; .NET keeps document order).
  const devices = {};
  if (own(doc, 'devices')) {
    if (!isPlainObject(doc.devices)) return bad('devices');
    const keys = Object.keys(doc.devices);
    if (keys.length > LanesMaxDevices) return bad('too_many_devices');
    if (keys.some((k) => !/^[0-9a-f]{32}$/.test(k))) return bad('device_key');
    for (const k of keys) {
      const e = doc.devices[k];
      if (!isPlainObject(e)) return bad('device_entry');
      const lanes = [];
      if (own(e, 'lanes')) {
        if (!Array.isArray(e.lanes)) return bad('device_lanes');
        if (e.lanes.length > LanesMaxDeviceLanes) return bad('too_many_lanes');
        for (const l of e.lanes) {
          if (!testLaneName(l)) return bad('device_lanes');
          if (!lanes.includes(l)) lanes.push(l);
        }
      }
      let catchAll = false;
      if (own(e, 'catchAll')) {
        if (typeof e.catchAll !== 'boolean') return bad('device_catch_all');
        catchAll = e.catchAll;
      }
      devices[k] = { lanes: lanes.sort(ordinal), catchAll };
    }
  }
  const tasks = {};
  if (own(doc, 'tasks')) {
    if (!isPlainObject(doc.tasks)) return bad('tasks');
    const keys = Object.keys(doc.tasks);
    if (keys.length > LanesMaxTasks) return bad('too_many_tasks');
    if (keys.some((k) => !/^(?:0|[1-9][0-9]*)$/.test(k))) return bad('task_id');
    if (keys.some((k) => !testLaneName(doc.tasks[k], { allowNone: true }))) return bad('task_lane');
    for (const k of keys) tasks[k] = doc.tasks[k];
  }
  return { state: 'ok', reason: null, devices, tasks };
}

// This PC's identity, from the device.json the per-device publisher created in the agent home (the
// parent of the state folder). Never created here: a PC with no identity has never announced, so it
// cannot have been assigned anything.
export function readDeviceKey(stateDir) {
  const file = joinPath(splitParent(stateDir), 'device.json');
  if (!testPath(file)) return { state: 'none', key: null };
  let doc;
  try {
    let buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
    doc = JSON.parse(new TextDecoder('utf-8').decode(buf));
  } catch { return { state: 'corrupt', key: null }; }
  const id = isPlainObject(doc) ? doc.id : null;
  if (doc?.schema !== DeviceSchema || typeof id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    return { state: 'corrupt', key: null };
  }
  const key = crypto.createHash('sha256').update(`fp-device@1\n${id.toLowerCase()}`, 'utf8').digest('hex').slice(0, 32);
  return { state: 'ok', key };
}

// Board facts lanes need: per canonical ID, the #lane: tags of every row and the Linked IDs of the
// row the board map keeps (the last). The Task cell is located by its table's header.
export function readLaneBoard(boardPath) {
  const tags = {};
  const linked = {};
  if (!testPath(boardPath)) return { tags, linked };
  const lines = psSplit(readJournalText(boardPath), '\\r?\\n');
  let taskIdx = -1;
  let linkedIdx = -1;
  for (const line of lines) {
    if (psIsMatch(line, '^##\\s')) { taskIdx = -1; linkedIdx = -1; continue; }
    if (!psIsMatch(line, '^\\s*\\|')) continue;
    const cells = psSplit(String(line).trim().replace(/^\|+|\|+$/g, ''), '\\|').map((x) => String(x).trim());
    if (psIsMatch(line, '\\bLinked\\s*ID\\b')) {
      for (let i = 0; i < cells.length; i++) if (psIsMatch(cells[i], '^Linked\\s*ID$')) { linkedIdx = i; break; }
    }
    const rawId = getBoardRowId(line);
    if (!rawId) {
      const t = cells.findIndex((c) => c.toLowerCase() === 'task');
      if (t >= 0) taskIdx = t;
      continue;
    }
    const id = canonicalTaskId(rawId);
    if (!id) continue;
    if (!own(tags, id)) tags[id] = [];
    if (taskIdx >= 0 && taskIdx < cells.length) {
      const cell = rxReplace(cells[taskIdx], '<!--.*?-->', '');
      for (const m of cell.matchAll(LaneTagRe)) tags[id].push(m[1].toLowerCase());
    }
    linked[id] = getBoardRowLinkedIds(line, linkedIdx).map(canonicalTaskId).filter(Boolean);
  }
  return { tags, linked };
}

function ownLane(id, board, tasks) {
  const tagNames = own(board.tags, id) ? board.tags[id] : [];
  const names = [...tagNames];
  if (own(tasks, id)) names.push(tasks[id]);
  if (names.length === 0) return null;
  const source = tagNames.length > 0 ? 'tag' : 'map';
  const candidates = [...new Set(names)].sort(ordinal);
  if (candidates.some((n) => !testLaneName(n, { allowNone: true }))) {
    return { lane: null, source, problem: 'invalid', candidates };
  }
  if (candidates.length > 1) return { lane: null, source, problem: 'conflict', candidates };
  return { lane: candidates[0] === 'none' ? null : candidates[0], source, problem: null, candidates: [] };
}

// Depth-first through Linked ID, parents in the order written; no task is visited twice in one
// resolution (that also cuts cycles), and the walk stops after LaneWalkMaxDepth levels.
export function resolveTaskLane(id, board, tasks) {
  const visited = new Set([id]);
  const walk = (tid, depth) => {
    const o = ownLane(tid, board, tasks);
    if (o) return { ...o, from: tid };
    if (depth >= LaneWalkMaxDepth) return null;
    for (const p of own(board.linked, tid) ? board.linked[tid] : []) {
      if (visited.has(p)) continue;
      visited.add(p);
      const r = walk(p, depth + 1);
      if (r) return r;
    }
    return null;
  };
  const self = ownLane(id, board, tasks);
  if (self) return { lane: self.lane, source: self.source, from: null, problem: self.problem, candidates: self.candidates };
  for (const p of own(board.linked, id) ? board.linked[id] : []) {
    if (visited.has(p)) continue;
    visited.add(p);
    const r = walk(p, 1);
    if (r) return { lane: r.lane, source: 'inherited', from: r.from, problem: r.problem, candidates: r.candidates };
  }
  return { lane: null, source: null, from: null, problem: null, candidates: [] };
}

// Everything one command needs, or null when lanes are off (no agent-lanes.json).
export function readLanes(ctx) {
  const cfg = readLanesFile(lanesPath(ctx));
  if (cfg === null) return null;
  const device = readDeviceKey(ctx.p.StateDir);
  const board = readLaneBoard(ctx.p.PlannerBoard);
  let state = 'ok';
  let reason = null;
  if (cfg.state !== 'ok') { state = 'invalid'; reason = cfg.reason; } else if (device.state === 'corrupt') {
    state = 'device_identity_corrupt';
    reason = 'device.json in the agent home is not a readable fp-agent-device@1 file';
  }
  const entry = state === 'ok' && device.key && own(cfg.devices, device.key) ? cfg.devices[device.key] : null;
  return {
    state,
    reason,
    device: device.key,
    assigned: !!entry,
    serves: entry ? [...entry.lanes] : [],
    catchAll: state === 'ok' && (entry ? entry.catchAll : true),
    board,
    tasks: cfg.tasks,
  };
}

export function laneFacts(lanes, id) {
  const r = resolveTaskLane(canonicalTaskId(id) ?? String(id), lanes.board, lanes.tasks);
  let served = false;
  if (lanes.state === 'ok' && !r.problem) served = r.lane === null ? lanes.catchAll : lanes.serves.includes(r.lane);
  return { ...r, served };
}

export function addLaneFields(lanes, row) {
  const f = laneFacts(lanes, row.id);
  row.lane = f.lane;
  row.lane_source = f.source;
  row.lane_from = f.from;
  row.lane_problem = f.problem;
  row.lane_candidates = f.candidates;
  row.lane_served_here = f.served;
  return f.served;
}

export function newLanesSummary(lanes, rows) {
  return {
    state: lanes.state,
    reason: lanes.reason,
    device: lanes.device,
    assigned: lanes.assigned,
    serves: [...lanes.serves],
    catch_all: lanes.catchAll,
    rows_out_of_lane: rows.filter((r) => r.lane_served_here === false).length,
  };
}

function describeServes(lanes) {
  const parts = lanes.serves.map((l) => `'${l}'`);
  if (lanes.catchAll) parts.push('tasks with no lane');
  return parts.length ? parts.join(', ') : 'nothing';
}

// The dispatch / bind floor: throws when this PC must not wake or bind a session for task `id`.
export function assertLaneServed(ctx, id) {
  const lanes = readLanes(ctx);
  if (!lanes) return;
  if (lanes.state === 'invalid') {
    throw new Error(`session_lanes_config_invalid: ${LanesFile} does not validate (${lanes.reason}); no task is `
      + 'dispatched or bound on this PC until he fixes it in the app. Do not dispatch it.');
  }
  const f = laneFacts(lanes, id);
  if (f.served) return;
  if (f.problem === 'conflict') {
    throw new Error(`session_lane_conflict: task ${id} has conflicting lanes (${f.candidates.join(', ')}); no PC works it `
      + 'until he resolves it on the board or in the app. Do not dispatch or bind it.');
  }
  if (f.problem === 'invalid') {
    throw new Error(`session_lane_invalid: task ${id} names an invalid lane (${f.candidates.join(', ')}); no PC works it `
      + 'until he fixes it. Do not dispatch or bind it.');
  }
  if (lanes.state === 'device_identity_corrupt') {
    throw new Error(`session_lane_not_served: this PC's device identity is unreadable, so it serves no lane; task ${id} `
      + 'is not dispatched or bound here. Do not dispatch it.');
  }
  const where = f.source === 'tag' ? 'from its #lane: tag' : f.source === 'map' ? 'from his assignment in the app'
    : `inherited from task ${f.from}`;
  const what = f.lane === null ? `task ${id} has no lane (${f.source ? where : 'none set'})` : `task ${id} is in lane '${f.lane}' (${where})`;
  throw new Error(`session_lane_not_served: ${what}; this PC serves ${describeServes(lanes)}. Another PC works it -- `
    + 'do not dispatch or bind it here.');
}
