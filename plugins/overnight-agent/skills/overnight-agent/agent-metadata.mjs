// agent-metadata.mjs -- the publisher half of per-device agent metadata (item 5; Refs #652).
//
// THE CONTRACT IS docs/spec/Domain-agent-metadata.md. This PC writes exactly one file,
// <planner>/agent-metadata/<device-key>.json, describing its own live task sessions so the app can
// show a 🤖 link on the right board row -- and only on the row the session was bound to: each task
// carries the fingerprint of the row (normalised [ID, Added, Title]) captured at binding time, so
// an edited row or a reused task ID hides the link instead of pointing it at the wrong session.
//
// Run through the sanctioned write tool (it is the only way an agent writes planner files):
//   node write-turn.mjs publish-metadata [-PlannerDir d] [-StateDir d] [-SessionsListFile f]
//                                        [-Revalidate 12,34] [-HeartbeatMinutes 30] [-DryRun]
// It reads the agent's per-task state (written atomically by either state engine, so it needs no
// state lock and works whichever engine bound the sessions) and planner.md. It never writes state,
// journals, the board, or another device's file. Exit 0 ok, 1 write/identity failure, 3 bad args.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireLock, releaseLock } from './oa-state-lib/core/lock.mjs';

export const SCHEMA = 'fp-agent-task-metadata@1';
export const DEVICE_SCHEMA = 'fp-agent-device@1';
export const LEDGER_SCHEMA = 'fp-agent-metadata-publisher@1';
export const METADATA_DIR = 'agent-metadata';
export const SOURCE = 'copilot-app';
export const CAPS = { tasks: 500, bindings: 4, bytes: 256 * 1024 };
export const FILE_NAME_RE = /^[0-9a-f]{32}\.json$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------------------------
// Normalisation and the fingerprint (spec: "The fingerprint"). Pure; mirrored in the app reader.
// ---------------------------------------------------------------------------------------------
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;
const collapse = (s) => s.replace(/\s+/gu, ' ').trim();
const pad2 = (n) => String(n).padStart(2, '0');

function realDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function canonicalId(cell) {
  const local = String(cell ?? '').normalize('NFKC').split(',[')[0];
  const m = /\d+/.exec(local);
  return m ? m[0].replace(/^0+(?=\d)/, '') : null;
}

export function canonicalAdded(cell) {
  const s = collapse(String(cell ?? '').replace(COMMENT_RE, '').normalize('NFKC'));
  if (!s) return '';
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
  if (m && realDate(+m[1], +m[2], +m[3])) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m && realDate(+m[3], +m[1], +m[2])) return `${m[3]}-${pad2(+m[1])}-${pad2(+m[2])}`;
  return s.toLowerCase();
}

export function canonicalTitle(cell) {
  const s = String(cell ?? '').replace(COMMENT_RE, '').normalize('NFKC').replace(EMOJI_RE, '');
  return collapse(s).toLowerCase();
}

export function fingerprintText(id, added, title) {
  const cid = canonicalId(id);
  if (cid === null) return null;
  return `fp-task@1\n${cid}\n${canonicalAdded(added)}\n${canonicalTitle(title)}`;
}

