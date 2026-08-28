// Proves stuck-run-sweep's arms actually fire, against a throwaway fixture DB.
//
// The manual's standing lesson: "an arm that has never fired on live data is an arm
// nobody has verified". This sweep is the only one that WRITES to the app's store, so
// it gets the strictest proof: every guard is checked in BOTH directions - it must
// fire on a real orphan, and it must stay silent on each thing that merely resembles one.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SWEEP = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'stuck-run-sweep.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-run-test-'));
const dbPath = path.join(root, 'data.db');
const sessRoot = path.join(root, 'session-state');
const backupDir = path.join(root, 'backups');
fs.mkdirSync(sessRoot, { recursive: true });

// A PID that is certainly dead. PID 0 is never a normal process; use a high unused one.
const DEAD_PID = 999999;
const LIVE_PID = process.pid;

function mkSession(id, { lockPid, events = [], noDir = false, noLock = false } = {}) {
  if (noDir) return id;
  const d = path.join(sessRoot, id);
  fs.mkdirSync(d, { recursive: true });
  if (!noLock && lockPid != null) {
    fs.writeFileSync(path.join(d, `inuse.${lockPid}.lock`), String(lockPid));
  }
  fs.writeFileSync(
    path.join(d, 'events.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
    'utf8'
  );
  return id;
}

const db = new DatabaseSync(dbPath);
db.exec(`create table workflows (id text primary key, name text);`);
db.exec(`create table workflow_runs (
  id text primary key, task_id text, status text, trigger text,
  workspace_id text, session_id text, started_at text, completed_at text,
  error_message text, archived_at text, taken_over_at text
);`);
db.prepare('insert into workflows values (?,?)').run('wf1', 'Fixture watchdog');

const oldIso = new Date(Date.now() - 5 * 3600 * 1000).toISOString();   // 5h ago
const freshIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();   // 2m ago

function addRun(id, sessionId, startedAt, status = 'running') {
  db.prepare(
    `insert into workflow_runs (id, task_id, status, trigger, session_id, started_at)
     values (?,?,?,?,?,?)`
  ).run(id, 'wf1', status, 'schedule', sessionId, startedAt);
}

// --- fixtures -------------------------------------------------------------
// 1. TRUE ORPHAN that had finished its work -> must repair to 'completed'
addRun('r-orphan-done', mkSession('s-orphan-done', {
  lockPid: DEAD_PID,
  events: [
    { type: 'assistant.turn_start', timestamp: oldIso },
    { type: 'session.task_complete', timestamp: '2026-08-27T07:44:34.000Z' },
    { type: 'session.shutdown', timestamp: '2026-08-27T07:44:34.500Z' },
  ],
}), oldIso);

// 2. TRUE ORPHAN that never finished -> must repair to 'failed'
addRun('r-orphan-fail', mkSession('s-orphan-fail', {
  lockPid: DEAD_PID,
  events: [{ type: 'tool.execution_start', timestamp: oldIso }],
}), oldIso);

// 3. LIVE run, old but process alive -> must NOT be touched
addRun('r-live', mkSession('s-live', {
  lockPid: LIVE_PID,
  events: [{ type: 'tool.execution_start', timestamp: oldIso }],
}), oldIso);

// 4. Dead process but INSIDE grace window -> must NOT be touched
addRun('r-young', mkSession('s-young', {
  lockPid: DEAD_PID,
  events: [{ type: 'tool.execution_start', timestamp: freshIso }],
}), freshIso);

// 5. Session dir vanished entirely, old -> orphan, repair to 'failed'
addRun('r-nodir', mkSession('s-nodir', { noDir: true }), oldIso);

// 6. Already terminal -> must be invisible to the sweep entirely
addRun('r-done', mkSession('s-done', { lockPid: DEAD_PID }), oldIso, 'completed');

// --- arm 2 fixtures: process ALIVE, session finished, log gone silent -----
// This is the shape the live recurrence had (PID alive, CPU frozen, no events).
const s7 = mkSession('s-hung', {
  lockPid: LIVE_PID,
  events: [
    { type: 'session.task_complete', timestamp: '2026-08-27T18:46:32.000Z' },
    { type: 'session.shutdown', timestamp: '2026-08-27T18:46:32.500Z' },
    { type: 'session.resume', timestamp: '2026-08-27T18:46:37.000Z' },
  ],
});
// Back-date the log so it reads as idle well past the threshold.
{
  const f = path.join(sessRoot, s7, 'events.jsonl');
  const old = new Date(Date.now() - 45 * 60 * 1000);
  fs.utimesSync(f, old, old);
}
addRun('r-hung', s7, oldIso);

// 8. Process alive, task finished, but log written JUST NOW -> still working, hands off.
addRun('r-busy-done', mkSession('s-busy-done', {
  lockPid: LIVE_PID,
  events: [{ type: 'session.task_complete', timestamp: new Date().toISOString() }],
}), oldIso);

// 9. Process alive, log idle a long time, but task NEVER completed -> a genuinely
//    slow/blocked run. Must NOT be touched: we have no proof its work is done.
{
  const s9 = mkSession('s-idle-unfinished', {
    lockPid: LIVE_PID,
    events: [{ type: 'tool.execution_start', timestamp: oldIso }],
  });
  const f = path.join(sessRoot, s9, 'events.jsonl');
  const old = new Date(Date.now() - 45 * 60 * 1000);
  fs.utimesSync(f, old, old);
  addRun('r-idle-unfinished', s9, oldIso);
}

function run(args = []) {
  const env = {
    ...process.env,
    STUCK_RUN_DB: dbPath,
    STUCK_RUN_SESSION_ROOT: sessRoot,
    STUCK_RUN_BACKUP_DIR: backupDir,
    STUCK_RUN_GRACE_MIN: '20',
  };
  try {
    return { out: execFileSync('node', [SWEEP, ...args], { env, encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status };
  }
}

const checks = [];
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail });
}

