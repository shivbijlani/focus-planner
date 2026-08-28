// Tests for workflow-health-sweep's acknowledged-inert suppression (2026-08-27).
//
// The suppression exists to stop a permanently-red FLAGGED line desensitising every
// future run. That makes its NEGATIVE cases the important ones: a suppression that can
// hide a real workflow is worse than the false positive it replaces.
//
// So the bulk of these assert that suppression does NOT apply, including a replay of
// the exact bug this sweep was built for ("Google Workspace token check" disabled for
// 54 days) and all three re-arm paths.
//
// Run: node workflow-health-sweep.test.mjs
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SWEEP = path.join(import.meta.dirname, 'workflow-health-sweep.mjs');
let pass = 0, fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

function fingerprint(w) {
  const parts = [w.id, w.name, w.prompt ?? '', w.interval ?? '', w.cron_expression ?? ''];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16);
}

// A throwaway home dir with its own .copilot/data.db, so the live store is never touched.
function makeFixture(workflows, runs = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wfh-'));
  fs.mkdirSync(path.join(home, '.copilot'), { recursive: true });
  const db = new DatabaseSync(path.join(home, '.copilot', 'data.db'));
  db.exec(`CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, prompt TEXT, interval TEXT,
             cron_expression TEXT, enabled INTEGER, schedule_hour INTEGER, schedule_minute INTEGER,
             schedule_day INTEGER, next_run_at TEXT, last_run_at TEXT);
           CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, task_id TEXT, status TEXT, trigger TEXT,
             started_at TEXT, completed_at TEXT, error_message TEXT);`);
  const ins = db.prepare(`INSERT INTO workflows (id,name,prompt,interval,cron_expression,enabled,
                            schedule_hour,schedule_minute,schedule_day,next_run_at,last_run_at)
                          VALUES (?,?,?,?,?,?,8,0,1,NULL,NULL)`);
  for (const w of workflows) {
    ins.run(w.id, w.name, w.prompt ?? '', w.interval ?? 'daily', w.cron_expression ?? null, w.enabled ? 1 : 0);
  }
  const insR = db.prepare(`INSERT INTO workflow_runs (id,task_id,status,trigger,started_at,completed_at,error_message)
                           VALUES (?,?,?,?,?,?,NULL)`);
  let n = 0;
  for (const r of runs) {
    insR.run(`r${n++}`, r.task_id, r.status, 'schedule', r.started_at, r.started_at);
  }
  db.close();
  return home;
}

function run(home, baselineObj, args = []) {
  const bl = path.join(home, 'baseline.json');
  if (baselineObj) fs.writeFileSync(bl, JSON.stringify(baselineObj, null, 2));
  return execFileSync(process.execPath, [SWEEP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, WF_BASELINE: bl, PLANNER_PATH: '' },
  });
}

function flaggedLine(out) {
  return (out.split('\n').find(l => l.startsWith('FLAGGED')) || '').trim();
}

const PLACEHOLDER = {
  id: 'wf-placeholder', name: 'Google token check (folder-bind test)',
  prompt: 'placeholder - will configure after verifying workspace binding',
  interval: 'daily', enabled: false,
};

console.log('workflow-health-sweep: acknowledged-inert suppression\n');

// ---- POSITIVE: the one case suppression is for ------------------------------------
{
  const home = makeFixture([PLACEHOLDER]);
  const ack = { acknowledged: [{ fingerprint: fingerprint(PLACEHOLDER), name: PLACEHOLDER.name, note: 'placeholder' }] };
  const out = run(home, ack);
  check('acked + disabled + 0 runs -> NOT flagged', flaggedLine(out).includes('(none)'), flaggedLine(out));
  check('acked + disabled + 0 runs -> reported as known-inert', /known-inert, acknowledged/.test(out));
  check('acked row is tagged inert(ack), not DISABLED', /inert\(ack\)\s+Google token check/.test(out));
}

// ---- NEGATIVE 1: no baseline at all ------------------------------------------------
{
  const home = makeFixture([PLACEHOLDER]);
  const out = run(home, { acknowledged: [] });
  check('same workflow, NOT acked -> still FLAGGED', flaggedLine(out).includes('folder-bind'), flaggedLine(out));
}

