/**
 * mutcheck-catchup-doc.mjs
 *
 * Mutation check for catchup-doc-sweep.mjs (GH #421).
 *
 * WHY THIS SHAPE
 * --------------
 * user-settings.md records a sweep that went green by matching a word in its OWN heading,
 * so this harness never inspects the sweep's source for evidence of a fix. It builds a
 * synthetic planner folder AND a synthetic state dir, runs the REAL sweep as a child
 * process against them, and asserts the verdicts.
 *
 * Then it MUTATES the sweep — one gate or one comparison at a time, in a temp copy of the
 * real source — and asserts each mutation breaks EXACTLY its own case. A gate whose removal
 * changes nothing is dead code pretending to be a safeguard; a gate whose removal breaks
 * several cases is not the gate its comment claims it is.
 *
 * TWO DIRECTIONS OF MUTATION, ON PURPOSE
 * --------------------------------------
 * This sweep is half detector and half suppressor, so a single "removal makes its negative
 * case fire" template would only exercise half of it and would silently leave the detectors
 * unpinned:
 *
 *   unleashes  removing a GATE makes its negative fixture start firing  (TERMINAL, UNBOUND)
 *   silences   disabling a DETECTOR makes its positive fixture stop firing
 *              (SPOKE_WITHOUT_READING, UNACKED)
 *   boundary   loosening `>` to `>=` makes the exactly-equal fixture fire (the healthy
 *              read-then-write loop, which is the one shape that must stay quiet once #421
 *              is actually wired — otherwise the sweep can never reach zero, and an
 *              always-firing detector gets switched off)
 *   counts     changing a rule in the COVERAGE block moves a reported number while no finding
 *              moves at all (#468's rollout-vs-omission split). Coverage is deliberately not a
 *              finding, so it needs an arm that reads the number; without one the split would
 *              be unpinned in exactly the way that let "83 unbound" mean nothing for weeks.
 *
 * LINUX-SAFE BY CONSTRUCTION
 * --------------------------
 * The sweep is located via OA_SWEEP (CI points it at the repo copy) and falls back to the
 * deployed OA home only when that is unset. Both PLANNER_PATH and OA_STATE_DIR are passed
 * explicitly into every child, so nothing here depends on LOCALAPPDATA existing and nothing
 * reads the real planner folder. #425's CI job went red on precisely a Linux-only path
 * assumption, so this is spelled out rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SWEEP =
  process.env.OA_SWEEP ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'catchup-doc-sweep.mjs')
    : '');

if (!SWEEP || !fs.existsSync(SWEEP)) {
  console.error(`Cannot locate catchup-doc-sweep.mjs (set OA_SWEEP). Tried: ${SWEEP || '(nothing)'}`);
  process.exit(2);
}
const src = fs.readFileSync(SWEEP, 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-cd-'));
const journal = path.join(root, 'journal');
const stateDir = path.join(root, 'state');
fs.mkdirSync(journal, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const T0 = '2026-09-03T12:00:00-07:00';
const T1 = '2026-09-03T13:00:00-07:00'; // 1h after T0 — inside the 6h read window
const TFAR = '2026-09-04T02:00:00-07:00'; // 14h after T0 — outside it
const TSAME = '2026-09-03T12:07:00-07:00'; // 7 min after T0: the real read-then-write gap

// Relative to the wall clock, for the one rule that compares a stored timestamp to NOW rather
// than to another stored timestamp (the #468 rollout-vs-omission split). A hard-coded date
// would change class as this file ages.
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

const rows = [];
const task = (id, state) => {
  rows.push(id);
  fs.writeFileSync(path.join(stateDir, `task-${id}.json`), JSON.stringify(state, null, 2), 'utf8');
  fs.writeFileSync(path.join(journal, `task-${id}.md`), `# Task ${id}\n`, 'utf8');
};
const doc = (over = {}) => ({
  doc_id: 'DOC-ID',
  doc_url: 'https://docs.google.com/document/d/DOC-ID/edit',
  seen_ids: [],
  pending_ids: [],
  observed_at: '',
  ...over,
});

// A — POSITIVE CONTROL. Bound, never observed. This is the live 2026-09-03 shape of #468.
task('901', { id: '901', status: 'in-progress', last_turn_at: T1, doc: doc() });

// B — SPOKE_WITHOUT_READING. Read at T0, then a turn at TFAR, 14h later: a different session.
task('902', { id: '902', status: 'in-progress', last_turn_at: TFAR, doc: doc({ observed_at: T0 }) });

// C — UNACKED. Read after the newest turn, but -Observe's findings were never -Ack`ed.
task('903', {
  id: '903',
  status: 'in-progress',
  last_turn_at: T0,
  doc: doc({ observed_at: T1, pending_ids: ['cmt-1', 'cmt-2'] }),
});

// D — gate TERMINAL. Closed work, bound, never read. Must NOT fire (#170: do not write at
// tasks Shiv has finished — and do not manufacture a metric that says we should).
task('904', { id: '904', status: 'done', last_turn_at: T1, doc: doc() });

// E — gate UNBOUND. No doc at all. Must NOT fire: an unbound task has no channel to be
// UNREAD, so mixing it into findings would make the headline count answer two questions.
// Dated old deliberately, so it lands in the ROLLOUT class and the omission count below is a
// stable number rather than one that changes class as this file ages.
task('905', { id: '905', status: 'in-progress', last_turn_at: daysAgo(60) });

// F — TRUE NEGATIVE, the healthy loop. Read at T1, newest turn at T0, nothing pending.
task('906', { id: '906', status: 'in-progress', last_turn_at: T0, doc: doc({ observed_at: T1 }) });

// G — BOUNDARY. Read and written at the same instant. Must NOT fire.
task('907', { id: '907', status: 'in-progress', last_turn_at: T0, doc: doc({ observed_at: T0 }) });

// H — THE REGRESSION FIXTURE, and the one that matters most. This is the live shape of a healthy
// run: PHASE 0.7 reads at 12:00, the run works, the turn lands 7 minutes later. Under the original
// bare `last_turn_at > observedAt` rule this FIRED, on every doc-bound task of every correct run
// (measured live: observed 14:36:51, turn 14:43:50). Must stay quiet, or the detector flags its own
// healthy path and gets ignored — #433's argument, and the sweep's own header argues it too.
task('908', { id: '908', status: 'in-progress', last_turn_at: TSAME, doc: doc({ observed_at: T0 }) });

// I — the window is a WINDOW, not "never fires": one hour inside it is still healthy.
task('909', { id: '909', status: 'in-progress', last_turn_at: T1, doc: doc({ observed_at: T0 }) });

// J/K — the ROLLOUT-vs-OMISSION split (#468). Both are unbound, so both must stay out of
// findings exactly like E; the difference is only whether they are counted as "woken but never
// bound". Dated relative to NOW rather than to the fixed T0/T1 above on purpose: every other
// fixture here compares two stored timestamps to each other, but this one compares a stored
// timestamp to the wall clock, so a hard-coded date would silently change class as the file
// ages and the check would start failing for reasons that have nothing to do with the code.

// J — OMISSION. Woken two days ago, wrote a turn, still has no doc.
task('910', { id: '910', status: 'in-progress', last_turn_at: daysAgo(2) });

// K — ROLLOUT. Last written to two months ago: the feature has simply not reached it. Must NOT
// be counted, or the number is just "unbound" again under a new name and can never reach zero.
task('911', { id: '911', status: 'in-progress', last_turn_at: daysAgo(60) });

// L — ROLLOUT, never woken at all. No `last_turn_at` to compare, and an absent timestamp must
// not be read as "recent" (`ts()` returns null, and null must fall on the quiet side).
task('912', { id: '912', status: 'in-progress' });

// The board is the universe of live tasks. Header included so the row regex has real shape.
fs.writeFileSync(
  path.join(root, 'planner.md'),
  ['## Today', '', '| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '| --- | --- | --- | --- | --- | --- |']
    .concat(rows.map((id) => `| ${id} | 🟡 | fixture ${id} |  | 2026-09-03 |  |`))
    .join('\n') + '\n',
  'utf8',
);

const run = (sweepPath) => {
  const r = spawnSync(process.execPath, [sweepPath], {
    env: { ...process.env, PLANNER_PATH: root, OA_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
  const fired = new Set();
  for (const m of (r.stdout || '').matchAll(/^#(\d+)\s/gm)) fired.add(m[1]);
  // The omission count is an ordinary reported number, not a finding, so it is read from the
  // coverage block rather than from `fired`. Null when the line is absent, which is itself an
  // assertable difference from zero.
  const wokenMatch = (r.stdout || '').match(/woken but never bound:\s*(\d+)/);
  const woken = wokenMatch ? Number(wokenMatch[1]) : null;
  // The ids listed under that count, so a mutation that changes WHICH tasks are counted is
  // caught even when it happens not to change how many.
  const wokenIdsLine = (r.stdout || '').match(/woken but never bound:[^\n]*\n\s*((?:#\d+(?:,\s*)?)+)/);
  const wokenIds = wokenIdsLine ? [...wokenIdsLine[1].matchAll(/#(\d+)/g)].map((m) => m[1]) : [];
  return { fired, woken, wokenIds, out: r.stdout || '', err: r.stderr || '', code: r.status };
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

console.log('== baseline (real sweep, unmutated) ==');
const base = run(SWEEP);
check('no stderr (the sweep ran, it did not crash)', base.err.trim() === '', base.err.trim().slice(0, 200));
check('A 901 fires: bound but never observed', base.fired.has('901'), [...base.fired].join(','));
check('B 902 fires: a turn was written after the last read', base.fired.has('902'), [...base.fired].join(','));
check('C 903 fires: comments observed and never acked', base.fired.has('903'), [...base.fired].join(','));
check('D 904 quiet: gate TERMINAL (done task)', !base.fired.has('904'));
check('E 905 quiet: gate UNBOUND (no doc)', !base.fired.has('905'));
check('F 906 quiet: healthy read-after-turn loop', !base.fired.has('906'));
check('G 907 quiet: read and turn at the same instant', !base.fired.has('907'));
check('H 908 quiet: the real read-then-write gap (7 min) — the regression', !base.fired.has('908'));
check('I 909 quiet: 1h trail is still one session', !base.fired.has('909'));
check('A names its kind (NEVER_READ)', /NEVER_READ/.test(base.out));
check('B names its kind (SPOKE_WITHOUT_READING)', /SPOKE_WITHOUT_READING/.test(base.out));
check('C names its kind (UNACKED)', /UNACKED/.test(base.out));
check('exit 1 with findings, so run-sweeps reads FINDINGS not OK', base.code === 1, `got ${base.code}`);
check('J 910 quiet: unbound is reported, never a finding', !base.fired.has('910'));
check('K 911 quiet: unbound is reported, never a finding', !base.fired.has('911'));
check('L 912 quiet: never woken, so nothing to report as a finding', !base.fired.has('912'));
check('omission count is reported at all', base.woken !== null, 'no "woken but never bound" line');
check(
  'omission counts ONLY the recently-woken unbound task (J), not the stale ones (E/K/L)',
  base.woken === 1 && base.wokenIds.join(',') === '910',
  `woken=${base.woken} ids=[${base.wokenIds.join(',')}]`,
);

// A clean corpus must exit 0, or the sweep is permanently red and gets ignored (#381/#398).
console.log('\n== clean corpus (only the healthy fixtures) ==');
for (const id of ['901', '902', '903']) fs.rmSync(path.join(stateDir, `task-${id}.json`));
const clean = run(SWEEP);
check('exit 0 when nothing is wrong', clean.code === 0, `got ${clean.code}`);
check('no findings printed', /UNREAD: 0/.test(clean.out), clean.out.split('\n')[0]);
for (const id of ['901', '902', '903']) {
  const st = { id, status: 'in-progress', last_turn_at: T1, doc: doc() };
  if (id === '902') { st.last_turn_at = TFAR; st.doc = doc({ observed_at: T0 }); }
  if (id === '903') { st.last_turn_at = T0; st.doc = doc({ observed_at: T1, pending_ids: ['cmt-1', 'cmt-2'] }); }
  fs.writeFileSync(path.join(stateDir, `task-${id}.json`), JSON.stringify(st, null, 2), 'utf8');
}

// Each mutation touches exactly one gate or one comparison.
const MUTATIONS = [
  {
    name: 'gate TERMINAL removed',
    kind: 'unleashes',
    guards: '904',
    find: "  if (TERMINAL.has(String(st.status))) continue; // gate TERMINAL",
    repl: '',
  },
  {
    // The gate itself, not the bookkeeping around it: `if (false)` lets every unbound task
    // fall through into the detectors, where an absent `observed_at` makes each one
    // NEVER_READ. Four fixtures move because four fixtures are unbound — that is one class,
    // not four gates, and naming all of them keeps the "changes nothing else" assertion exact.
    name: 'gate UNBOUND removed',
    kind: 'unleashes',
    guards: '905',
    alsoGuards: ['910', '911', '912'],
    find: '  if (!doc.doc_id) {',
    repl: '  if (false) {',
  },
  {
    // The #468 split. Removing the window makes "woken but never bound" count every unbound
    // task, which is the pre-#468 number wearing the new label: it can never reach zero and
    // therefore can never show that a wake stopped skipping the step.
    name: 'bind window removed (every unbound task counted as an omission)',
    kind: 'counts',
    find: '    if (wokenAt && NOW - wokenAt <= BIND_WINDOW_MS) unboundWoken.push(id);',
    repl: '    unboundWoken.push(id);',
    expect: (r) => r.woken === 4 && r.wokenIds.includes('911') && r.wokenIds.includes('912'),
    describe: (r) => `woken=${r.woken} ids=[${r.wokenIds.join(',')}]`,
  },
  {
    // The absent-timestamp half of the same rule. A task never woken has no `last_turn_at`,
    // and treating a missing value as recent would count pure rollout as omission — the
    // failure mode that made "83 unbound" useless in the first place.
    name: 'missing last_turn_at treated as recent',
    kind: 'counts',
    find: '    if (wokenAt && NOW - wokenAt <= BIND_WINDOW_MS) unboundWoken.push(id);',
    repl: '    if (!wokenAt || NOW - wokenAt <= BIND_WINDOW_MS) unboundWoken.push(id);',
    expect: (r) => r.woken === 2 && r.wokenIds.includes('912'),
    describe: (r) => `woken=${r.woken} ids=[${r.wokenIds.join(',')}]`,
  },
  {
    name: 'SPOKE_WITHOUT_READING detector disabled',
    kind: 'silences',
    guards: '902',
    find: '  if (lastTurnAt && lastTurnAt - observedAt > READ_WINDOW_MS) {',
    repl: '  if (false && lastTurnAt && lastTurnAt - observedAt > READ_WINDOW_MS) {',
  },
  {
    name: 'UNACKED detector disabled',
    kind: 'silences',
    guards: '903',
    find: "  if (pending > 0) findings.push({ ...row, kind: 'UNACKED' });",
    repl: '',
  },
  {
    // The regression, restored exactly: the rule this sweep originally shipped with.
    //
    // Unlike the others this is a RULE REPLACEMENT, not a single gate deletion, so it legitimately
    // moves every fixture whose turn trails its read — 908 (7 min) and 909 (1h). Both are named,
    // and the assertion below is still exact: any OTHER fixture moving is a failure. Loosening this
    // to "at least 908 fires" would have hidden the fact that the old rule swept in a whole class.
    name: 'read window removed (back to bare last_turn_at > observed_at)',
    kind: 'unleashes',
    guards: '908',
    alsoGuards: ['909'],
    find: '  if (lastTurnAt && lastTurnAt - observedAt > READ_WINDOW_MS) {',
    repl: '  if (lastTurnAt && lastTurnAt > observedAt) {',
  },
];

const ALL = ['901', '902', '903', '904', '905', '906', '907', '908', '909', '910', '911', '912'];

console.log('\n== mutations (each killed by exactly one arm) ==');
for (const m of MUTATIONS) {
  if (!src.includes(m.find)) {
    check(`${m.name}: anchor present in source`, false, `not found: ${m.find}`);
    continue;
  }
  const mutPath = path.join(root, `mutant-${m.guards ?? 'count'}-${m.kind}.mjs`);
  fs.writeFileSync(mutPath, src.replace(m.find, m.repl), 'utf8');
  const r = run(mutPath);

  check(`${m.name}: mutant still runs (no crash)`, r.err.trim() === '', r.err.trim().slice(0, 200));

  if (m.kind === 'counts') {
    // A reported NUMBER, not a finding: this arm is killed by the count moving, and the
    // findings must stay exactly where they were. `unbound` is deliberately kept out of
    // `findings`, so a mutation to the coverage block that also moved a finding would mean
    // the two had become entangled.
    check(`${m.name} -> the omission count changes (the rule is load-bearing)`, m.expect(r), m.describe(r));
    const moved = ALL.filter((id) => r.fired.has(id) !== base.fired.has(id));
    check(`${m.name}: no finding moves (coverage and findings stay separate)`, moved.length === 0, `moved: ${moved.join(',')}`);
    continue;
  }

  if (m.kind === 'unleashes') {
    check(`${m.name} -> #${m.guards} now fires (gate is load-bearing)`, r.fired.has(m.guards), [...r.fired].join(','));
    for (const extra of m.alsoGuards ?? []) {
      check(`${m.name} -> #${extra} also fires (same class)`, r.fired.has(extra), [...r.fired].join(','));
    }
  } else {
    check(`${m.name} -> #${m.guards} stops firing (detector is load-bearing)`, !r.fired.has(m.guards), [...r.fired].join(','));
  }

  // Nothing outside the declared set may move: the line guards only what it claims to.
  const declared = new Set([m.guards, ...(m.alsoGuards ?? [])]);
  const changed = ALL.filter((id) => !declared.has(id)).filter((id) => r.fired.has(id) !== base.fired.has(id));
  check(`${m.name}: changes nothing else`, changed.length === 0, `also moved: ${changed.join(',')}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
