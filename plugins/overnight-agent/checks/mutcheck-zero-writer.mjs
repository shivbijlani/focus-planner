/**
 * mutcheck-zero-writer.mjs
 *
 * Mutation check for zero-writer-sweep.mjs (GH #476).
 *
 * WHY THIS SHAPE
 * --------------
 * user-settings.md records a sweep that went green by matching a word in its OWN heading, so
 * this harness never inspects the sweep's source for evidence of a fix. It builds a synthetic
 * planner folder, a synthetic state dir AND a synthetic session-state root, runs the REAL
 * sweep as a child process against them, and asserts the verdicts.
 *
 * Then it MUTATES the sweep — one gate or one comparison at a time, in a temp copy of the real
 * source — and asserts each mutation breaks EXACTLY its own case. A gate whose removal changes
 * nothing is dead code pretending to be a safeguard; a gate whose removal breaks several cases
 * is not the gate its comment claims it is.
 *
 * A GUARD FOR SILENT FAILURE THAT ITSELF FAILS SILENTLY IS WORSE THAN NOTHING, because it will
 * be believed. So the assertions compare an id -> KIND map, not just "did it fire": a mutation
 * that keeps a finding but relabels it (ZERO_WRITER where MASKED_WRITER was correct) is a
 * regression in exactly the property #476 is about — telling apart the ways a wake can be
 * silent — and a fired/not-fired harness would score it green.
 *
 * THREE DIRECTIONS OF MUTATION, ON PURPOSE
 * ----------------------------------------
 *   unleashes  removing a GATE makes its negative fixture start firing
 *              (TERMINAL, UNBOUND, UNWOKEN, WROTE, UNATTRIBUTED, IN_FLIGHT, grace, boundary)
 *   silences   disabling a DETECTOR makes its positive fixture stop firing
 *              (MASKED_WRITER, WAKE_UNSERVICED)
 *   relabels   breaking the liveness signal turns a serviced wake into a closed one
 *
 * LINUX-SAFE BY CONSTRUCTION
 * --------------------------
 * The sweep is located via OA_SWEEP (CI points it at the repo copy) and falls back to the
 * deployed OA home only when that is unset. PLANNER_PATH, OA_STATE_DIR and OA_SESSION_ROOT are
 * all passed explicitly into every child, so nothing here depends on LOCALAPPDATA or
 * USERPROFILE existing and nothing reads the real planner folder or the real session store.
 * #425's CI job went red on precisely a Linux-only path assumption, so this is spelled out
 * rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SWEEP =
  process.env.OA_SWEEP ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'zero-writer-sweep.mjs')
    : '');

if (!SWEEP || !fs.existsSync(SWEEP)) {
  console.error(`Cannot locate zero-writer-sweep.mjs (set OA_SWEEP). Tried: ${SWEEP || '(nothing)'}`);
  process.exit(2);
}
const src = fs.readFileSync(SWEEP, 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-zw-'));
const stateDir = path.join(root, 'state');
const sessionRoot = path.join(root, 'session-state');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(sessionRoot, { recursive: true });

const MIN = 60 * 1000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const T_WAKE = iso(60 * MIN); // the wake under test, well past the 20m grace
const T_BEFORE = iso(90 * MIN); // a turn that PREDATES the wake — the #476 shape
const T_AFTER = iso(30 * MIN); // a turn that covers the wake
const T_RECENT = iso(5 * MIN); // a wake still inside the grace

// A PID that is provably not running, found rather than guessed. `process.pid` is the live
// counterpart and is guaranteed alive for as long as this harness runs — the same property
// stuck-run-sweep relies on so that a live run can never be mistaken for an orphan.
const deadPid = (() => {
  for (let p = 999990; p > 990000; p--) {
    try {
      process.kill(p, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return p;
    }
  }
  return 999999;
})();

/** Build a session dir. `holder`: 'dead-pid' | 'live-pid' | 'no-lock' | 'no-dir'. */
const session = (sid, holder, eventsMsAgo) => {
  if (holder === 'no-dir') return sid;
  const dir = path.join(sessionRoot, sid);
  fs.mkdirSync(dir, { recursive: true });
  if (holder === 'dead-pid') fs.writeFileSync(path.join(dir, `inuse.${deadPid}.lock`), 'x', 'utf8');
  if (holder === 'live-pid') fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), 'x', 'utf8');
  if (eventsMsAgo !== undefined) {
    const f = path.join(dir, 'events.jsonl');
    fs.writeFileSync(f, '{}\n', 'utf8');
    const when = new Date(now - eventsMsAgo);
    fs.utimesSync(f, when, when);
  }
  return sid;
};

