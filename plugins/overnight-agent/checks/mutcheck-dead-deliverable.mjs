/**
 * mutcheck-dead-deliverable.mjs
 *
 * Mutation check for dead-deliverable-sweep.mjs.
 *
 * WHY THIS SHAPE
 * --------------
 * user-settings.md (2026-08-23) records a sweep that went green by matching a
 * word in its OWN heading. So this harness never inspects the sweep's source
 * for evidence of a fix. It builds a synthetic planner folder, runs the REAL
 * sweep as a child process against it, and asserts the verdicts.
 *
 * Then it MUTATES the sweep -- deleting one gate at a time from a temp copy of
 * the real source -- and asserts that each deletion breaks EXACTLY its own
 * negative case. A gate whose removal changes nothing is dead code pretending
 * to be a safeguard (the failure mode mutcheck-owned-target-gate.mjs found on
 * 2026-08-26). A gate whose removal breaks several cases is not the gate the
 * comment claims it is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SWEEP = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'dead-deliverable-sweep.mjs');
const src = fs.readFileSync(SWEEP, 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-dd-'));
const journal = path.join(root, 'journal');
fs.mkdirSync(journal, { recursive: true });

const w = (id, body) => fs.writeFileSync(path.join(journal, `task-${id}.md`), body, 'utf8');

// 901 POSITIVE CONTROL: a plain claim about a file that is not there.
w(901, ['# Task 901', '', '- Deliverable: `task-901-report.md`', ''].join('\n'));

// 902 gate 2 (PROMISE): a line carrying BOTH a claim verb and promise phrasing.
// The fixture must contain a claim verb, or it never reaches the PROMISE gate --
// the CLAIM requirement filters it first and the mutation proves nothing.
w(902, ['# Task 902', '', '- Built the outline. **Deliverables if approved:** `task-902-report.md` with the comparison.', ''].join('\n'));

// 903 gate 1 (PLACEHOLDER): template text, not a real path. Must NOT fire.
w(903, ['# Task 903', '', '- Deliverable: saved as `journal\\task-<ID>.md` for each task.', ''].join('\n'));

// 904 gate 3 (ACKNOWLEDGED): the journal itself says it is gone. Must NOT fire.
w(904, ['# Task 904', '', '- Built `task-904-report.md`, which no longer exists after the move.', ''].join('\n'));

// 905 gate 5 (QUOTED): an illustration of what another file might say, on a line
// that also carries a claim verb (this is the live shape from task-399 L144).
w(905, ['# Task 905', '', '- Updated it: a skill saying *"read and follow `./task-905-guardrails.md`"* keeps full trust.', ''].join('\n'));

// 907 the CLAIM requirement: a bare mention with no claim verb at all.
w(907, ['# Task 907', '', 'See also `task-907-notes.md` for background.', ''].join('\n'));

// 906 TRUE NEGATIVE: claim about a file that really exists. Must NOT fire.
w(906, ['# Task 906', '', '- Deliverable: `task-906-real.md`', ''].join('\n'));
fs.writeFileSync(path.join(journal, 'task-906-real.md'), 'real\n', 'utf8');

const run = (sweepPath) => {
  const r = spawnSync(process.execPath, [sweepPath], {
    env: { ...process.env, PLANNER_PATH: root },
    encoding: 'utf8',
  });
  const fired = new Set();
  for (const m of (r.stdout || '').matchAll(/^#(\d+)\s/gm)) fired.add(m[1]);
  return { fired, out: r.stdout || '', code: r.status };
};

// Each mutation deletes exactly one gate from a copy of the real source.
const MUTATIONS = [
  { gate: 1, guards: '903', find: 'if (isPlaceholder(raw)) continue;', repl: '' },
  { gate: 2, guards: '902', find: 'if (anyMatch(PROMISE, ctx)) continue; // gate 2 (promise wins)', repl: '' },
  { gate: 3, guards: '904', find: 'if (anyMatch(ACKNOWLEDGED, ctx)) continue; // gate 3', repl: '' },
  { gate: 5, guards: '905', find: 'if (isQuotedIllustration(line, raw)) continue; // gate 5', repl: '' },
  { gate: 'CLAIM', guards: '907', find: 'if (!anyMatch(CLAIM, ctx)) continue; // gate 2 (needs a positive claim)', repl: '' },
];

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
check('901 fires (positive control)', base.fired.has('901'), [...base.fired].join(','));
for (const id of ['902', '903', '904', '905', '906', '907']) {
  check(`${id} does not fire`, !base.fired.has(id));
}
check('exit code is 1 when findings exist', base.code === 1, `got ${base.code}`);

console.log('\n== mutations (each gate deleted in turn) ==');
for (const m of MUTATIONS) {
  if (!src.includes(m.find)) {
    check(`gate ${m.gate} anchor present in source`, false, `not found: ${m.find}`);
    continue;
  }
  const mutPath = path.join(root, `mutant-gate${m.gate}.mjs`);
  fs.writeFileSync(mutPath, src.replace(m.find, m.repl), 'utf8');
  const r = run(mutPath);

  // Its own negative case must now fire: the gate was doing real work.
  check(`gate ${m.gate} removed -> #${m.guards} now fires (gate is load-bearing)`, r.fired.has(m.guards), [...r.fired].join(','));

  // And nothing else may change: the gate guards only what it claims to.
  const others = ['902', '903', '904', '905', '906', '907'].filter((id) => id !== m.guards);
  const leaked = others.filter((id) => r.fired.has(id));
  check(`gate ${m.gate} removal changes nothing else`, leaked.length === 0, `also fired: ${leaked.join(',')}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

