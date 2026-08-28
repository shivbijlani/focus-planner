// Sweep: scheduled-WORKFLOW health, read straight off the app's own SQLite store.
//
// WHY THIS EXISTS (2026-08-25 20:00 PT)
// ------------------------------------
// The 18:40 run learning recorded a standing rule that ends:
//
//     "This cannot be a `.mjs` sweep - `list_workflows` is an app tool, not a
//      filesystem read - so it stays a prose rule."
//
// That claim is FALSE, and it had already cost real money and time. `workflows` and
// `workflow_runs` are ordinary tables in `%USERPROFILE%\.copilot\data.db`, readable
// read-only with Node 24's built-in `node:sqlite` - no app tool required. A whole
// class of automation was ruled out on an assumption nobody tested.
//
// The cost of leaving it a prose rule was already paid twice:
//   1. "Google Workspace token check" sat `enabled: false` for 54 days. No sweep
//      could see it, and a prose rule only fires when a run remembers to read it.
//   2. `recurring-liveness-sweep.mjs`, being journal-only, still reports #383 and
//      #252 as "UNSCHEDULABLE - no phase will ever run it again" when BOTH are
//      driven by live, healthy weekly workflows. A false alarm carried run to run.
//
// TRAP FOUND WHILE BUILDING THIS - do not use `workflows.last_run_at`
// ------------------------------------------------------------------
// `workflows.last_run_at` is NULL for "Google Workspace token check" even though
// that workflow has a COMPLETED run in `workflow_runs` (2026-08-26T01:37Z). The
// column is not maintained for every trigger path. Dating a workflow by it would
// have reported a healthy job as never-run. Always date from `workflow_runs`.
//
// Also: `interval` alone is not the cadence. The "Overnight Agent" workflow is
// `interval='manual'` with `cron_expression='*/30 * * * *'`. Cron wins when present.
//
// THE WOLF-CRIER FIX (2026-08-27 12:15 PT)
// ---------------------------------------
// `DISABLED` was flagged unconditionally, so "Google token check (folder-bind test)" -
// a placeholder created 2026-07-03 whose prompt is literally
// "placeholder - will configure after verifying workspace binding", disabled, zero runs,
// never executed - appeared under FLAGGED in **17 of 17** archived sweep runs. It can
// never clear on its own.
//
// That is not cosmetic. This is the SAME detector whose flagged line was read and
// skipped in 16 consecutive runs (2026-08-27 11:40 learning) while the hourly Browser
// watchdog was dead for 11 hours. A line that is permanently red is a line that trains
// every future run to skim it - so a false positive here costs real outage time.
//
// Fix follows the precedent already set by `shadow-journal-sweep` and
// `lost-interpolation-sweep`: a deliberately-inert item is ACKNOWLEDGED by a content
// fingerprint and reported apart from findings, and it RE-ARMS the moment anything
// about it changes.
//
// Suppression is deliberately hard to earn - ALL THREE must hold:
//   1. enabled = 0            (an enabled workflow is never suppressed)
//   2. zero runs, ever        (it has never done work, so nothing can have regressed)
//   3. its fingerprint is in workflow-health-baseline.json
// Fingerprint = sha256(id|name|prompt|interval|cron). Edit the prompt, rename it,
// re-schedule it, enable it, or let it run once -> it flags again.
//
// Why this cannot re-hide the bug this sweep was built for: "Google Workspace token
// check" sat disabled for 54 days with runs > 0 and a real prompt, so it fails gate 2
// outright, and was never acknowledged, so it fails gate 3 too. Both independently.
//
// `node workflow-health-sweep.mjs --ack "<name>"` records an acknowledgement.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB = path.join(process.env.USERPROFILE, '.copilot', 'data.db');
const PLANNER = process.env.PLANNER_PATH;

const BASELINE = process.env.WF_BASELINE ||
  path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'workflow-health-baseline.json');

