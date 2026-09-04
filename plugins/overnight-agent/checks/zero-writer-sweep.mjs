// zero-writer-sweep.mjs — a wake was dispatched. Did anything ever come back?
//
// WHY THIS FILE EXISTS (GH #476)
// ------------------------------
// #473 named exactly one author for a wake — the bound task sub-session — and #474/#475
// enforced it with `write-turn.ps1` G12. That closed the "at most one turn per wake" half.
// It left the other half open, and made it worse: the sole author is now a single point of
// failure with no detector. If it merges its work and then writes nothing, the wake is
// silently unreported and every surface agrees that nothing happened.
//
// MEASURED LIVE, 2026-09-04 (the reproduction this sweep is built from)
// ---------------------------------------------------------------------
//   05:36:53 PT  the run woke the sub-session bound to task #466 (`session -SessionWoken`
//                recorded it, so `last_woken_at` is a real, durable wake boundary)
//   05:44:44 PT  a `copilot.exe` session host spawned to service that wake
//   ~06:07 PT    that host (PID 5892) was GONE. Elapsed ~22 minutes.
//   output       NOTHING, anywhere. No branch, no PR, worktree clean, `task-466.md` mtime
//                still 05:18:46 — the PREVIOUS wake's turn — and no doc amendment.
//
// And nothing detected it. `oa-state.ps1 scan` still reported #466 as an ordinary
// `in-progress` row. The only reason it is known at all is that the run session happened to
// poll process CPU by hand.
//
// THIS IS THE #346 / `doc_new_comments: 0` SHAPE
// ----------------------------------------------
// "The sub-session had nothing to report" and "the sub-session never reported" are
// BYTE-IDENTICAL from the outside. Silence is success-shaped. Every guard in
// `write-turn.ps1` — G1..G12 — is a property of a turn that IS BEING WRITTEN, reachable
// only from the write path, so not one of them can fire when nothing is written at all.
//
// WHAT CLOSES THE LOOP
// --------------------
// A wake must leave a POSITIVE record that it is over. It already leaves a positive record
// that it STARTED (`session.last_woken_at`, or `session.created_at` for the wake that a
// fresh binding is briefed with), and since #477 a turn records WHO wrote it
// (`last_turn_by`, compared against `session.session_id`). The missing third fact is "the
// wake is over", and it does not need the dying session's cooperation — a session that
// crashes cannot be trusted to report its own death:
//
//   `~/.copilot/session-state/<session-id>/inuse.<pid>.lock`
//
// stuck-run-sweep.mjs established and verified that signal live on 2026-08-27 (dead orphan
// -> lock PID gone; live run -> lock PID alive), and it has the property that matters here:
// A LIVE SESSION — INCLUDING THE ONE RUNNING THIS SWEEP — CAN NEVER BE MISTAKEN FOR A
// CLOSED ONE. That is what lets this sweep stay quiet on the healthy in-flight path instead
// of flagging every task the run is currently working, which is the always-firing advisory
// #433 warns about and the trap catchup-doc-sweep's own header argues against.
//
// WHAT IT REPORTS
// ---------------
//   ZERO_WRITER      the wake is provably OVER (no live host holds the session, or the run
//                    recorded it `dead`) and the owner wrote no turn at or after the wake
//                    boundary. This is #476 exactly: dispatched, closed, produced nothing.
//   MASKED_WRITER    same, except a turn from a DIFFERENT author covers the wake. The owner
//                    still wrote nothing; the silence is merely hidden behind someone else's
//                    turn. This is the 03:25 shape from #476/#477 — the run session's turn
//                    landed in the gap and G12 then refused the owner's. Without this arm a
//                    foreign turn would SATISFY the at-least-one test and re-open the hole.
//   WAKE_UNSERVICED  a live host still holds the session, but it has recorded no event since
//                    the wake boundary and the wake is older than the grace. The wake was
//                    dispatched to a host that never picked it up (wedged, or the message was
//                    never delivered) — distinct from ZERO_WRITER, where work may have
//                    happened and only the report was lost.
//
// WHAT IT DELIBERATELY DOES NOT REPORT (each gate is mutation-proven load-bearing)
// -------------------------------------------------------------------------------
//   TERMINAL      a done/skip task. Closed work has no live wake, and flagging it rebuilds
//                 #170 (writing at tasks Shiv has finished) as a metric.
//   UNBOUND       no bound session. The run session legitimately writes those turns itself;
//                 there is no sub-session whose silence could be the defect.
//   UNWOKEN       bound but with no wake boundary at all. Nothing was dispatched, so there is
//                 no wake to hold to account.
//   WROTE         the OWNER wrote at or after the boundary. The healthy path must go quiet or
//                 the sweep can never reach zero and gets switched off.
//   UNATTRIBUTED  a turn covers the wake but the state predates #477, so it carries no
//                 `last_turn_by` and authorship is unknowable. Accusing on absent evidence
//                 would flag every historical state at once. Note the distinction that makes
//                 this safe: the field being ABSENT means the recorder did not exist yet;
//                 the field being present and reading `unknown` is a real measurement of a
//                 non-owner and is reported as MASKED_WRITER.
//   IN_FLIGHT     a live host holds the session and has recorded events since the wake, or
//                 the wake is still inside the grace. THE MOST LOAD-BEARING GATE IN THE FILE:
//                 without it this sweep flags every task the current run is working —
//                 including, at the moment it runs, itself.
//
// Exit 1 when there are findings (stdout, no stderr) so run-sweeps.ps1 classifies it
// FINDINGS rather than CRASH.
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) {
  console.error('PLANNER_PATH is not set. Run via run-sweeps.ps1, which exports it.');
  process.exit(2);
}

