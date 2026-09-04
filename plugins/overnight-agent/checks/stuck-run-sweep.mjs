// Sweep: ORPHANED workflow runs - a run stuck at status='running' whose process is dead.
//
// WHY THIS EXISTS (2026-08-27 11:40 PT)
// ------------------------------------
// The hourly "Browser watchdog" was DEAD FOR 11 HOURS and nothing recovered it.
//
// What happened: the 07:43:45Z run did its job correctly - its own event log shows
// `session.task_complete` at 07:44:34Z - then began `session.shutdown`, got a
// `session.resume` at 07:44:39Z, and the process (PID 12332) died without ever
// writing a terminal status. That left `workflow_runs.status = 'running'` forever.
//
// Why that is fatal rather than cosmetic: the app refuses to start a workflow while
// it believes one is running. Verified live - `run_workflow` returned
// "Workflow 'Browser watchdog' is already running." So a single orphaned row
// PERMANENTLY DISABLES that workflow, for both the scheduler and manual triggers.
// 148 consecutive hourly runs had completed in 40-90s each; then zero.
//
// Why a detector was not enough: `workflow-health-sweep` DID flag it, correctly, as
// `OVERDUE ... last=running`. It printed that in 16 CONSECUTIVE Overnight Agent runs
// (07:52 -> 11:38 PT) and not one of them acted on it. That is the same failure this
// file's user-settings manual keeps recording: a detector goes red and the report is
// skimmed. So this sweep does not only report - with `--repair` it FIXES, because the
// evidence needed to fix is exactly the evidence needed to detect.
//
// THE LIVENESS SIGNAL (verified on live data before trusting it)
// -------------------------------------------------------------
// Each session dir holds `inuse.<pid>.lock`. Checked live 2026-08-27:
//   - dead orphan  c4429257 -> inuse.12332.lock, PID 12332 GONE
//   - live watchdog 3ad556ad -> inuse.23684.lock, PID 23684 alive
//   - this very run 298ea26b -> inuse.4804.lock,  PID 4804  alive
// So "lock PID is not alive" is a crisp, provable orphan signal, and a live run -
// INCLUDING THE ONE RUNNING THIS SWEEP - can never be mistaken for an orphan.
//
// ARM 2 - THE HUNG-ALIVE ORPHAN (added the same run, after arm 1 proved insufficient)
// -----------------------------------------------------------------------------------
// Recovering the watchdog made it reproduce the fault immediately, and the recurrence
// had a DIFFERENT shape: PID 23684 was still ALIVE, CPU frozen at 5.453125 across a
// 20s sample, no event written for 6 minutes. Same trail as the first occurrence:
// `session.task_complete` -> `session.shutdown` -> a NEW copilot process `session.resume`s
// the session -> that process idles forever holding both the lock and the running row.
//
// So arm 1's "lock PID is dead" test would have MISSED the live recurrence. Arm 2
// catches it on evidence instead of process death: the session's own log says the task
// COMPLETED and nothing has been written since. That is a finished run whose
// bookkeeping never landed, so releasing it restores the truth.
//
// Arm 2 deliberately does NOT kill the idle process - unblocking the schedule is this
// tool's job, and killing one of Shiv's processes is a separate, less reversible
// decision. The leak IS reported, because ~270 MB/hour of idle `copilot` processes is
// a plausible contributor to the "leftover programs eating 5 GB" symptom on #448.
//
// ARM 3 - THE RUN-LEVEL TIMEOUT (GH #261, added 2026-09-04)
// -----------------------------------------------------------------------------------
// Arms 1 and 2 both require proof about the run's OUTCOME: a dead process, or a
// `session.task_complete` that already fired. A run that hangs MID-TASK has neither, so
// it fell through and was printed as `ok` while it blocked its workflow indefinitely.
// That is GH #261 exactly: `running` since 15:00:28Z, still `running` 9 hours later, with
// `nextRunAt` 8.5h overdue and never fired. A single hung run silently disables the whole
// */30 automation, and the sweep that exists to catch that called it healthy.
//
// It is NOT a plain max-runtime, which is what the issue first proposed. GH #330 measured
// that run DURATION routinely exceeds the schedule - one run spanned 50 minutes, another
// was still emitting after two hours - so failing a run for being long would kill healthy
// work, and would do it on the largest runs first. Age is not evidence of hanging.
// SILENCE is: a live agent writes events constantly, so an hour with nothing written is a
// stopped run, not a slow one. Arm 3 requires BOTH gates, and resolves to `failed` rather
// than `completed`, because recording that a run stopped is a fact while claiming it
// finished would be inventing an outcome.
//
// SAFETY (this is the only sweep that writes to the app's DB)
// ----------------------------------------------------------
//   * Detect-only by default. Writing requires an explicit `--repair`.
//   * Grace period (default 20 min) - a young run is never touched, so a session
//     that is still starting up cannot be raced.
//   * A run is repaired ONLY if its process is provably dead (arm 1) OR its own event
//     log proves the task finished and the log has been idle for IDLE_MIN (arm 2).
//     A run that is merely slow - alive, still emitting events - is never touched.
//   * Every row is backed up to disk as JSON before it is touched, so any repair is
//     revertible from the file it wrote.
//   * The terminal status is read from the session's OWN event log, not guessed:
//     `session.task_complete` -> completed (with that real timestamp); otherwise
//     -> failed. The 07:43 run genuinely finished, so calling it 'completed' is
//     restoring the truth, not inventing it.
//   * UPDATE is guarded with `and status='running'`, so it is idempotent and cannot
//     clobber a status the app has since written itself.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Paths are overridable ONLY so the arms can be proven on a throwaway fixture.
// An arm that has never fired on data is an arm nobody has verified - see
// stuck-run-sweep.test.mjs, which exercises detect + repair against a temp DB.
const DB = process.env.STUCK_RUN_DB
  || path.join(process.env.USERPROFILE, '.copilot', 'data.db');