// id|name|prompt|interval|cron - every field a human would have to touch to make this
// workflow real. Any edit changes the hash and the acknowledgement stops applying.
function fingerprint(w) {
  const parts = [w.id, w.name, w.prompt ?? '', w.interval ?? '', w.cron_expression ?? ''];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16);
}

function loadBaseline() {
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    return new Map((j.acknowledged || []).map(e => [e.fingerprint, e]));
  } catch {
    return new Map();
  }
}

if (!fs.existsSync(DB)) {
  console.error(`data.db not found at ${DB} - cannot audit workflows.`);
  process.exit(1);
}

// Tolerances: how far past its cadence a job may drift before it is "overdue".
// Deliberately generous (>=2x the period) so a single skipped tick is not an alarm.
// WF_TOL_SCALE tightens/loosens them for testing: an arm that has never fired on live
// data is an arm nobody has verified, so this exists to prove OVERDUE actually works.
const TOL_SCALE = Number(process.env.WF_TOL_SCALE || 1);
const TOLERANCE_H = { hourly: 3 * TOL_SCALE, daily: 72 * TOL_SCALE, weekly: 240 * TOL_SCALE };

function cadenceOf(w) {
  if (w.cron_expression) {
    // Only the shapes actually in use are decoded; anything else is reported as
    // unknown rather than guessed at. A wrong cadence is worse than no cadence.
    const m = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(w.cron_expression.trim());
    if (m) return { label: `every ${m[1]}m`, hours: Math.max(1, (Number(m[1]) * 3) / 60) * TOL_SCALE };
    return { label: `cron ${w.cron_expression}`, hours: null };
  }
  if (w.interval === 'manual') return { label: 'manual', hours: null };
  return { label: w.interval, hours: TOLERANCE_H[w.interval] ?? null };
}