// LOCALAPPDATA does not exist off Windows and `path.join(undefined, …)` throws, so the state
// dir is an explicit parameter first and the Windows default only a fallback. (#425's CI went
// red on exactly this class of Linux-only path bug.)
const STATE_DIR =
  process.env.OA_STATE_DIR ||
  (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state') : '');
if (!STATE_DIR) {
  console.error('No state dir: set OA_STATE_DIR (or run on Windows, where LOCALAPPDATA is set).');
  process.exit(2);
}

// Where the CLI keeps one directory per session. This sweep's entire closure test lives here,
// so a missing root is NOT "nothing to report" — it is "cannot measure", and those two must
// never produce the same bytes. That is #346's defect, and building its detector with that
// same hole in it would be the joke telling itself.
const SESSION_ROOT =
  process.env.OA_SESSION_ROOT ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.copilot', 'session-state') : '');
if (!SESSION_ROOT || !fs.existsSync(SESSION_ROOT)) {
  console.error(
    `Cannot measure wake closure: session-state root missing (${SESSION_ROOT || '(unset)'}). ` +
      'Set OA_SESSION_ROOT. Refusing to report 0 findings from a probe that could not look.',
  );
  process.exit(2);
}

// How long a dispatched wake may go unserviced before that is a defect rather than latency.
// A NUMBER, not a toggle, and measured rather than guessed: on 2026-09-04 the host took 7m51s
// to spawn after the wake was sent (05:36:53 -> 05:44:44), so anything under ~10 minutes would
// flag a healthy dispatch. Setting it to 0 restores that false positive, so 0 is treated as
// "unset" and falls back to the default rather than silently arming it.
const GRACE_MINUTES = Number(process.env.OA_WAKE_GRACE_MINUTES) || 20;
const GRACE_MS = GRACE_MINUTES * 60 * 1000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

const ts = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? null : t;
};

/** Is this PID alive? Signal 0 probes without touching the process. */
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is not ours - still alive.
    return e.code === 'EPERM';
  }
};

/**
 * Is the wake over? Derived from the session host, never from the session's own cooperation —
 * a process that dies mid-turn cannot file a report about having died.
 *
 * ⛔ THE PID IS PROBED, NOT ASSUMED. A lock FILE proves a host once claimed this session; only
 * a live PID proves one still holds it, and nothing removes the file when a host dies. Measured
 * on this machine 2026-09-04 (GH #481): `session-state` has never been pruned — 4,109 dirs,
 * 2.6 GB — and of 493 `inuse.*.lock` files, 488 name a PID THAT NO LONGER EXISTS while only 5
 * dirs are held by a live `copilot.exe`. Simplifying this to `locks.length > 0` therefore reads
 * ~99% of the store as permanently working and silently disables this sweep for the exact
 * population it exists for. It looks like a harmless cleanup and it is the defect this file was
 * built to detect, so mutcheck pins it with its own arm rather than trusting this comment.
 *
 * Residual, bounded on purpose: Windows recycles PIDs, so a recycled PID can make a long-dead
 * session read alive (#481). That degrades a ZERO_WRITER into a WAKE_UNSERVICED — the task is
 * still named and still reported, because a host that never serviced this wake has no event
 * after it — it does not go silent. Under-reporting the REASON is acceptable; under-reporting
 * the TASK would not be.
 */
const closure = (sessionId) => {
  const dir = path.join(SESSION_ROOT, sessionId);
  if (!fs.existsSync(dir)) return { closed: true, why: 'no session-state dir', dir };

  const locks = fs.readdirSync(dir).filter((f) => /^inuse\.\d+\.lock$/.test(f));
  if (locks.length === 0) return { closed: true, why: 'no inuse lock holds the session', dir };

  const live = [];
  const gone = [];
  for (const l of locks) {
    const pid = Number(/^inuse\.(\d+)\.lock$/.exec(l)[1]);
    (pidAlive(pid) ? live : gone).push(pid);
  }
  if (live.length) return { closed: false, why: `held by live pid ${live.join(',')}`, dir };
  return { closed: true, why: `lock pid ${gone.join(',')} is gone`, dir };
};

/** Newest event the host recorded for this session, or null if it has recorded none. */
const lastEventAt = (dir) => {
  try {
    return fs.statSync(path.join(dir, 'events.jsonl')).mtimeMs;
  } catch {
    return null;
  }
};

