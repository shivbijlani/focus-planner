/**
 * mutcheck-session-prune.mjs
 *
 * Mutation check for session-state-prune-sweep.mjs (GH #481).
 *
 * WHY THE BAR IS HIGHER HERE THAN FOR A REPORTING SWEEP
 * -----------------------------------------------------
 * Every other detector in this suite is wrong in the direction of noise. This one names a
 * set of directories for DELETION, so a broken veto is wrong in the direction of destroying
 * a running session or a task's continuity. The vetoes are therefore the subject of this
 * file, not the counting.
 *
 * The three vetoes and what each one is protecting:
 *
 *   LIVE    a directory held by a live PID. Removing it kills a running session. Probed with
 *           `process.kill(pid, 0)`, never "a lock file exists" -- 477 of 500 locks on this
 *           machine name a dead PID, so the cheap check would protect essentially nothing
 *           while looking like it protects everything.
 *   BOUND   a directory whose session id is still bound to a task in the overnight-agent
 *           state store, or is the `prior_session_id` of one. THIS IS THE ONE AGE CANNOT
 *           SEE. A bound session that is merely idle looks identical to an abandoned one by
 *           mtime, so a purely-by-age pruner silently breaks the cross-night continuity #404
 *           exists to provide -- and does it invisibly, until the next wake cold-starts.
 *   RECENT  inside the retention window. Cheap insurance for a session between processes.
 *
 * Plus the property that matters most and is not a veto at all: DRY RUN IS THE DEFAULT, and
 * `--apply` still refuses. Deleting session history sits on the agent gate's floor
 * ("Outcome can result in permanent data loss"), which outranks this repo's YOLO mode and
 * outranks a human `approve`. A mutation that makes deletion reachable must be caught.
 *
 * LINUX-SAFE BY CONSTRUCTION: OA_SESSION_ROOT and OA_STATE_DIR are passed explicitly into
 * every child, liveness is probed against this harness's own PID, and nothing reads the real
 * store or depends on USERPROFILE/LOCALAPPDATA/TEMP existing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SWEEP =
  process.env.OA_SWEEP ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'session-state-prune-sweep.mjs')
    : '');
if (!SWEEP || !fs.existsSync(SWEEP)) {
  console.error(`Cannot locate session-state-prune-sweep.mjs (set OA_SWEEP). Tried: ${SWEEP || '(nothing)'}`);
  process.exit(2);
}
const src = fs.readFileSync(SWEEP, 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-prune-'));
const sessionRoot = path.join(root, 'session-state');
const stateDir = path.join(root, 'state');
fs.mkdirSync(sessionRoot, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const DAY = 86400000;
const now = Date.now();

// A PID that is provably not running, found rather than guessed. process.pid is its live
// counterpart and is guaranteed alive for as long as this harness runs.
const deadPid = (() => {
  for (let p = 999990; p > 990000; p--) {
    try { process.kill(p, 0); } catch (e) { if (e.code === 'ESRCH') return p; }
  }
  return 999999;
})();

/** Build a session dir aged `ageDays`, optionally holding a lock. */
const session = (id, ageDays, holder) => {
  const dir = path.join(sessionRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'events.jsonl');
  fs.writeFileSync(f, '{}\n', 'utf8');
  if (holder === 'dead') fs.writeFileSync(path.join(dir, `inuse.${deadPid}.lock`), 'x', 'utf8');
  if (holder === 'live') fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), 'x', 'utf8');
  const when = new Date(now - ageDays * DAY);
  for (const p of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, p), when, when);
  fs.utimesSync(dir, when, when);
  return id;
};

// A — OLD, unheld, unbound. The whole point: 100 days stale, must be reclaimable.
const A = session('AAAA', 100, 'dead');
// B — veto LIVE. Same age as A; the only difference is that a live process holds it.
const B = session('BBBB', 100, 'live');
// C — veto BOUND. Same age as A, no live holder, but a task is still bound to it. Age cannot
//     see this, which is exactly why the veto exists.
const C = session('CCCC', 100, 'dead');
// D — veto RECENT. Untouched 2 days: inside the retention window.
const D = session('DDDD', 2, 'dead');
// E — veto BOUND via prior_session_id. The replaced session, still named by a continuation.
const E = session('EEEE', 100, 'dead');

fs.writeFileSync(
  path.join(stateDir, 'task-901.json'),
  JSON.stringify({ id: '901', status: 'in-progress', session: { session_id: C, prior_session_id: E, state: 'live' } }, null, 2),
  'utf8',
);