// ---- NEGATIVE 2: the bug this sweep was built for ----------------------------------
// "Google Workspace token check" sat enabled=0 for 54 days but HAD run before.
// Even if someone acknowledged it, runs>0 must defeat the suppression.
{
  const w = { id: 'wf-gws', name: 'Google Workspace token check', prompt: 'check the token', interval: 'daily', enabled: false };
  const home = makeFixture([w], [{ task_id: 'wf-gws', status: 'completed', started_at: '2026-07-04T01:37:00Z' }]);
  const ack = { acknowledged: [{ fingerprint: fingerprint(w), name: w.name, note: 'wrongly acked' }] };
  const out = run(home, ack);
  check('acked BUT has run history -> still FLAGGED (54-day bug cannot re-hide)',
    flaggedLine(out).includes('Google Workspace token check'), flaggedLine(out));
}

// ---- NEGATIVE 3: enabled is never suppressed ---------------------------------------
{
  const w = { ...PLACEHOLDER, id: 'wf-en', enabled: true };
  const home = makeFixture([w]);
  const ack = { acknowledged: [{ fingerprint: fingerprint(w), name: w.name, note: 'acked' }] };
  const out = run(home, ack);
  check('acked but ENABLED -> still FLAGGED (NEVER-RUN)', flaggedLine(out).includes('NEVER-RUN'), flaggedLine(out));
}

// ---- NEGATIVE 4,5,6: every re-arm path ---------------------------------------------
for (const [label, mutate] of [
  ['prompt edited', w => ({ ...w, prompt: 'actually do the google token check now' })],
  ['renamed', w => ({ ...w, name: 'Google token check' })],
  ['re-scheduled', w => ({ ...w, interval: 'weekly' })],
]) {
  const oldFp = fingerprint(PLACEHOLDER);
  const now = mutate(PLACEHOLDER);
  const home = makeFixture([now]);
  const ack = { acknowledged: [{ fingerprint: oldFp, name: PLACEHOLDER.name, note: 'stale ack' }] };
  const out = run(home, ack);
  check(`re-arms when ${label}`, flaggedLine(out).includes('DISABLED'), flaggedLine(out));
}

// ---- --ack guard rails --------------------------------------------------------------
{
  const w = { ...PLACEHOLDER, id: 'wf-ack-en', enabled: true };
  const home = makeFixture([w]);
  let refused = false;
  try { run(home, { acknowledged: [] }, ['--ack', w.name]); } catch { refused = true; }
  check('--ack REFUSES an enabled workflow', refused);
}
{
  const w = { id: 'wf-ack-run', name: 'Has run', prompt: 'p', interval: 'daily', enabled: false };
  const home = makeFixture([w], [{ task_id: 'wf-ack-run', status: 'completed', started_at: '2026-08-01T00:00:00Z' }]);
  let refused = false;
  try { run(home, { acknowledged: [] }, ['--ack', w.name]); } catch { refused = true; }
  check('--ack REFUSES a workflow with run history', refused);
}
{
  const home = makeFixture([PLACEHOLDER]);
  const bl = path.join(home, 'baseline.json');
  run(home, { acknowledged: [] }, ['--ack', PLACEHOLDER.name, 'placeholder from 2026-07-03']);
  const j = JSON.parse(fs.readFileSync(bl, 'utf8'));
  check('--ack writes the fingerprint', j.acknowledged?.[0]?.fingerprint === fingerprint(PLACEHOLDER));
  const out = run(home, null);
  check('--ack output then suppresses on the next run', flaggedLine(out).includes('(none)'), flaggedLine(out));
}

// ---- the sweep still does its original job ------------------------------------------
{
  const w = { id: 'wf-od', name: 'Hourly thing', prompt: 'p', interval: 'manual', cron_expression: '*/30 * * * *', enabled: true };
  const home = makeFixture([w], [{ task_id: 'wf-od', status: 'completed', started_at: '2026-08-01T00:00:00Z' }]);
  const out = run(home, { acknowledged: [] });
  check('OVERDUE still detected', flaggedLine(out).includes('OVERDUE'), flaggedLine(out));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