const SESSION_ROOT = process.env.STUCK_RUN_SESSION_ROOT
  || path.join(process.env.USERPROFILE, '.copilot', 'session-state');
const BACKUP_DIR = process.env.STUCK_RUN_BACKUP_DIR
  || path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'stuck-run-backups');

const REPAIR = process.argv.includes('--repair');
// Sized well above a normal run (40-90s) and above the 30-min agent cadence is NOT
// required here: the orphan test is process death, not age. Age is only a race guard.
const GRACE_MIN = Number(process.env.STUCK_RUN_GRACE_MIN || 20);
// Arm 2: how long a session's event log must be SILENT before a run whose task has
// already completed is treated as hung. Must exceed the longest gap a healthy run
// leaves between events; observed healthy watchdog runs finish end-to-end in 40-90s.
const IDLE_MIN = Number(process.env.STUCK_RUN_IDLE_MIN || 15);

// --- Arm 3 thresholds: the RUN-LEVEL TIMEOUT (GH #261) --------------------------------
// Arms 1 and 2 both need proof about the run's OUTCOME: a dead process, or a
// `session.task_complete` that already fired. A run that hangs MID-TASK has neither - the
// process is alive and it never said it finished - so it fell through to `ok` and blocked
// its workflow forever. Measured on the live board: `running` since 15:00:28Z, still
// `running` 9 hours later, `nextRunAt` 8.5h overdue and never fired.
//
// WHY THIS IS NOT A PLAIN MAX-RUNTIME, which is what #261 first suggested.
// -------------------------------------------------------------------------------------
// GH #330 measured that run DURATION routinely exceeds the schedule: one run spanned
// 05:18 -> 06:09 (50 min), another was still emitting after two hours. Failing a run for
// being long would therefore kill healthy work, and would do it precisely on the biggest,
// most valuable runs. Age alone is not evidence of hanging.
//
// The evidence of hanging is SILENCE. A live agent writes events constantly - tool calls,
// assistant turns - so an hour with nothing written is not a slow run, it is a stopped one.
// Both conditions must hold, so a two-hour run that is still emitting is never touched.
const MAX_RUNTIME_MIN = Number(process.env.STUCK_RUN_MAX_RUNTIME_MIN || 180);
const STALL_MIN = Number(process.env.STUCK_RUN_STALL_MIN || 60);

if (!fs.existsSync(DB)) {
  console.error(`data.db not found at ${DB} - cannot audit workflow runs.`);
  process.exit(1);
}

/** Is this PID alive? signal 0 probes without touching the process. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is not ours - still alive.
    return e.code === 'EPERM';
  }
}

/**
 * Decide whether a run's owning session process is dead.
 * Returns { dead, why }. Anything uncertain returns dead:false - this tool must
 * never repair on a guess.
 */