const run = (sweepPath, extraArgs = []) => {
  const r = spawnSync(process.execPath, [sweepPath, ...extraArgs], {
    env: { ...process.env, OA_SESSION_ROOT: sessionRoot, OA_STATE_DIR: stateDir, OA_SESSION_RETAIN_DAYS: '14' },
    encoding: 'utf8',
  });
  const out = r.stdout || '';
  const m = /reclaimable\s*:\s*(\d+) dirs/.exec(out);
  return { count: m ? Number(m[1]) : -1, out, err: r.stderr || '', code: r.status };
};

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('== baseline (real sweep, unmutated) ==');
const base = run(SWEEP);
check('no stderr (the sweep ran, it did not crash)', base.err.trim() === '', base.err.trim().slice(0, 200));
check('exactly 1 reclaimable: only A', base.count === 1, `got ${base.count}\n${base.out}`);
check('B is protected as LIVE', /LIVE 1/.test(base.out), base.out);
check('C and E are protected as BOUND (bound + prior_session_id)', /BOUND 2/.test(base.out), base.out);
check('D is protected as RECENT', /RECENT 1/.test(base.out), base.out);
check('exit 1 with findings, so run-sweeps reads FINDINGS not CRASH', base.code === 1, `got ${base.code}`);

console.log('');
console.log('== the floor: deletion is not reachable ==');
check('dry run is the DEFAULT and says so', /DRY RUN - nothing was deleted/.test(base.out), base.out.slice(0, 200));
const applied = run(SWEEP, ['--apply']);
check('--apply still refuses and deletes nothing', /Nothing was deleted/.test(applied.out), applied.out.slice(-300));
check('all five fixture dirs survive --apply', fs.readdirSync(sessionRoot).length === 5, `${fs.readdirSync(sessionRoot).length} left`);

console.log('');
console.log('== cannot-measure is not clean ==');
const blind = spawnSync(process.execPath, [SWEEP], {
  env: { ...process.env, OA_SESSION_ROOT: path.join(root, 'nope'), OA_STATE_DIR: stateDir },
  encoding: 'utf8',
});
check('missing session root exits 2, not 0', blind.status === 2, `got ${blind.status}`);

const MUTATIONS = [
  {
    // Neutralised rather than deleted: removing the line leaves a dangling `else if` and the
    // mutant dies of a SyntaxError, which proves the line is present, not that it is
    // load-bearing. A mutant must run to be evidence.
    name: 'veto LIVE removed (a running session becomes deletable)',
    guards: 'LIVE',
    find: "  if (livePids.length) veto = 'LIVE';                       // veto LIVE",
    repl: "  if (false) veto = 'LIVE';",
  },
  {
    name: 'liveness probed by lock EXISTENCE instead of PID (477 dead locks would protect nothing)',
    guards: 'LIVE',
    find: '  const livePids = pids.filter(pidAlive);',
    repl: '  const livePids = pids.filter(() => false);',
  },
  {
    name: 'veto BOUND removed (task continuity becomes deletable, invisibly)',
    guards: 'BOUND',
    find: "  else if (bound.has(name)) veto = 'BOUND';                 // veto BOUND",
    repl: '  else if (false) {}',
  },
  {
    name: 'prior_session_id no longer protected (the replaced session is forgotten)',
    guards: 'PRIOR',
    find: '      if (prior) ids.add(String(prior));',
    repl: '',
  },
  {
    name: 'veto RECENT removed (a session between processes becomes deletable)',
    guards: 'RECENT',
    find: "  else if (now - touched < RETAIN_MS) veto = 'RECENT';      // veto RECENT",
    repl: '  else if (false) {}',
  },
  {
    // The window is load-bearing, not decoration: at 0 every session that has merely gone
    // quiet is instantly prunable. Forced to 0 directly rather than by unsetting the
    // env var, because the harness SETS that var -- a mutation the fixture neutralises
    // proves nothing, which is how this arm first passed while testing nothing.
    name: 'retention window forced to 0 (everything quiet is instantly prunable)',
    guards: 'RECENT',
    find: 'const RETAIN_DAYS = Number(process.env.OA_SESSION_RETAIN_DAYS) || 14;',
    repl: 'const RETAIN_DAYS = 0;',
  },
];

// How many dirs each mutation should unleash. BOUND is 3 because BOTH C and E are protected
// by that one veto -- C directly and E through prior_session_id -- so breaking it releases
// two fixtures at once. Named exactly rather than loosened to "more than baseline", which
// would have hidden that.
const EXPECT = { LIVE: 2, BOUND: 3, PRIOR: 2, RECENT: 2 };

console.log('');
console.log('== mutations (each veto is load-bearing) ==');
for (const m of MUTATIONS) {
  if (!src.includes(m.find)) {
    check(`${m.name}: anchor present in source`, false, `not found: ${m.find}`);
    continue;
  }
  const mutPath = path.join(root, `mutant-${MUTATIONS.indexOf(m)}.mjs`);
  fs.writeFileSync(mutPath, src.replace(m.find, m.repl), 'utf8');
  const r = run(mutPath);
  check(`${m.name}: mutant still runs`, r.err.trim() === '', r.err.trim().slice(0, 200));
  check(`${m.name} -> more becomes reclaimable (veto is load-bearing)`, r.count > base.count, `base ${base.count}, mutant ${r.count}`);
  check(`${m.name}: unleashes exactly its own fixture`, r.count === EXPECT[m.guards], `expected ${EXPECT[m.guards]}, got ${r.count}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