const rows = [];
const task = (id, state) => {
  rows.push(id);
  fs.writeFileSync(path.join(stateDir, `task-${id}.json`), JSON.stringify(state, null, 2), 'utf8');
};

const bind = (sid, over = {}) => ({
  session_id: sid,
  kind: 'code',
  workspace: 'V:\\wt\\fixture',
  workspace_type: 'worktree',
  created_at: iso(240 * MIN),
  last_woken_at: T_WAKE,
  state: 'live',
  ...over,
});

// A — THE LIVE INCIDENT, RECONSTRUCTED. Task #466, 2026-09-04: woken 05:36:53, host spawned
// 05:44:44, host gone by ~06:07, and the newest journal turn was 05:18:46 — the PREVIOUS
// wake's. Owner is the correct author, the turn is simply older than the wake it was supposed
// to answer. Nothing in the repo could see this; it is the whole reason the sweep exists.
task('901', {
  id: '901',
  status: 'in-progress',
  last_turn_at: T_BEFORE,
  last_turn_by: session('S-901', 'dead-pid', 80 * MIN),
  session: bind('S-901'),
});

// B — MASKED_WRITER. A turn DOES cover the wake, written by somebody else (the 03:25 shape in
// #476/#477: the run session's turn landed in the gap and G12 then refused the owner's). The
// owner still reported nothing; without this arm that foreign turn satisfies "at least one".
task('902', {
  id: '902',
  status: 'in-progress',
  last_turn_at: T_AFTER,
  last_turn_by: 'S-SOMEONE-ELSE',
  session: bind(session('S-902', 'dead-pid', 80 * MIN)),
});

// C — WAKE_UNSERVICED. A live host still holds the session, past the grace, and has recorded
// no event since the wake: dispatched to a host that never picked it up.
task('903', {
  id: '903',
  status: 'in-progress',
  last_turn_at: T_BEFORE,
  last_turn_by: 'S-903',
  session: bind(session('S-903', 'live-pid', 80 * MIN)),
});

// D — gate TERMINAL. Byte-identical to A except the status. Must NOT fire: closed work has no
// live wake, and flagging it rebuilds #170 (writing at tasks Shiv has finished) as a metric.
task('904', {
  id: '904',
  status: 'done',
  last_turn_at: T_BEFORE,
  last_turn_by: 'S-904',
  session: bind(session('S-904', 'dead-pid', 80 * MIN)),
});

// E — gate UNBOUND, isolated from UNWOKEN on purpose. A state whose `session` object carries
// timestamps but NO `session_id` — the shape a crash mid-write leaves behind, which is squarely
// this task's subject. It has to be this shape rather than "no session at all": with no session
// there is also no wake, so UNWOKEN would catch it first and UNBOUND could be deleted with no
// fixture noticing. What UNBOUND actually prevents is `closure('')` resolving to the
// session-state ROOT, which exists and holds no `inuse` lock, and therefore reads CLOSED —
// accusing a task that never had a session, from a directory that is not one.
task('905', {
  id: '905',
  status: 'in-progress',
  last_turn_at: T_BEFORE,
  last_turn_by: 'run',
  session: { kind: 'code', created_at: iso(240 * MIN), last_woken_at: T_WAKE, state: 'live' },
});

// F — gate UNWOKEN. Bound, but nothing was ever dispatched to it, so there is no wake to hold
// to account. No turn either, so removing the gate leaves a bare zero-writer.
task('906', {
  id: '906',
  status: 'in-progress',
  session: bind(session('S-906', 'dead-pid'), { created_at: '', last_woken_at: '' }),
});

// G — gate WROTE. The healthy closed wake: the owner wrote a turn for it and then the session
// ended. This is what a correct night looks like and it MUST be silent, or the sweep can never
// reach zero and gets switched off (#381/#398).
task('907', {
  id: '907',
  status: 'in-progress',
  last_turn_at: T_AFTER,
  last_turn_by: 'S-907',
  session: bind(session('S-907', 'dead-pid', 80 * MIN)),
});