// Snapshot the exact pre-state so "wrote nothing" is compared against reality
// rather than a hand-counted constant.
const preState = JSON.stringify(
  db.prepare('select id, status, completed_at, error_message from workflow_runs order by id').all()
);

// --- pass 1: detect-only must find exactly the 3 orphans and change nothing ---
const d = run();
check('detect: exit 1 on findings', d.code === 1, `exit=${d.code}`);
check('detect: reports 4 orphans', /orphaned runs blocking their workflow: 4/.test(d.out));
check('detect: flags the finished orphan', /r-orphan-done/.test(d.out));
check('detect: flags the unfinished orphan', /r-orphan-fail/.test(d.out));
check('detect: flags the vanished-dir orphan', /r-nodir/.test(d.out));
check('arm2: flags the HUNG-ALIVE run', /run=r-hung/.test(d.out));
check('arm2: labels it hung-alive', /arm\s*:\s*hung-alive/.test(d.out));
check('arm2: reports the leaked process', /LEAK\s*:\s*inuse\./.test(d.out));
check('detect: does NOT flag the live run', !/run=r-live/.test(d.out));
check('detect: does NOT flag the in-grace run', !/run=r-young/.test(d.out));
check('detect: does NOT flag an already-terminal run', !/r-done/.test(d.out));
check('arm2: does NOT flag a run still emitting events', !/run=r-busy-done/.test(d.out));
check('arm2: does NOT flag an idle run whose task never completed',
  !/run=r-idle-unfinished/.test(d.out));
check('detect: verdict completed for finished orphan', /verdict\s*:\s*completed/.test(d.out));
check('detect: verdict failed for unfinished orphan', /verdict\s*:\s*failed/.test(d.out));

const afterDetect = JSON.stringify(
  db.prepare('select id, status, completed_at, error_message from workflow_runs order by id').all()
);
check('detect: WROTE NOTHING', afterDetect === preState, afterDetect);

// --- pass 2: repair must fix exactly those 3, from evidence ---
const r = run(['--repair']);
check('repair: exit 1 (findings were present)', r.code === 1, `exit=${r.code}`);
check('repair: reports 4 repaired', /repaired 4 orphaned run/.test(r.out));

const rows = Object.fromEntries(
  db.prepare('select id, status, completed_at, error_message from workflow_runs').all()
    .map(x => [x.id, x])
);
check('repair: finished orphan -> completed', rows['r-orphan-done'].status === 'completed',
  rows['r-orphan-done'].status);
check('repair: uses the REAL completion timestamp',
  rows['r-orphan-done'].completed_at === '2026-08-27T07:44:34.000Z',
  rows['r-orphan-done'].completed_at);
check('repair: unfinished orphan -> failed', rows['r-orphan-fail'].status === 'failed',
  rows['r-orphan-fail'].status);
check('repair: vanished-dir orphan -> failed', rows['r-nodir'].status === 'failed',
  rows['r-nodir'].status);
check('repair: live run UNTOUCHED', rows['r-live'].status === 'running', rows['r-live'].status);
check('repair: in-grace run UNTOUCHED', rows['r-young'].status === 'running', rows['r-young'].status);
check('repair: terminal run UNTOUCHED', rows['r-done'].status === 'completed');
check('arm2: hung-alive run -> completed', rows['r-hung'].status === 'completed',
  rows['r-hung'].status);
check('arm2: hung-alive uses its real completion time',
  rows['r-hung'].completed_at === '2026-08-27T18:46:32.000Z', rows['r-hung'].completed_at);
check('arm2: still-emitting run UNTOUCHED', rows['r-busy-done'].status === 'running',
  rows['r-busy-done'].status);
check('arm2: idle-but-unfinished run UNTOUCHED',
  rows['r-idle-unfinished'].status === 'running', rows['r-idle-unfinished'].status);
check('repair: leaves an explanation', /orphaned at status=running/.test(rows['r-nodir'].error_message ?? ''));

// backups exist and match the pre-state
for (const id of ['r-orphan-done', 'r-orphan-fail', 'r-nodir', 'r-hung']) {
  const f = path.join(backupDir, `${id}.before.json`);
  const ok = fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).status === 'running';
  check(`repair: backed up ${id} in its pre-repair state`, ok);
}

// --- pass 3: idempotent - a second repair must be a no-op ---
const r2 = run(['--repair']);
check('idempotent: second repair finds 0', /orphaned runs blocking their workflow: 0/.test(r2.out));
check('idempotent: second repair exits 0', r2.code === 0, `exit=${r2.code}`);

// --- report ---------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '   <-- ' + c.detail}`);
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
db.close();
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
process.exit(failed ? 1 : 0);