function sessionLiveness(sessionId) {
  if (!sessionId) return { dead: true, why: 'run has no session id at all' };

  const dir = path.join(SESSION_ROOT, sessionId);
  if (!fs.existsSync(dir)) {
    return { dead: true, why: 'session-state dir does not exist' };
  }

  const locks = fs.readdirSync(dir).filter(f => /^inuse\.\d+\.lock$/.test(f));
  if (locks.length === 0) {
    return { dead: true, why: 'no inuse lock file - nothing holds the session' };
  }

  const live = [];
  const dead = [];
  for (const l of locks) {
    const pid = Number(/^inuse\.(\d+)\.lock$/.exec(l)[1]);
    (pidAlive(pid) ? live : dead).push(pid);
  }
  if (live.length > 0) {
    return { dead: false, why: `held by live pid ${live.join(',')}` };
  }
  return { dead: true, why: `lock pid ${dead.join(',')} is gone` };
}

/**
 * Read the session's own event log to find out what actually happened, so the
 * repaired status reflects reality instead of an assumption.
 */
async function readOutcome(sessionId) {
  const f = path.join(SESSION_ROOT, sessionId ?? '', 'events.jsonl');
  if (!sessionId || !fs.existsSync(f)) {
    return { completed: false, at: null, lastType: null, lastAt: null };
  }
  let completed = false;
  let at = null;
  let lastType = null;
  let lastAt = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(f, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    lastType = o.type ?? lastType;
    lastAt = o.timestamp ?? lastAt;
    if (o.type === 'session.task_complete') {
      completed = true;
      at = o.timestamp ?? at;
    }
  }
  return { completed, at, lastType, lastAt };
}

/** How long since the session last wrote an event, in minutes. null if unknown. */
function idleMinutes(sessionId) {
  const f = path.join(SESSION_ROOT, sessionId ?? '', 'events.jsonl');
  if (!sessionId || !fs.existsSync(f)) return null;
  return (Date.now() - fs.statSync(f).mtimeMs) / 60000;
}

const db = new DatabaseSync(DB, { readOnly: !REPAIR });
const nameById = new Map(
  db.prepare('select id, name from workflows').all().map(w => [w.id, w.name])
);

const running = db.prepare(
  "select * from workflow_runs where status = 'running' order by started_at asc"
).all();

const now = Date.now();
const findings = [];
const healthy = [];

for (const r of running) {
  const ageMin = (now - new Date(r.started_at).getTime()) / 60000;
  const name = nameById.get(r.task_id) ?? r.task_id;
  const live = sessionLiveness(r.session_id);
  const outcome = await readOutcome(r.session_id);
  const idle = idleMinutes(r.session_id);
  const idleTxt = idle == null ? 'no log' : `log idle ${idle.toFixed(1)}m`;

  // Race guard first: a session that is still starting up is never a candidate,
  // whichever arm might otherwise match it.
  if (ageMin < GRACE_MIN) {
    healthy.push({ name, ageMin, why: `under ${GRACE_MIN}m grace - not touched` });
    continue;
  }

  // Arm 1 - the process that owned this run is gone.
  if (live.dead) {
    findings.push({ row: r, name, ageMin, outcome, idle, arm: 'process-dead', why: live.why });
    continue;
  }

  // Arm 2 - process alive but the session has finished and gone silent.
  if (outcome.completed && idle != null && idle >= IDLE_MIN) {
    findings.push({
      row: r, name, ageMin, outcome, idle, arm: 'hung-alive',
      why: `${live.why}, but task_complete already fired and ${idleTxt}`,
    });
    continue;
  }

  // Arm 3 - the RUN-LEVEL TIMEOUT (GH #261). Alive, never finished, and silent for so long
  // that it is not working. This is the only arm that acts WITHOUT proof of the outcome, so
  // it is the most conservative: both an age gate and a stall gate must be past, and it
  // resolves to `failed`, never `completed`. Claiming a run finished when nothing says so
  // would be inventing an outcome; recording that it stopped is what actually happened.
  //
  // Deliberately last, so a run that CAN be classified by evidence always is - arm 3 never
  // pre-empts a verdict arms 1 or 2 could have reached honestly.
  if (idle != null && ageMin >= MAX_RUNTIME_MIN && idle >= STALL_MIN) {
    findings.push({
      row: r, name, ageMin, outcome, idle, arm: 'timed-out',
      why: `${live.why}, no task_complete, running ${(ageMin / 60).toFixed(1)}h and ${idleTxt}`,
    });
    continue;
  }

  healthy.push({ name, ageMin, why: `${live.why}, ${idleTxt}` });
}

