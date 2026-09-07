// mutcheck-ensure-catchup-doc.mjs — proves every gate in ensure-catchup-doc.mjs is load-bearing.
//
// WHY (repo convention, and this file in particular)
// -------------------------------------------------
// A guard with no mutation check is a prose row wearing a code row's costume. That is not a
// slogan here: ensure-catchup-doc.mjs exists BECAUSE a step that nothing verified was assumed to
// be happening for months. Shipping its replacement unverified would rebuild the same defect one
// level up — an invariant nobody checks is an instruction nobody follows, with extra syntax.
//
// The mutation direction is "unleash or silence": switch a gate off and the decision for a
// fixture must change. Each gate below is switched off in turn, and the check must then fail.
//
// The whole check runs on `--dry-run`, so it performs no document creation and needs neither the
// capability probe nor PowerShell. That is what lets it run on the Linux CI runner, and it is why
// the decision in ensure-catchup-doc.mjs is a pure function with the effects on the other side.
//
//   node mutcheck-ensure-catchup-doc.mjs
//   OA_ENSURE=<abs path> node mutcheck-ensure-catchup-doc.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECKS = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const ENSURE =
  process.env.OA_ENSURE ||
  path.join(CHECKS, 'ensure-catchup-doc.mjs');

if (!fs.existsSync(ENSURE)) {
  console.error(`ensure-catchup-doc.mjs not found at ${ENSURE}`);
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-ecd-'));
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const rows = [];
const task = (id, state) => {
  rows.push(id);
  fs.writeFileSync(path.join(stateDir, `task-${id}.json`), JSON.stringify(state, null, 2), 'utf8');
};

// A — UNBOUND and live. The whole point: this must be created.
task('801', { id: '801', status: 'in-progress' });

// B — BOUND. The "else continue" half. Must never be touched, because rebinding would orphan the
// page Shiv has been commenting on.
task('802', { id: '802', status: 'in-progress', doc: { doc_id: 'DOC-802' } });

// C — TERMINAL and unbound. Closed work gets no doc (#170).
task('803', { id: '803', status: 'done' });

// D — TERMINAL the other way.
task('804', { id: '804', status: 'skip' });

// E — UNBOUND, second live one. Exists so the LIMIT gate has something to defer.
task('805', { id: '805', status: 'in-progress' });

// F — doc object present but EMPTY. An empty doc object is not a binding; treating a `doc: {}`
// as bound is the natural off-by-one here and would silently skip a task forever.
task('806', { id: '806', status: 'in-progress', doc: {} });

// G — a board row with NO state file at all. Deliberately not written to stateDir.
rows.push('807');

fs.writeFileSync(
  path.join(root, 'planner.md'),
  ['## Today', '', '| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '| --- | --- | --- | --- | --- | --- |']
    .concat(rows.map((id) => `| ${id} | 🟡 | fixture ${id} |  | 2026-09-03 |  |`))
    .join('\n') + '\n',
  'utf8',
);

const run = (p, limit = '10') => {
  const r = spawnSync(process.execPath, [p, '--dry-run', '--limit', limit], {
    env: { ...process.env, PLANNER_PATH: root, OA_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
  const out = r.stdout || '';
  const created = [...out.matchAll(/^CREATE (\d+)/gm)].map((m) => m[1]);
  const sum = out.match(/created (\d+), continued (\d+), skipped (\d+), failed (\d+)/);
  return {
    created,
    counts: sum ? { created: +sum[1], continued: +sum[2], skipped: +sum[3], failed: +sum[4] } : null,
    out,
    err: r.stderr || '',
    code: r.status,
  };
};

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('BASELINE');
const base = run(ENSURE);
check('exits 0 with no failures', base.code === 0, `code ${base.code} ${base.err}`);
check('creates the unbound live tasks', ['801', '805', '806'].every((id) => base.created.includes(id)), base.created.join(','));
check('does not create for the bound task (else continue)', !base.created.includes('802'));
check('does not create for terminal tasks', !base.created.includes('803') && !base.created.includes('804'));
check('does not create for a row with no state', !base.created.includes('807'));
check('counts: 3 created, 1 continued, 3 skipped', base.counts && base.counts.created === 3 && base.counts.continued === 1 && base.counts.skipped === 3, JSON.stringify(base.counts));

console.log('\nLIMIT');
const limited = run(ENSURE, '2');
check('limit caps creations', limited.counts && limited.counts.created === 2, JSON.stringify(limited.counts));
check('limit reports the deferral rather than silently dropping it', /deferred 1 to a later run/.test(limited.out), limited.out.trim());

// Each mutation switches one gate off. `expect` names what must change; if the decision is
// unchanged the gate was decorative and the check fails.
const MUTATIONS = [
  {
    name: 'gate BOUND removed',
    find: "  if (doc.doc_id) return { action: 'CONTINUE', reason: 'bound' };",
    repl: "  if (false) return { action: 'CONTINUE', reason: 'bound' };",
    // The bound task would be rebound — the orphaning failure this gate exists to prevent.
    expect: (r) => r.created.includes('802'),
    why: 'a bound task must never be re-created',
  },
  {
    name: 'gate TERMINAL removed',
    find: "  if (TERMINAL.has(String(state.status))) return { action: 'SKIP', reason: 'terminal' };",
    repl: "  if (false) return { action: 'SKIP', reason: 'terminal' };",
    expect: (r) => r.created.includes('803') && r.created.includes('804'),
    why: 'closed work must not get a doc',
  },
  {
    name: 'gate NO STATE removed',
    find: "  if (!state) return { action: 'SKIP', reason: 'no-state' };",
    repl: "  if (!state && false) return { action: 'SKIP', reason: 'no-state' };",
    // Without the gate the null state reaches `state.status` and throws, so the run cannot
    // report a clean success. Either it creates for 807 or it exits non-zero; both are a change.
    expect: (r) => r.created.includes('807') || r.code !== 0,
    why: 'a board row with no state must be skipped, not seeded',
  },
  {
    name: 'empty doc object treated as a binding',
    find: '  const doc = state.doc ?? {};',
    repl: '  const doc = state.doc ?? {}; if (state.doc) return { action: \'CONTINUE\', reason: \'bound\' };',
    expect: (r) => !r.created.includes('806'),
    why: 'doc:{} is not a binding and must still be created',
  },
  {
    name: 'gate LIMIT removed',
    find: '  if (created >= LIMIT) {',
    repl: '  if (false) {',
    expect: (r) => {
      const l = run(mutPathRef.current, '2');
      return l.counts && l.counts.created > 2;
    },
    why: 'the per-run creation cap must actually cap',
  },
];

const mutPathRef = { current: '' };

console.log('\nMUTATIONS');
const src = fs.readFileSync(ENSURE, 'utf8');
for (const m of MUTATIONS) {
  if (!src.includes(m.find)) {
    check(`${m.name}: anchor present in source`, false, `not found: ${m.find}`);
    continue;
  }
  const mutPath = path.join(root, `mut-${MUTATIONS.indexOf(m)}.mjs`);
  mutPathRef.current = mutPath;
  fs.writeFileSync(mutPath, src.replace(m.find, m.repl), 'utf8');
  const r = run(mutPath);
  check(`${m.name} — ${m.why}`, m.expect(r), `created=[${r.created.join(',')}] code=${r.code}`);
}

// WIRING. Every assertion above proves the invariant DECIDES correctly; none of them prove
// anything ever RUNS it. When this file first shipped (#580) that was literally true: the
// binder was deployed, correct, mutation-proven, and invoked by nothing -- indistinguishable
// from a binder that had nothing to bind, because both print no failures. That is the same
// shape as the 29 omissions it was written to end. So the roster membership is an assertion,
// not a convention: `run-sweeps.ps1` derives the oa-home deploy set from its $Suite literal,
// which makes this one line simultaneously the proof that it runs and the reason it is
// present on the machine that runs it. Delete the suite entry and this fails.
console.log('\nWIRING');
{
  const runner = path.join(CHECKS, 'run-sweeps.ps1');
  let suiteNames = null;
  if (fs.existsSync(runner)) {
    const rs = fs.readFileSync(runner, 'utf8');
    const start = rs.indexOf('$Suite = @(');
    if (start !== -1) {
      const body = rs.slice(start, rs.indexOf('\n)', start));
      suiteNames = [...body.matchAll(/n\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    }
  }
  check(
    'ensure-catchup-doc is on the run-sweeps roster (so it is invoked, and so it deploys)',
    Array.isArray(suiteNames) && suiteNames.includes('ensure-catchup-doc'),
    suiteNames ? `suite = ${suiteNames.join(', ')}` : 'could not parse $Suite in run-sweeps.ps1',
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* temp dir */
}
process.exit(fail > 0 ? 1 : 0);