// H — gate UNATTRIBUTED. A turn covers the wake but the state predates #477 and carries no
// `last_turn_by` at all. Authorship is unknowable, so accusing here would flag every historical
// state at once on the day this ships.
task('908', {
  id: '908',
  status: 'in-progress',
  last_turn_at: T_AFTER,
  session: bind(session('S-908', 'dead-pid', 80 * MIN)),
});

// I — gate IN_FLIGHT, THE REGRESSION FIXTURE AND THE ONE THAT MATTERS MOST. A live host holds
// the session and is recording events; no turn yet because the work is still happening. This is
// the exact state of the session running this sweep at the moment it runs. If this fires, the
// sweep flags every task of every healthy run — the always-firing advisory of #433.
task('909', {
  id: '909',
  status: 'in-progress',
  last_turn_at: T_BEFORE,
  last_turn_by: 'S-909',
  session: bind(session('S-909', 'live-pid', 45 * MIN)),
});

// J — the grace is a WINDOW, not "never fires". Live host, wake 5 minutes ago, no event yet.
// Measured live on 2026-09-04: the host took 7m51s to spawn after the wake was sent, so a bare
// "no event since the wake" rule flags a perfectly healthy dispatch.
task('910', {
  id: '910',
  status: 'in-progress',
  last_turn_at: T_BEFORE,
  last_turn_by: 'S-910',
  session: bind(session('S-910', 'live-pid', 80 * MIN), { last_woken_at: T_RECENT }),
});

// K — BOUNDARY. The turn lands at the exact instant of the wake. `>=` keeps it quiet; `>` does
// not, and a wake answered instantly is not a wake that went unanswered.
task('911', {
  id: '911',
  status: 'in-progress',
  last_turn_at: T_WAKE,
  last_turn_by: 'S-911',
  session: bind(session('S-911', 'dead-pid', 80 * MIN)),
});

// L — MASKED via the literal 'unknown'. oa-state.ps1 writes `last_turn_by: 'unknown'` when the
// harness session id is unset, and its own comment says unknown must never inherit the owner's
// authority. Present-and-unknown is therefore a real measurement of a non-owner, unlike H where
// the field is ABSENT. The two must not collapse into one another.
task('912', {
  id: '912',
  status: 'in-progress',
  last_turn_at: T_AFTER,
  last_turn_by: 'unknown',
  session: bind(session('S-912', 'no-lock', 80 * MIN)),
});

// M — closure by a MISSING session dir. Same verdict as a dead lock pid, reached down the other
// branch, so deleting either branch is caught.
task('913', {
  id: '913',
  status: 'in-progress',
  last_turn_at: T_BEFORE,
  last_turn_by: 'S-913',
  session: bind(session('S-913', 'no-dir')),
});

// N — no `session` key at all. Distinct from E: there is nothing to be unbound FROM, so UNWOKEN
// holds it even with UNBOUND deleted. Asserted because a task the agent has never dispatched to
// must be unaccusable down every path, not merely down the first one.
task('914', { id: '914', status: 'in-progress', last_turn_at: T_BEFORE, last_turn_by: 'run' });

// O — THE ONE THAT PINS THE LIVENESS PROBE ITSELF, and the only fixture the sweep goes
// completely SILENT on if that probe is weakened. A dead lock holder, but woken recently
// enough to still be inside the grace. Baseline: the pid is probed, reads gone, the wake is
// closed -> ZERO_WRITER. Replace the probe with "a lock file exists, so it is held" -- the
// obvious, harmless-looking simplification -- and this wake reads as in flight and vanishes.
//
// This is not hypothetical. Measured on this machine 2026-09-04 (GH #481): `session-state`
// holds 4,109 directories that have never been pruned, with 493 `inuse.*.lock` files of which
// 488 name a PID that no longer exists. Under the existence check those 488 sessions would all
// read as permanently working -- the sweep silently disabled for ~99% of the store, while every
// other arm here still passed. A one-line refactor away from the guard carrying the exact
// defect it was built to detect.
task('915', {
  id: '915',
  status: 'in-progress',
  last_turn_at: T_BEFORE,
  last_turn_by: 'S-915',
  session: bind(session('S-915', 'dead-pid', 80 * MIN), { last_woken_at: T_RECENT }),
});