console.log(`workflow runs at status='running': ${running.length}`);
console.log(`grace: ${GRACE_MIN} min   idle threshold: ${IDLE_MIN} min   timeout: ${MAX_RUNTIME_MIN} min age + ${STALL_MIN} min stall   mode: ${REPAIR ? 'REPAIR' : 'detect-only'}`);
console.log('');

for (const h of healthy) {
  console.log(`  ok      ${h.name}  age=${h.ageMin.toFixed(1)}m  (${h.why})`);
}
if (healthy.length) console.log('');

if (findings.length === 0) {
  console.log('FLAGGED - orphaned runs blocking their workflow: 0');
  process.exit(0);
}

console.log(`FLAGGED - orphaned runs blocking their workflow: ${findings.length}`);
console.log('  (each of these silently disables its workflow for BOTH the scheduler');
console.log('   and manual runs until the row reaches a terminal status)');
console.log('');

let repaired = 0;
for (const f of findings) {
  const outcome = f.outcome;
  const verdict = outcome.completed ? 'completed' : 'failed';
  console.log(`  #${f.name}`);
  console.log(`     run=${f.row.id}`);
  console.log(`     age=${(f.ageMin / 60).toFixed(1)}h  started=${f.row.started_at}`);
  console.log(`     session=${f.row.session_id}`);
  console.log(`     arm       : ${f.arm} (${f.why})`);
  console.log(`     last event: ${outcome.lastType ?? 'none'} @ ${outcome.lastAt ?? '-'}`);
  console.log(`     evidence  : session.task_complete ${outcome.completed ? 'FOUND @ ' + outcome.at : 'absent'}`);
  console.log(`     verdict   : ${verdict}`);
  if (f.arm === 'hung-alive') {
    const locks = fs.existsSync(path.join(SESSION_ROOT, f.row.session_id))
      ? fs.readdirSync(path.join(SESSION_ROOT, f.row.session_id)).filter(x => /^inuse\.\d+\.lock$/.test(x))
      : [];
    console.log(`     LEAK      : ${locks.join(',') || 'unknown'} still holds this session and is idle;`);
    console.log('                 not killed here (that is a separate, less reversible call)');
  }
  if (f.arm === 'timed-out') {
    console.log(`     TIMEOUT   : alive but silent for ${f.idle.toFixed(0)}m after ${(f.ageMin / 60).toFixed(1)}h;`);
    console.log('                 the process is NOT killed - this releases the schedule only, and');
    console.log('                 the run is recorded as failed because nothing says it finished');
  }

  if (!REPAIR) {
    console.log('     action    : none (detect-only; pass --repair to fix)');
    console.log('');
    continue;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = path.join(BACKUP_DIR, `${f.row.id}.before.json`);
  fs.writeFileSync(backup, JSON.stringify(f.row, null, 2), 'utf8');

  // The message records WHICH arm fired and what it saw. It previously hard-coded
  // "owning process dead", which is arm 1's evidence and was already untrue of an arm-2
  // repair - so the one durable record of why a row was touched described a different
  // fault than the one observed. On arm 3 that would matter more, because arm 3 is the
  // arm that acts without proof of the outcome.
  const info = db.prepare(
    `update workflow_runs
        set status = ?, completed_at = ?, error_message = ?
      where id = ? and status = 'running'`
  ).run(
    verdict,
    outcome.completed ? outcome.at : new Date().toISOString(),
    `Recovered by stuck-run-sweep (arm: ${f.arm}): ${f.why}; ` +
      `last event ${outcome.lastType ?? 'none'}. Row was orphaned at status=running, ` +
      `which blocks all further runs of this workflow.`,
    f.row.id
  );
  repaired += info.changes;
  console.log(`     action    : REPAIRED -> ${verdict} (backup: ${backup})`);
  console.log('');
}

if (REPAIR) {
  console.log(`repaired ${repaired} orphaned run(s); their workflows can schedule again.`);
}
process.exit(1);
