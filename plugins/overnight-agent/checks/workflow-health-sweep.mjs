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
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB = path.join(process.env.USERPROFILE, '.copilot', 'data.db');
const PLANNER = process.env.PLANNER_PATH;

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

  rows.push({
    id: w.id, name: w.name, enabled: !!w.enabled, cadence: cad.label,
    tolH: cad.hours, ageH, runs: counts.n, failed: counts.failed || 0,
    lastStatus: last?.status ?? null, lastTrigger: last?.trigger ?? null,
    lastStart: last?.started_at ?? null, err: last?.error_message ?? null,
    tasks: taskIdsIn(w.prompt), flags,
  });
}

const fmtAge = h => h === null ? '  never' : (h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`).padStart(7);

console.log(`workflows: ${rows.length}  (enabled ${rows.filter(r => r.enabled).length})\n`);
for (const r of rows) {
  const tag = r.flags.length ? r.flags.join('+') : 'ok';
  console.log(`${tag.padEnd(16)} ${r.name}`);
  console.log(`                 cadence=${r.cadence}  age=${fmtAge(r.ageH)}  runs=${r.runs} (failed ${r.failed})  last=${r.lastStatus ?? '-'}`);
  if (r.tasks.length) console.log(`                 covers tasks: ${r.tasks.map(t => '#' + t).join(' ')}`);
  if (r.err) console.log(`                 error: ${String(r.err).slice(0, 140)}`);
}

const bad = rows.filter(r => r.flags.length);
console.log(`\nFLAGGED (workflow needs attention): ` +
  (bad.map(r => `${r.name} [${r.flags.join('+')}]`).join('; ') || '(none)'));

// The cross-check the journal-based sweep structurally cannot do.
const covered = new Set(rows.filter(r => r.enabled && !r.flags.includes('NEVER-RUN')).flatMap(r => r.tasks));
console.log(`\nTasks covered by a LIVE workflow (a journal-based sweep must not call these ` +
  `"unschedulable"): ${[...covered].sort((a, b) => a - b).map(t => '#' + t).join(' ') || '(none)'}`);

if (PLANNER) {
  const outPath = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'workflow-coverage.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated: now.toISOString(), covered: [...covered] }, null, 2));
  console.log(`\ncoverage written to ${outPath} (consumed by recurring-liveness-sweep)`);
}