// The board is the universe of live tasks. Header included so the row regex has real shape.
fs.writeFileSync(
  path.join(root, 'planner.md'),
  ['## Today', '', '| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '| --- | --- | --- | --- | --- | --- |']
    .concat(rows.map((id) => `| ${id} | 🟡 | fixture ${id} |  | 2026-09-04 |  |`))
    .join('\n') + '\n',
  'utf8',
);

const run = (sweepPath) => {
  const r = spawnSync(process.execPath, [sweepPath], {
    env: { ...process.env, PLANNER_PATH: root, OA_STATE_DIR: stateDir, OA_SESSION_ROOT: sessionRoot },
    encoding: 'utf8',
  });
  // id -> KIND, not a bare fired-set: a mutation that keeps the finding but relabels it is a
  // regression in the one property this sweep exists for.
  const kinds = new Map();
  for (const m of (r.stdout || '').matchAll(/^#(\d+)\s+\[[^\]]*\]\s+(\S+)/gm)) kinds.set(m[1], m[2]);
  return { kinds, out: r.stdout || '', err: r.stderr || '', code: r.status };
};

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};
const shown = (k) => [...k].map(([id, v]) => `${id}:${v}`).join(',') || '(none)';

console.log('== baseline (real sweep, unmutated) ==');
const base = run(SWEEP);
check('no stderr (the sweep ran, it did not crash)', base.err.trim() === '', base.err.trim().slice(0, 300));
check('A 901 ZERO_WRITER: the live #476 incident', base.kinds.get('901') === 'ZERO_WRITER', shown(base.kinds));
check('B 902 MASKED_WRITER: covered by another author', base.kinds.get('902') === 'MASKED_WRITER', shown(base.kinds));
check('C 903 WAKE_UNSERVICED: live host, no event since the wake', base.kinds.get('903') === 'WAKE_UNSERVICED', shown(base.kinds));
check('D 904 quiet: gate TERMINAL', !base.kinds.has('904'));
check('E 905 quiet: gate UNBOUND (session object with no session_id)', !base.kinds.has('905'));
check('N 914 quiet: no session key at all', !base.kinds.has('914'));
check('F 906 quiet: gate UNWOKEN', !base.kinds.has('906'));
check('G 907 quiet: gate WROTE — the healthy closed wake', !base.kinds.has('907'));
check('H 908 quiet: gate UNATTRIBUTED — pre-#477 state', !base.kinds.has('908'));
check('I 909 quiet: gate IN_FLIGHT — the run that is running this sweep', !base.kinds.has('909'));
check('J 910 quiet: wake still inside the grace (7m51s spawn latency is healthy)', !base.kinds.has('910'));
check('K 911 quiet: turn at the exact wake instant', !base.kinds.has('911'));
check('L 912 MASKED_WRITER: last_turn_by present and "unknown"', base.kinds.get('912') === 'MASKED_WRITER', shown(base.kinds));
check('M 913 ZERO_WRITER: closure via a missing session dir', base.kinds.get('913') === 'ZERO_WRITER', shown(base.kinds));
check('O 915 ZERO_WRITER: dead lock holder, still inside the grace', base.kinds.get('915') === 'ZERO_WRITER', shown(base.kinds));
check('exit 1 with findings, so run-sweeps reads FINDINGS not CRASH', base.code === 1, `got ${base.code}`);

// A probe that cannot look must not report the same bytes as one that looked and found nothing
// (#346). The session-state root is this sweep's entire closure test, so its absence is fatal.
console.log('\n== cannot-measure is not clean ==');
const blind = spawnSync(process.execPath, [SWEEP], {
  env: { ...process.env, PLANNER_PATH: root, OA_STATE_DIR: stateDir, OA_SESSION_ROOT: path.join(root, 'nope') },
  encoding: 'utf8',
});
check('missing session-state root exits 2, not 0', blind.status === 2, `got ${blind.status}`);
check('and says so on stderr', /session-state root missing/.test(blind.stderr || ''), (blind.stderr || '').slice(0, 200));

// A clean corpus must exit 0, or the sweep is permanently red and gets skimmed (#381/#398).
console.log('\n== clean corpus (only the healthy fixtures) ==');
const NOISY = ['901', '902', '903', '912', '913', '915'];
const saved = new Map(NOISY.map((id) => [id, fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8')]));
for (const id of NOISY) fs.rmSync(path.join(stateDir, `task-${id}.json`));
const clean = run(SWEEP);
check('exit 0 when nothing is wrong', clean.code === 0, `got ${clean.code}`);
check('no findings printed', /owner writing: 0/.test(clean.out), clean.out.split('\n')[0]);
for (const [id, body] of saved) fs.writeFileSync(path.join(stateDir, `task-${id}.json`), body, 'utf8');

// Each mutation touches exactly one gate or one comparison.
const MUTATIONS = [
  {
    name: 'gate TERMINAL removed',
    kind: 'unleashes',
    guards: '904',
    find: '  if (TERMINAL.has(String(st.status))) continue; // gate TERMINAL',
    repl: '',
  },
  {
    name: 'gate UNBOUND removed',
    kind: 'unleashes',
    guards: '905',
    find: '  if (!sessionId) continue; // gate UNBOUND',
    repl: '',
  },
  {
    name: 'gate UNWOKEN removed',
    kind: 'unleashes',
    guards: '906',
    find: '  if (!wokenAt) continue; // gate UNWOKEN',
    repl: '',
  },
  {
    name: 'ownership comparison disabled (any author counts as the owner)',
    kind: 'silences',
    guards: '902',
    alsoGuards: ['912'],
    find: '  if (covers && (!attributed || turnBy === sessionId)) continue; // gates WROTE / UNATTRIBUTED',
    repl: '  if (covers) continue; // gates WROTE / UNATTRIBUTED',
  },
  {
    // Unlike the single-gate deletions this removes the whole owner-satisfies path, so it
    // legitimately moves EVERY fixture whose wake was answered by its own owner — 907 and 911.
    // Both are named. Loosening the assertion to "at least 907 fires" would have hidden the fact
    // that this rule guards a class, not one row.
    name: 'gate WROTE removed (owner turn no longer satisfies the wake)',
    kind: 'unleashes',
    guards: '907',
    alsoGuards: ['911'],
    find: '  if (covers && (!attributed || turnBy === sessionId)) continue; // gates WROTE / UNATTRIBUTED',
    repl: '  if (covers && !attributed) continue; // gates WROTE / UNATTRIBUTED',
  },
  {
    name: 'gate UNATTRIBUTED removed (absent author treated as a non-owner)',
    kind: 'unleashes',
    guards: '908',
    find: '  if (covers && (!attributed || turnBy === sessionId)) continue; // gates WROTE / UNATTRIBUTED',
    repl: '  if (covers && turnBy === sessionId) continue; // gates WROTE / UNATTRIBUTED',
  },
  {
    name: 'MASKED_WRITER detector disabled (a foreign turn satisfies at-least-one)',
    kind: 'silences',
    guards: '902',
    alsoGuards: ['912'],
    find: "    findings.push({ ...row, kind: covers ? 'MASKED_WRITER' : 'ZERO_WRITER' });",
    repl: "    if (!covers) findings.push({ ...row, kind: 'ZERO_WRITER' });",
  },
  {
    name: 'WAKE_UNSERVICED detector disabled',
    kind: 'silences',
    guards: '903',
    find: '  if (now - wokenAt > GRACE_MS && (ev === null || ev < wokenAt)) {',
    repl: '  if (false && now - wokenAt > GRACE_MS && (ev === null || ev < wokenAt)) {',
  },
  {
    // The window is load-bearing, not a fudge factor: without it a healthy dispatch that is
    // still waiting for its host to spawn reads as an unserviced wake.
    name: 'grace removed (bare "no event since the wake")',
    kind: 'unleashes',
    guards: '910',
    find: '  if (now - wokenAt > GRACE_MS && (ev === null || ev < wokenAt)) {',
    repl: '  if (ev === null || ev < wokenAt) {',
  },
  {
    name: 'boundary >= loosened to > (a turn at the wake instant no longer counts)',
    kind: 'unleashes',
    guards: '911',
    find: '  const covers = turnAt !== null && turnAt >= wokenAt;',
    repl: '  const covers = turnAt !== null && turnAt > wokenAt;',
  },
  {
    // The single most important gate: without it every task of every healthy run is a finding,
    // starting with the one running this sweep. 903 legitimately RELABELS (it is held by a live
    // pid, so a broken liveness signal makes it read closed rather than unserviced), which a
    // fired/not-fired harness would have scored green.
    name: 'liveness ignored (a live lock holder no longer keeps the wake open)',
    kind: 'unleashes',
    guards: '909',
    alsoGuards: ['910', '903'],
    find: "  if (live.length) return { closed: false, why: `held by live pid ${live.join(',')}`, dir };",
    repl: '  if (false) return { closed: false, why: `held by live pid ${live.join(",")}`, dir };',
  },
  {
    // THE ARM THAT PINS THE PROBE, not the branch. The one above disables the whole
    // live-holder branch; this replaces only the CLASSIFICATION -- "there is a lock file, so
    // it is held" -- which is the refactor that actually gets written, because it reads as a
    // harmless simplification and deletes an unfamiliar `process.kill(pid, 0)` call.
    //
    // Without this arm the guarantee is one line deep and undefended: the simplification
    // passes every other assertion in this file. Measured 2026-09-04 (GH #481), 488 of 493
    // `inuse.*.lock` files on this machine name a PID that no longer exists, so the mutant
    // would read ~99% of the session store as permanently working and the sweep would go
    // quiet on exactly the population it exists for.
    //
    // 915 is SILENCED outright (dead holder, inside the grace -> nothing left to fire).
    // 901 and 902 survive as findings but RELABEL to WAKE_UNSERVICED, because a dead holder
    // misread as live still has no events since its wake. That relabel is also the bound on
    // the PID-reuse hazard #481 raises: a recycled PID degrades ZERO_WRITER to
    // WAKE_UNSERVICED, it does not silence the task -- provided the wake is past the grace.
    // A fired/not-fired harness would have scored both of those green.
    name: 'liveness PROBE replaced by lock existence (locks.length > 0 means held)',
    kind: 'silences',
    guards: '915',
    alsoGuards: ['901', '902'],
    find: '    (pidAlive(pid) ? live : gone).push(pid);',
    repl: '    (true ? live : gone).push(pid);',
  },
  {
    name: 'missing-session-dir closure branch removed',
    kind: 'silences',
    guards: '913',
    find: "  if (!fs.existsSync(dir)) return { closed: true, why: 'no session-state dir', dir };",
    repl: "  if (!fs.existsSync(dir)) return { closed: false, why: 'no session-state dir', dir };",
  },
];

const ALL = rows.slice();

console.log('\n== mutations (each killed by exactly the arms it declares) ==');
for (const m of MUTATIONS) {
  if (!src.includes(m.find)) {
    check(`${m.name}: anchor present in source`, false, `not found: ${m.find}`);
    continue;
  }
  const mutPath = path.join(root, `mutant-${m.guards}-${m.kind}-${MUTATIONS.indexOf(m)}.mjs`);
  fs.writeFileSync(mutPath, src.replace(m.find, m.repl), 'utf8');
  const r = run(mutPath);

  check(`${m.name}: mutant still runs (no crash)`, r.err.trim() === '', r.err.trim().slice(0, 200));

  const moved = (id) => r.kinds.get(id) !== base.kinds.get(id);
  if (m.kind === 'unleashes') {
    check(`${m.name} -> #${m.guards} now fires (gate is load-bearing)`, r.kinds.has(m.guards) && moved(m.guards), shown(r.kinds));
  } else {
    check(`${m.name} -> #${m.guards} changes verdict (detector is load-bearing)`, moved(m.guards), shown(r.kinds));
  }
  for (const extra of m.alsoGuards ?? []) {
    check(`${m.name} -> #${extra} also moves (declared)`, moved(extra), shown(r.kinds));
  }

  // Nothing outside the declared set may move — in EITHER direction, including a relabel.
  const declared = new Set([m.guards, ...(m.alsoGuards ?? [])]);
  const changed = ALL.filter((id) => !declared.has(id)).filter(moved);
  check(`${m.name}: changes nothing else`, changed.length === 0, `also moved: ${changed.join(',')}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