export function fingerprint(id, added, title) {
  const text = fingerprintText(id, added, title);
  if (text === null) return null;
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function deviceKey(deviceId) {
  return crypto.createHash('sha256').update(`fp-device@1\n${String(deviceId).toLowerCase()}`, 'utf8').digest('hex').slice(0, 32);
}

// Safe links (spec: "Safe links"): the Copilot app's own link for exactly this session, or https.
export function safeUrl(url, sessionId) {
  if (typeof url !== 'string' || !url || url.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/.test(url)) return null;
  const app = /^ghapp:\/\/sessions\/([^/?#]+)$/.exec(url);
  if (app) return app[1].toLowerCase() === String(sessionId).toLowerCase() ? url : null;
  if (!url.startsWith('https://')) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return url;
}

// ---------------------------------------------------------------------------------------------
// The board: rows located by header name, cells split exactly as the app splits them.
// ---------------------------------------------------------------------------------------------
export function readBoardRows(text) {
  const rows = new Map();
  let header = null;
  for (const raw of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) { header = null; continue; }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!header) { header = cells; continue; }
    if (cells.length && cells.every((c) => /^[-:]+$/.test(c))) continue;
    const at = (name) => { const i = header.indexOf(name); return i === -1 ? '' : (cells[i] ?? ''); };
    if (header.indexOf('ID') === -1 || header.indexOf('Task') === -1) continue;
    const id = canonicalId(at('ID'));
    if (id === null || rows.has(id)) continue;
    rows.set(id, { id, added: at('Added'), title: at('Task'), fingerprint: fingerprint(at('ID'), at('Added'), at('Task')) });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------
const stripBom = (s) => s.replace(/^\uFEFF/, '');
function readJson(p) {
  if (!fs.existsSync(p)) return { exists: false, value: null };
  try { return { exists: true, value: JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))) }; } catch (e) {
    return { exists: true, value: null, error: e };
  }
}
const serialise = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const pauseMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeAtomic(target, text, { attempts = 5, rename = fs.renameSync } = {}) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp`);
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      rename(tmp, target);
      return;
    } catch (e) {
      last = e;
      pauseMs(100 * 2 ** i);
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  throw last;
}

const isoOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

function deviceName() {
  const raw = process.env.WRITE_TURN_HOST || process.env.COMPUTERNAME || os.hostname() || '';
  const s = String(raw).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 64).trim();
  return s || 'agent-pc';
}

// The sessions list: the raw output of the host's session listing (a JSON array, optionally after
// a one-line header such as "Found 3 item(s):"), or an object holding the array.
export function parseSessionsList(text) {
  const s = stripBom(String(text ?? ''));
  let v;
  try { v = JSON.parse(s); } catch {
    const i = s.search(/[[{]/);
    if (i < 0) throw new Error('no JSON in the sessions list');
    v = JSON.parse(s.slice(i));
  }
  const list = Array.isArray(v) ? v : (Array.isArray(v?.sessions) ? v.sessions : (Array.isArray(v?.items) ? v.items : null));
  if (!list) throw new Error('the sessions list is not an array');
  const map = new Map();
  for (const it of list) {
    const id = String(it?.id ?? it?.session_id ?? it?.project_session_id ?? '');
    if (id) map.set(id.toLowerCase(), { appUrl: typeof it.app_url === 'string' ? it.app_url : null });
  }
  return map;
}

function listStateFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^task-\d+\.json$/i.test(n)).sort();
}

// ---------------------------------------------------------------------------------------------
// The projection (pure given its inputs, so the contract tests can drive it directly).
// ---------------------------------------------------------------------------------------------
export function buildProjection({ states, boardRows, ledger, previous, sessionsList, revalidate = new Set(), now }) {
  const nowIso = new Date(now).toISOString();
  const captures = {};
  const tasks = {};
  const skipped = [];
  for (const { id, state, error } of states) {
    const prevCapture = ledger?.captures?.[id] ?? null;
    if (error) {
      // An unreadable state file is not a release: keep what was published for it.
      if (previous?.tasks?.[id]) { tasks[id] = previous.tasks[id]; if (prevCapture) captures[id] = prevCapture; }
      skipped.push({ id, reason: 'state_unreadable' });
      continue;
    }
    const sess = state?.session;
    if (!sess || String(sess.state ?? '') !== 'live' || !sess.session_id) { skipped.push({ id, reason: 'no_live_session' }); continue; }
    const sessionId = String(sess.session_id);
    if (!SESSION_ID_RE.test(sessionId)) { skipped.push({ id, reason: 'session_id_invalid' }); continue; }
    let cap = prevCapture && String(prevCapture.sessionId).toLowerCase() === sessionId.toLowerCase() ? { ...prevCapture } : null;
    const row = boardRows.get(id);
    if (!row?.fingerprint) {
      // Keep the binding-time capture while its row is gone: a task deleted and recreated under the
      // same ID must be compared against the ORIGINAL row, never recaptured from the new one.
      if (cap) captures[id] = cap;
      skipped.push({ id, reason: row ? 'row_has_no_fingerprint' : 'no_board_row' });
      continue;
    }

    const wokenMs = Date.parse(String(sess.last_woken_at ?? ''));
    const wokeSinceCapture = cap && !Number.isNaN(wokenMs) && wokenMs > Date.parse(cap.capturedAt);
    if (!cap || wokeSinceCapture || revalidate.has(id)) {
      cap = { sessionId, fingerprint: row.fingerprint, capturedAt: nowIso, url: cap?.url ?? null, verifiedAt: cap?.verifiedAt ?? null };
    }
    if (sessionsList) {
      const seen = sessionsList.get(sessionId.toLowerCase());
      if (!seen) { captures[id] = cap; skipped.push({ id, reason: 'session_not_in_host_list' }); continue; }
      cap.url = safeUrl(seen.appUrl, sessionId);
      cap.verifiedAt = nowIso;
    }
    captures[id] = cap;
    const binding = { source: SOURCE, sessionId, status: 'live', boundAt: isoOrNull(sess.created_at), verifiedAt: cap.verifiedAt ?? null };
    const url = safeUrl(cap.url, sessionId);
    if (url) binding.url = url;
    tasks[id] = { fingerprint: cap.fingerprint, bindings: [binding] };
  }
  return { tasks, captures, skipped };
}

export function capTasks(tasks) {
  let truncated = false;
  const ids = Object.keys(tasks).sort((a, b) => Number(a) - Number(b));
  const out = {};
  for (const id of ids.slice(0, CAPS.tasks)) {
    const t = tasks[id];
    const bindings = [...t.bindings].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    if (bindings.length > CAPS.bindings) truncated = true;
    out[id] = { fingerprint: t.fingerprint, bindings: bindings.slice(0, CAPS.bindings) };
  }
  if (ids.length > CAPS.tasks) truncated = true;
  return { tasks: out, truncated };
}

export function buildEnvelope({ device, revision, publishedAt, lastSeenAt, heartbeatMinutes, tasks, truncated }) {
  const env = {
    schema: SCHEMA,
    device: { key: device.key, id: device.id, name: device.name },
    planner: { board: 'planner.md' },
    revision,
    publishedAt,
    lastSeenAt,
    heartbeatMinutes,
    truncated,
    tasks,
  };
  // The size cap drops the highest task IDs until the file fits.
  let text = serialise(env);
  while (Buffer.byteLength(text, 'utf8') > CAPS.bytes && Object.keys(env.tasks).length) {
    const ids = Object.keys(env.tasks);
    delete env.tasks[ids[ids.length - 1]];
    env.truncated = true;
    text = serialise(env);
  }
  return { env, text };
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------
class Bad extends Error { constructor(m) { super(m); this.code = 3; } }

function parseArgs(argv) {
  const allowed = ['PlannerDir', 'StateDir', 'SessionsListFile', 'Revalidate', 'HeartbeatMinutes', 'DryRun'];
  const o = {};
  for (let k = 0; k < argv.length; k++) {
    const m = /^--?([A-Za-z][A-Za-z-]*)(?:[:=]([\s\S]*))?$/.exec(argv[k]);
    if (!m) throw new Bad(`unexpected argument '${argv[k]}'`);
    const key = m[1].toLowerCase().replace(/-/g, '');
    const name = allowed.find((a) => a.toLowerCase() === key);
    if (!name) throw new Bad(`unknown parameter '${m[1]}' (expected ${allowed.map((a) => `-${a}`).join(', ')})`);
    if (name === 'DryRun') { o.DryRun = m[2] === undefined ? true : !/^(false|0|\$false)$/i.test(m[2]); continue; }
    let v = m[2];
    if (v === undefined) { v = argv[++k]; if (v === undefined) throw new Bad(`-${name} needs a value`); }
    o[name] = v;
  }
  return o;
}

function assertInSandbox(p, what) {
  if (!process.env.OA_SANDBOX_ROOT) return;
  const sb = path.resolve(process.env.OA_SANDBOX_ROOT).replace(/[\\/]+$/, '');
  const full = path.resolve(p).replace(/[\\/]+$/, '');
  const inside = full.toLowerCase() === sb.toLowerCase() || full.toLowerCase().startsWith((sb + path.sep).toLowerCase());
  if (!inside) throw new Bad(`oa_sandbox_violation: ${what} '${full}' is outside OA_SANDBOX_ROOT '${sb}'`);
}

function loadDevice(home, { create }) {
  const file = path.join(home, 'device.json');
  const r = readJson(file);
  if (r.exists) {
    const id = r.value?.id;
    if (r.value?.schema !== DEVICE_SCHEMA || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw Object.assign(new Error(`device_identity_corrupt: ${file} is not a ${DEVICE_SCHEMA} file; refusing to invent a new device over it`), { code: 1 });
    }
    return { id: id.toLowerCase(), created: false };
  }
  const id = crypto.randomUUID();
  if (create) {
    fs.mkdirSync(home, { recursive: true });
    writeAtomic(file, serialise({ schema: DEVICE_SCHEMA, id, createdAt: new Date().toISOString() }));
  }
  return { id, created: create };
}

export function publishMetadataCommand(argv, { out, oaHome, now = Date.now() }) {
  const a = parseArgs(argv);
  const home = oaHome();
  const plannerDir = a.PlannerDir || process.env.OVERNIGHT_AGENT_PLANNER_DIR
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'OneDrive', 'Apps', 'Focus Planner') : '');
  if (!plannerDir) throw new Bad('cannot locate the planner folder: pass -PlannerDir or set OVERNIGHT_AGENT_PLANNER_DIR');
  const stateDir = a.StateDir || path.join(home, 'state');
  let heartbeat = 30;
  if (a.HeartbeatMinutes !== undefined) {
    heartbeat = /^\d{1,4}$/.test(String(a.HeartbeatMinutes)) ? Number(a.HeartbeatMinutes) : NaN;
    if (!(heartbeat >= 1 && heartbeat <= 1440)) throw new Bad('-HeartbeatMinutes must be a whole number of minutes from 1 to 1440');
  }
  const revalidate = new Set();
  if (a.Revalidate !== undefined) {
    for (const part of String(a.Revalidate).split(/[\s,]+/).filter(Boolean)) {
      if (!/^\d+$/.test(part)) throw new Bad(`-Revalidate takes task IDs (digits), not '${part}'`);
      revalidate.add(canonicalId(part));
    }
  }
  for (const [p, what] of [[home, 'OA home'], [plannerDir, 'planner folder'], [stateDir, 'state folder']]) assertInSandbox(p, what);
  if (a.SessionsListFile) assertInSandbox(a.SessionsListFile, 'sessions list');

  const boardPath = path.join(plannerDir, 'planner.md');
  if (!fs.existsSync(boardPath)) {
    throw Object.assign(new Error(`planner_board_missing: no planner.md in the planner folder; nothing published (an empty file would read as every link removed)`), { code: 1 });
  }
  let sessionsList = null;
  if (a.SessionsListFile) {
    try { sessionsList = parseSessionsList(fs.readFileSync(a.SessionsListFile, 'utf8')); } catch (e) {
      throw new Bad(`-SessionsListFile is not a session listing (${e.message})`);
    }
  }

  const lock = a.DryRun ? null : acquireLock(path.join(home, 'agent-metadata-publisher.lock'), 60000, {
    timeoutMessage: 'publisher_lock_timeout: another publish on this PC held the lock for 60 s',
    reclaimDeadHolder: true,
    mkdir: true,
  });
  try {
    const warnings = [];
    const dev = loadDevice(home, { create: !a.DryRun });
    if (a.DryRun && dev.created === false && !fs.existsSync(path.join(home, 'device.json'))) warnings.push('device_identity_not_created');
    const device = { id: dev.id, key: deviceKey(dev.id), name: deviceName() };
    const dir = path.join(plannerDir, METADATA_DIR);
    const target = path.join(dir, `${device.key}.json`);
    const rel = `${METADATA_DIR}/${device.key}.json`;

    const ledgerPath = path.join(home, 'agent-metadata-publisher.json');
    const ledgerRead = readJson(ledgerPath);
    const ledger = ledgerRead.value?.schema === LEDGER_SCHEMA ? ledgerRead.value : { schema: LEDGER_SCHEMA, revision: 0, captures: {} };
    if (ledgerRead.exists && ledgerRead.value?.schema !== LEDGER_SCHEMA) warnings.push('publisher_ledger_reset');
    const prevRead = readJson(target);
    const previous = prevRead.value?.schema === SCHEMA && prevRead.value?.device?.key === device.key ? prevRead.value : null;
    const prevRevision = Number.isInteger(previous?.revision) ? previous.revision : 0;
    if (prevRevision > (ledger.revision || 0)) warnings.push('foreign_writer_suspected');

    const states = listStateFiles(stateDir).map((name) => {
      const id = canonicalId(name.slice(5, -5));
      const r = readJson(path.join(stateDir, name));
      return { id, state: r.value, error: r.value === null ? (r.error || new Error('empty')) : null };
    });
    const boardRows = readBoardRows(fs.readFileSync(boardPath, 'utf8'));
    const built = buildProjection({ states, boardRows, ledger, previous, sessionsList, revalidate, now });
    const capped = capTasks(built.tasks);
    const nowIso = new Date(now).toISOString();
    const changed = !previous || JSON.stringify(previous.tasks) !== JSON.stringify(capped.tasks);
    const revision = Math.max(ledger.revision || 0, prevRevision) + 1;
    const { env, text } = buildEnvelope({
      device, revision, heartbeatMinutes: heartbeat, tasks: capped.tasks, truncated: capped.truncated,
      publishedAt: changed ? nowIso : (isoOrNull(previous.publishedAt) ?? nowIso), lastSeenAt: nowIso,
    });
    const bindings = Object.values(env.tasks).reduce((n, t) => n + t.bindings.length, 0);
    const receipt = {
      ok: true, path: rel, written: !a.DryRun, revision, tasks: Object.keys(env.tasks).length, bindings,
      changed, truncated: env.truncated, skipped: built.skipped, warnings,
    };
    if (a.DryRun) {
      receipt.file = env;
    } else {
      fs.mkdirSync(dir, { recursive: true });
      try { writeAtomic(target, text); } catch (e) {
        throw Object.assign(new Error(`metadata_write_failed: ${rel} could not be replaced (${e.code || e.message}); the previous file is unchanged`), { code: 1 });
      }
      writeAtomic(ledgerPath, serialise({ schema: LEDGER_SCHEMA, revision, captures: built.captures }));
    }
    out(receipt);
    return 0;
  } finally {
    releaseLock(lock);
  }
}