// Planner task IDs a workflow prompt refers to, so a journal-based sweep can tell
// "nothing will ever run this again" apart from "a workflow runs this".
function taskIdsIn(prompt) {
  const ids = new Set();
  for (const m of prompt.matchAll(/task-(\d{2,4})\.md/g)) ids.add(m[1]);
  for (const m of prompt.matchAll(/task\s*#(\d{2,4})\b/gi)) ids.add(m[1]);
  for (const m of prompt.matchAll(/#(\d{2,4})\b/g)) ids.add(m[1]);
  return [...ids];
}

const db = new DatabaseSync(DB, { readOnly: true });
const workflows = db.prepare(`SELECT id, name, prompt, interval, cron_expression, enabled,
                                     schedule_hour, schedule_minute, schedule_day, next_run_at
                              FROM workflows ORDER BY name`).all();

// Date every workflow from workflow_runs, NOT from workflows.last_run_at (see trap).
const runStmt = db.prepare(`SELECT status, trigger, started_at, completed_at, error_message
                            FROM workflow_runs WHERE task_id = ?
                            ORDER BY started_at DESC LIMIT 1`);
const countStmt = db.prepare(`SELECT COUNT(*) AS n,
                                     SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
                              FROM workflow_runs WHERE task_id = ?`);

const now = new Date();
const baseline = loadBaseline();
const rows = [];
for (const w of workflows) {
  const last = runStmt.get(w.id) || null;
  const counts = countStmt.get(w.id);
  const cad = cadenceOf(w);
  const lastStart = last ? new Date(last.started_at) : null;
  const ageH = lastStart ? (now - lastStart) / 3600000 : null;

  const flags = [];
  if (!w.enabled) flags.push('DISABLED');
  if (w.enabled && counts.n === 0) flags.push('NEVER-RUN');
  if (w.enabled && last && last.status === 'failed') flags.push('LAST-RUN-FAILED');
  if (w.enabled && cad.hours !== null && ageH !== null && ageH > cad.hours) flags.push('OVERDUE');

  // Acknowledged-inert: disabled AND never once run AND fingerprint on file.
  // All three, so neither a live workflow nor one with any run history can be hidden.
  const fp = fingerprint(w);
  const ack = baseline.get(fp);
  const inert = !!ack && !w.enabled && counts.n === 0;

  rows.push({
    id: w.id, name: w.name, enabled: !!w.enabled, cadence: cad.label,
    tolH: cad.hours, ageH, runs: counts.n, failed: counts.failed || 0,
    lastStatus: last?.status ?? null, lastTrigger: last?.trigger ?? null,
    lastStart: last?.started_at ?? null, err: last?.error_message ?? null,
    tasks: taskIdsIn(w.prompt), flags, fingerprint: fp, inert, ackNote: ack?.note ?? null,
  });
}

// --ack "<name>": record an acknowledgement for a disabled, never-run workflow.
const ackIdx = process.argv.indexOf('--ack');
if (ackIdx !== -1) {
  const target = process.argv[ackIdx + 1];
  const r = rows.find(x => x.name === target);
  if (!r) { console.error(`--ack: no workflow named ${JSON.stringify(target)}`); process.exit(1); }
  if (r.enabled || r.runs > 0) {
    console.error(`--ack refused: ${r.name} is enabled=${r.enabled} runs=${r.runs}. ` +
      `Only a disabled, never-run workflow may be acknowledged.`);
    process.exit(1);
  }
  let j = { acknowledged: [] };
  try { j = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { /* first write */ }
  j.acknowledged = (j.acknowledged || []).filter(e => e.fingerprint !== r.fingerprint);
  j.acknowledged.push({
    fingerprint: r.fingerprint, name: r.name, id: r.id,
    acknowledgedAt: now.toISOString(),
    note: process.argv[ackIdx + 2] || 'acknowledged inert',
  });
  fs.writeFileSync(BASELINE, JSON.stringify(j, null, 2));
  console.log(`acknowledged ${r.name} (${r.fingerprint}) -> ${BASELINE}`);
  process.exit(0);
}

const fmtAge = h => h === null ? '  never' : (h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`).padStart(7);

console.log(`workflows: ${rows.length}  (enabled ${rows.filter(r => r.enabled).length})\n`);
for (const r of rows) {
  const tag = r.inert ? 'inert(ack)' : (r.flags.length ? r.flags.join('+') : 'ok');
  console.log(`${tag.padEnd(16)} ${r.name}`);
  console.log(`                 cadence=${r.cadence}  age=${fmtAge(r.ageH)}  runs=${r.runs} (failed ${r.failed})  last=${r.lastStatus ?? '-'}`);
  if (r.tasks.length) console.log(`                 covers tasks: ${r.tasks.map(t => '#' + t).join(' ')}`);
  if (r.err) console.log(`                 error: ${String(r.err).slice(0, 140)}`);
}

const bad = rows.filter(r => r.flags.length && !r.inert);
console.log(`\nFLAGGED (workflow needs attention): ` +
  (bad.map(r => `${r.name} [${r.flags.join('+')}]`).join('; ') || '(none)'));

// Reported APART from findings, so the FLAGGED line can reach zero and stay meaningful.
// Each of these re-arms automatically if it is enabled, ever runs, or is edited.
const inert = rows.filter(r => r.inert);
if (inert.length) {
  console.log(`\nknown-inert, acknowledged (disabled + never run; re-arms on any change): ${inert.length}`);
  for (const r of inert) console.log(`  - ${r.name} [${r.fingerprint}] ${r.ackNote}`);
}

// The cross-check the journal-based sweep structurally cannot do.
const covered = new Set(rows.filter(r => r.enabled && !r.flags.includes('NEVER-RUN')).flatMap(r => r.tasks));
console.log(`\nTasks covered by a LIVE workflow (a journal-based sweep must not call these ` +
  `"unschedulable"): ${[...covered].sort((a, b) => a - b).map(t => '#' + t).join(' ') || '(none)'}`);

if (PLANNER) {
  const outPath = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'workflow-coverage.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated: now.toISOString(), covered: [...covered] }, null, 2));
  console.log(`\ncoverage written to ${outPath} (consumed by recurring-liveness-sweep)`);
}
