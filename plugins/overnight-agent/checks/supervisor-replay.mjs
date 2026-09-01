// supervisor-replay.mjs - validate the #226 supervisor against the REAL run history.
//
// A guard that has only ever been tested on fixtures is a guard nobody has evidence
// for. This replays the classifier over every Overnight Agent run the app has ever
// recorded and answers the only three questions that matter:
//
//   1. of the true stalls (long runs that ended only because the app was restarted),
//      how many would it catch - and HOW EARLY, versus the hours they actually ran?
//   2. of the slow-but-self-terminating runs, how many does it warn on? These are NOT
//      false positives: a 364-minute "completed" run still froze ~11 scheduled ticks.
//   3. of the ordinary healthy runs, how many does it alert on? THIS is the real
//      false-positive metric and it needs to be ~0, because a channel that cries wolf
//      gets skimmed - which is exactly how an 11-hour watchdog outage went unnoticed
//      on 2026-08-27 while a correct detector flagged it 16 times running.
//
// Usage: node supervisor-replay.mjs [--stuck 45] [--tick 15]
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const STUCK_MIN = arg('stuck', 45);
const TICK_MIN  = arg('tick', 15);
const LONG_MIN  = 60;

const DB = process.env.STUCK_RUN_DB || path.join(process.env.USERPROFILE, '.copilot', 'data.db');
// Copy first: the app holds the DB open in WAL mode.
const tmp = path.join(process.env.TEMP, `oa-replay-${Date.now()}.db`);
fs.copyFileSync(DB, tmp);
const db = new DatabaseSync(tmp, { readOnly: true });

const wf = db.prepare('SELECT id FROM workflows WHERE name = ?').get('Overnight Agent');
if (!wf) { console.error('Overnight Agent workflow not found'); process.exit(1); }
const runs = db.prepare(
  'SELECT status, started_at, completed_at, error_message FROM workflow_runs WHERE task_id = ? AND completed_at IS NOT NULL ORDER BY started_at ASC'
).all(wf.id);

const mins = r => (Date.parse(r.completed_at) - Date.parse(r.started_at)) / 60000;

// First supervisor tick, on a TICK_MIN cadence from run start, at which age > STUCK_MIN.
// The supervisor is not synchronised to run starts, so the worst case is a full tick
// of latency; report the worst case rather than the flattering one.
const firstAlertAt = durationMin => {
  for (let t = TICK_MIN; t <= durationMin; t += TICK_MIN) if (t > STUCK_MIN) return t;
  return null;   // ended before any tick could see it as stuck
};

const trueStalls = runs.filter(r => mins(r) > LONG_MIN && r.status === 'failed' && /shutdown/i.test(r.error_message || ''));
const slowOk     = runs.filter(r => mins(r) > LONG_MIN && !(r.status === 'failed' && /shutdown/i.test(r.error_message || '')));
const ordinary   = runs.filter(r => mins(r) <= LONG_MIN);

const fmt = n => n.toLocaleString('en-US');
const hrs = m => (m / 60).toFixed(1);

console.log(`Replay of the #226 supervisor over ${fmt(runs.length)} real runs`);
console.log(`thresholds: STUCK at ${STUCK_MIN} min, supervisor tick every ${TICK_MIN} min\n`);

// -- 1. true stalls -------------------------------------------------------------
let caught = 0, savedMin = 0;
console.log('1. TRUE STALLS - long runs that ended only because the app was restarted');
console.log('   ran(min)  first alert  time the agent would have stopped being dark');
for (const r of trueStalls) {
  const d = Math.round(mins(r));
  const a = firstAlertAt(d);
  if (a !== null) { caught++; savedMin += (d - a); }
  console.log(`   ${String(d).padStart(7)}  ${a === null ? '     (missed)' : String(a).padStart(9) + ' min'}   ${a === null ? '-' : hrs(d - a) + ' h earlier'}`);
}
console.log(`\n   caught ${caught} of ${trueStalls.length}`);
console.log(`   total darkness that would have been surfaced instead of silent: ${hrs(savedMin)} h`);
console.log(`   (these ran ${hrs(trueStalls.reduce((a, r) => a + mins(r), 0))} h in total and NOTHING ever noticed)\n`);

// -- 2. slow but self-terminating ------------------------------------------------
const slowWarned = slowOk.filter(r => firstAlertAt(mins(r)) !== null);
console.log('2. SLOW BUT SELF-TERMINATING - correctly warned, not false positives');
console.log(`   ${slowWarned.length} of ${slowOk.length} would warn; durations(min): ${slowOk.map(r => Math.round(mins(r))).join(', ')}`);
console.log('   each of these held the */30 slot for over an hour, so a warning is right\n');

// -- 3. the real false-positive metric -------------------------------------------
const fp = ordinary.filter(r => firstAlertAt(mins(r)) !== null);
const median = (() => { const a = ordinary.map(mins).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; })();
console.log('3. FALSE POSITIVES - ordinary runs (<= 60 min) that would alert');
console.log(`   ${fp.length} of ${fmt(ordinary.length)}  (median ordinary run: ${median.toFixed(1)} min)`);
if (fp.length) console.log(`   durations(min): ${fp.map(r => Math.round(mins(r))).join(', ')}`);
console.log(`   false-positive rate: ${((fp.length / ordinary.length) * 100).toFixed(2)}%\n`);

const verdict = caught === trueStalls.length && (fp.length / ordinary.length) < 0.01;
console.log(verdict
  ? 'VERDICT: catches every recorded stall, with a sub-1% false-positive rate.'
  : 'VERDICT: review thresholds - see the numbers above.');

// Close before unlinking: an open sqlite handle makes the delete EPERM on Windows,
// which would leak a copy of the app database into TEMP on every run. The -wal/-shm
// sidecars sqlite creates alongside the copy must go too, or two files leak per run.
db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(tmp + suffix, { force: true }); } catch { /* best effort */ }
}
process.exit(verdict ? 0 : 1);