// The board is the universe of live tasks, same as every other sweep.
const boardFile = path.join(PLANNER, 'planner.md');
const board = fs.existsSync(boardFile) ? fs.readFileSync(boardFile, 'utf8') : '';
const activeIds = [...board.matchAll(/^\|\s*(\d+)[,\s|]/gm)].map((m) => m[1]);

const TERMINAL = new Set(['done', 'skip', 'skipped', 'complete', 'completed']);

const findings = [];
let woken = 0;
let considered = 0;
const now = Date.now();

for (const id of activeIds) {
  const st = readJson(path.join(STATE_DIR, `task-${id}.json`));
  if (!st) continue;

  if (TERMINAL.has(String(st.status))) continue; // gate TERMINAL

  considered++;

  // `?? {}` rather than `null` so DELETING the gate below yields a finding instead of a
  // TypeError. A mutant that crashes proves the line is reachable, not that it is load-bearing.
  const sess = st.session ?? {};
  const sessionId = String(sess.session_id ?? '');
  if (!sessionId) continue; // gate UNBOUND

  // The wake boundary. `last_woken_at` is stamped by `session -SessionWoken`; `created_at` is
  // the boundary of the wake a freshly bound session is briefed with (PHASE 1 steps 4-5 bind
  // then brief, so a binding IS a dispatch). The later of the two is the newest wake, which is
  // the only one still answerable.
  const wokenAt = Math.max(ts(sess.last_woken_at) ?? 0, ts(sess.created_at) ?? 0);
  if (!wokenAt) continue; // gate UNWOKEN

  woken++;

  const turnAt = ts(st.last_turn_at);
  const covers = turnAt !== null && turnAt >= wokenAt;
  // Absent means the recorder predates #477 and authorship is unknowable; present-and-wrong
  // (including the literal 'unknown' oa-state.ps1 writes for an unset session id) is a real
  // measurement of a non-owner.
  const attributed = Object.prototype.hasOwnProperty.call(st, 'last_turn_by');
  const turnBy = String(st.last_turn_by ?? '');

  if (covers && (!attributed || turnBy === sessionId)) continue; // gates WROTE / UNATTRIBUTED

  const c = closure(sessionId);
  const ageMin = (now - wokenAt) / 60000;
  const row = {
    id,
    status: String(st.status ?? ''),
    sessionId,
    woken_at: new Date(wokenAt).toISOString(),
    last_turn_at: st.last_turn_at || '(none)',
    last_turn_by: attributed ? turnBy || '(empty)' : '(not recorded)',
    ageMin,
    why: c.why,
  };

  if (c.closed || String(sess.state) === 'dead') {
    findings.push({ ...row, kind: covers ? 'MASKED_WRITER' : 'ZERO_WRITER' });
    continue;
  }

  // Still held by a live host. Only a wake that is BOTH past the grace AND has produced no
  // event at all is a finding; anything else is ordinary in-flight work.
  const ev = lastEventAt(c.dir);
  if (now - wokenAt > GRACE_MS && (ev === null || ev < wokenAt)) {
    findings.push({ ...row, kind: 'WAKE_UNSERVICED', lastEvent: ev ? new Date(ev).toISOString() : '(none)' });
    continue;
  }

  // gate IN_FLIGHT — the wake is open and being serviced. Quiet on purpose.
}

const byKind = (k) => findings.filter((f) => f.kind === k).length;

console.log(`Wakes that closed without their owner writing: ${findings.length}`);
console.log(
  `  (${woken} of ${considered} live non-terminal tasks have a woken session; ` +
    `zero-writer ${byKind('ZERO_WRITER')}, masked ${byKind('MASKED_WRITER')}, ` +
    `unserviced ${byKind('WAKE_UNSERVICED')}; grace ${GRACE_MINUTES}m)\n`,
);

for (const f of findings) {
  console.log(`#${f.id} [${f.status}]  ${f.kind}`);
  console.log(`     session:   ${f.sessionId}  (${f.why})`);
  console.log(`     woken:     ${f.woken_at}   ${f.ageMin.toFixed(0)}m ago`);
  console.log(`     last turn: ${f.last_turn_at}   by ${f.last_turn_by}`);
  if (f.kind === 'ZERO_WRITER') {
    console.log('     -> the wake is over and its owner wrote no turn for it. "Nothing to report"');
    console.log('        and "never reported" are the same bytes here; this says which it was.');
  }
  if (f.kind === 'MASKED_WRITER') {
    console.log('     -> a turn covers this wake but a DIFFERENT author wrote it, so the owner');
    console.log('        still reported nothing and its silence is hidden behind that turn.');
  }
  if (f.kind === 'WAKE_UNSERVICED') {
    console.log(`     -> a live host holds the session but recorded no event since the wake`);
    console.log(`        (last event ${f.lastEvent}): the wake was never picked up.`);
  }
  console.log('');
}

process.exit(findings.length ? 1 : 0);
