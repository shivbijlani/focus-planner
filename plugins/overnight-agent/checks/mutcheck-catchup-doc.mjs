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
const T1 = '2026-09-03T13:00:00-07:00'; // strictly after T0

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

// B — SPOKE_WITHOUT_READING. Observed at T0, then a turn written at T1.
task('902', { id: '902', status: 'in-progress', last_turn_at: T1, doc: doc({ observed_at: T0 }) });

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

// E — gate UNBOUND. No doc at all. Must NOT fire: whether every task should have a doc is
// #421's open "Scope" question, not a broken channel.
task('905', { id: '905', status: 'in-progress', last_turn_at: T1 });

// F — TRUE NEGATIVE, the healthy loop. Read at T1, newest turn at T0, nothing pending.
task('906', { id: '906', status: 'in-progress', last_turn_at: T0, doc: doc({ observed_at: T1 }) });

// G — BOUNDARY. Read and written at the same instant: read-then-write within one run, which
// is exactly what the wired loop produces. Must NOT fire, or the sweep can never reach zero.
task('907', { id: '907', status: 'in-progress', last_turn_at: T0, doc: doc({ observed_at: T0 }) });

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
  return { fired, out: r.stdout || '', err: r.stderr || '', code: r.status };
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
check('A names its kind (NEVER_READ)', /NEVER_READ/.test(base.out));
check('B names its kind (SPOKE_WITHOUT_READING)', /SPOKE_WITHOUT_READING/.test(base.out));
check('C names its kind (UNACKED)', /UNACKED/.test(base.out));
check('exit 1 with findings, so run-sweeps reads FINDINGS not OK', base.code === 1, `got ${base.code}`);

// A clean corpus must exit 0, or the sweep is permanently red and gets ignored (#381/#398).
console.log('\n== clean corpus (only the healthy fixtures) ==');
for (const id of ['901', '902', '903']) fs.rmSync(path.join(stateDir, `task-${id}.json`));
const clean = run(SWEEP);
check('exit 0 when nothing is wrong', clean.code === 0, `got ${clean.code}`);
check('no findings printed', /UNREAD: 0/.test(clean.out), clean.out.split('\n')[0]);
for (const id of ['901', '902', '903']) {
  const st = { id, status: 'in-progress', last_turn_at: T1, doc: doc() };
  if (id === '902') st.doc = doc({ observed_at: T0 });
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
    name: 'gate UNBOUND removed',
    kind: 'unleashes',
    guards: '905',
    find: '  if (!doc.doc_id) continue; // gate UNBOUND',
    repl: '',
  },
  {
    name: 'SPOKE_WITHOUT_READING detector disabled',
    kind: 'silences',
    guards: '902',
    find: '  if (lastTurnAt && lastTurnAt > observedAt) {',
    repl: '  if (false && lastTurnAt && lastTurnAt > observedAt) {',
  },
  {
    name: 'UNACKED detector disabled',
    kind: 'silences',
    guards: '903',
    find: "  if (pending > 0) findings.push({ ...row, kind: 'UNACKED' });",
    repl: '',
  },
  {
    name: 'freshness boundary loosened (> becomes >=)',
    kind: 'unleashes',
    guards: '907',
    find: '  if (lastTurnAt && lastTurnAt > observedAt) {',
    repl: '  if (lastTurnAt && lastTurnAt >= observedAt) {',
  },
];

const ALL = ['901', '902', '903', '904', '905', '906', '907'];

console.log('\n== mutations (each killed by exactly one arm) ==');
for (const m of MUTATIONS) {
  if (!src.includes(m.find)) {
    check(`${m.name}: anchor present in source`, false, `not found: ${m.find}`);
    continue;
  }
  const mutPath = path.join(root, `mutant-${m.guards}-${m.kind}.mjs`);
  fs.writeFileSync(mutPath, src.replace(m.find, m.repl), 'utf8');
  const r = run(mutPath);

  check(`${m.name}: mutant still runs (no crash)`, r.err.trim() === '', r.err.trim().slice(0, 200));

  if (m.kind === 'unleashes') {
    check(`${m.name} -> #${m.guards} now fires (gate is load-bearing)`, r.fired.has(m.guards), [...r.fired].join(','));
  } else {
    check(`${m.name} -> #${m.guards} stops firing (detector is load-bearing)`, !r.fired.has(m.guards), [...r.fired].join(','));
  }

  // Nothing else may move: the line guards only what it claims to.
  const changed = ALL.filter((id) => id !== m.guards).filter((id) => r.fired.has(id) !== base.fired.has(id));
  check(`${m.name}: changes nothing else`, changed.length === 0, `also moved: ${changed.join(',')}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
