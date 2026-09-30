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
// The gate checks run on `--dry-run`; recovery checks inject synthetic create/bind effects.
// Neither calls Google or PowerShell, so both can run on the Linux CI runner.
//
//   node mutcheck-ensure-catchup-doc.mjs
//   OA_ENSURE=<abs path> node mutcheck-ensure-catchup-doc.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

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
    find: "    else if (created >= LIMIT) capped.push(row.id);",
    repl: "    else if (false) capped.push(row.id);",
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

// These exercise the real create/receipt/bind sequence with filesystem state, not just decide().
console.log('\nRECOVERY EFFECTS (#763)');
const { ensureBinding, parseCreatedDoc } = await import(pathToFileURL(ENSURE).href);
let caseNumber = 0;
const effectCase = (name, runCase) => {
  const dir = path.join(root, `effects-${++caseNumber}`);
  fs.mkdirSync(dir);
  const statePath = path.join(dir, 'state.json');
  const id = '900001';
  const docId = 'synthetic_document_000000000000000000000000000001';
  const otherId = 'synthetic_document_000000000000000000000000000002';
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const setState = (st) => fs.writeFileSync(statePath, JSON.stringify(st));
  setState({ id, status: 'in-progress' });
  let creates = 0;
  let binds = 0;
  const receiptDir = path.join(dir, 'receipts');
  const receiptPath = path.join(receiptDir, `task-${id}.json`);
  const readReceipt = () => JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const opts = {
    id, planner: dir, receiptDir, readState,
    create: () => { creates++; return docId; },
    bind: (value) => {
      binds++;
      assert.equal(readReceipt().docId, value, 'confirmed ID persisted before bind');
      setState({ ...readState(), doc: { doc_id: value } });
    },
  };
  try {
    runCase({
      opts, dir, id, docId, otherId, readState, setState, receiptPath, readReceipt,
      counts: () => ({ creates, binds }),
    });
    check(name, true);
  } catch (error) {
    check(name, false, error.stack);
  }
};

effectCase('two failed binds and a successful retry create exactly one doc', (f) => {
  for (let i = 0; i < 2; i++) {
    assert.throws(() => ensureBinding({ ...f.opts, bind: () => { throw new Error('bind failed'); } }), /bind failed/);
    assert.equal(f.readReceipt().docId, f.docId);
  }
  assert.equal(ensureBinding(f.opts).created, false);
  assert.equal(f.readState().doc.doc_id, f.docId);
  assert.equal(ensureBinding(f.opts).action, 'CONTINUE');
  assert.deepEqual(f.counts(), { creates: 1, binds: 1 });
});

effectCase('only successful MCP content can confirm the created document', (f) => {
  const content = [{ type: 'text', text: `Created https://docs.google.com/document/d/${f.docId}/edit` }];
  assert.equal(parseCreatedDoc(JSON.stringify({ content })), f.docId);
  assert.throws(() => parseCreatedDoc(JSON.stringify({ error: { message: content[0].text } })), /uncertain/);
  assert.throws(() => parseCreatedDoc(JSON.stringify({ isError: true, content })), /uncertain/);
  assert.throws(() => parseCreatedDoc('{}'), /no confirmed document ID/);
  assert.throws(() => parseCreatedDoc('not JSON'));
});

effectCase('process interruption after confirmed receipt recovers without create', (f) => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ensureBinding } from ${JSON.stringify(pathToFileURL(ENSURE).href)};
    ensureBinding({
      id: ${JSON.stringify(f.id)}, planner: ${JSON.stringify(f.dir)},
      receiptDir: ${JSON.stringify(f.opts.receiptDir)},
      readState: () => ({status: 'in-progress'}),
      create: () => ${JSON.stringify(f.docId)},
      bind: () => process.exit(23)
    });
  `], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(f.readReceipt().status, 'created');
  assert.equal(ensureBinding(f.opts).created, false);
  assert.deepEqual(f.counts(), { creates: 0, binds: 1 });
});

effectCase('ambiguous create persists intent and never retries creation', (f) => {
  let calls = 0;
  const opts = { ...f.opts, create: () => { calls++; throw new Error('response lost'); } };
  assert.throws(() => ensureBinding(opts), /response lost.*uncertain/);
  assert.throws(() => ensureBinding(opts), /uncertain/);
  assert.equal(calls, 1);
  assert.equal(f.readReceipt().status, 'creating');
});

effectCase('interruption during creation leaves a non-retryable intent', (f) => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ensureBinding } from ${JSON.stringify(pathToFileURL(ENSURE).href)};
    ensureBinding({
      id: ${JSON.stringify(f.id)}, planner: ${JSON.stringify(f.dir)},
      receiptDir: ${JSON.stringify(f.opts.receiptDir)},
      readState: () => ({status: 'in-progress'}),
      create: () => process.exit(24),
      bind: () => { throw new Error('must not bind'); }
    });
  `], { encoding: 'utf8' });
  assert.equal(child.status, 24, child.stderr);
  assert.throws(() => ensureBinding(f.opts), /uncertain/);
  assert.deepEqual(f.counts(), { creates: 0, binds: 0 });
});

effectCase('another creator cannot send while the first create is in flight', (f) => {
  ensureBinding({
    ...f.opts,
    create: () => {
      assert.throws(() => ensureBinding(f.opts), /uncertain/);
      return f.opts.create();
    },
  });
  assert.deepEqual(f.counts(), { creates: 1, binds: 1 });
});

effectCase('binding established during creation is never overwritten', (f) => {
  assert.throws(() => ensureBinding({
    ...f.opts,
    create: () => {
      f.setState({ status: 'in-progress', doc: { doc_id: f.otherId } });
      return f.opts.create();
    },
  }), /Binding conflict/);
  assert.equal(f.readState().doc.doc_id, f.otherId);
  assert.equal(f.readReceipt().docId, f.docId);
  assert.throws(() => ensureBinding(f.opts), /Binding conflict/);
  assert.deepEqual(f.counts(), { creates: 1, binds: 0 });
});

effectCase('bind returning success without persisted binding fails visibly', (f) => {
  assert.throws(() => ensureBinding({ ...f.opts, bind: () => {} }), /not verified/);
  assert.equal(ensureBinding(f.opts).created, false);
  assert.deepEqual(f.counts(), { creates: 1, binds: 1 });
});

effectCase('closed, missing-state and already-bound tasks retain their protections', (f) => {
  for (const st of [null, { status: 'done' }, { status: 'skip' }]) {
    f.setState(st);
    assert.equal(ensureBinding(f.opts).action, 'SKIP');
  }
  f.setState({ status: 'in-progress', doc: { doc_id: f.docId } });
  assert.equal(ensureBinding(f.opts).action, 'CONTINUE');
  assert.equal(fs.existsSync(f.receiptPath), false);
  assert.deepEqual(f.counts(), { creates: 0, binds: 0 });
});

effectCase('a task closed while creating is not bound and retains recovery evidence', (f) => {
  const result = ensureBinding({
    ...f.opts,
    create: () => { f.setState({ status: 'done' }); return f.opts.create(); },
  });
  assert.equal(result.action, 'SKIP');
  assert.equal(f.readReceipt().docId, f.docId);
  assert.deepEqual(f.counts(), { creates: 1, binds: 0 });
});

effectCase('creation cap does not block recovery of an already-created document', (f) => {
  assert.equal(ensureBinding({ ...f.opts, allowCreate: () => false }).action, 'DEFER');
  assert.equal(fs.existsSync(f.receiptPath), false);
  assert.throws(() => ensureBinding({ ...f.opts, bind: () => { throw new Error('bind failed'); } }), /bind failed/);
  assert.equal(ensureBinding({ ...f.opts, allowCreate: () => false }).created, false);
  assert.deepEqual(f.counts(), { creates: 1, binds: 1 });
});

effectCase('failed binds consume the creation cap but not the recovery allowance', (f) => {
  let attempts = 0;
  const opts = {
    ...f.opts, allowCreate: () => attempts < 1, onAttempt: () => { attempts++; },
    bind: () => { throw new Error('bind failed'); },
  };
  assert.throws(() => ensureBinding(opts), /bind failed/);
  assert.equal(ensureBinding({ ...opts, id: '900002' }).action, 'DEFER');
  assert.equal(ensureBinding({ ...opts, bind: f.opts.bind }).created, false);
  assert.equal(attempts, 1);
  assert.deepEqual(f.counts(), { creates: 1, binds: 1 });
});

effectCase('confirmed-receipt write failure reports the ID without creating again', (f) => {
  const pending = `${f.receiptPath}.${process.pid}.confirmed`;
  assert.throws(() => ensureBinding({
    ...f.opts,
    create: () => {
      fs.mkdirSync(pending);
      return f.opts.create();
    },
  }), new RegExp(`Created ${f.docId}, but receipt confirmation failed`));
  assert.equal(f.readReceipt().status, 'creating');
  assert.throws(() => ensureBinding(f.opts), /uncertain/);
  assert.deepEqual(f.counts(), { creates: 1, binds: 0 });
});

effectCase('corrupt and wrong-planner receipts fail closed without creating', (f) => {
  fs.mkdirSync(f.opts.receiptDir);
  fs.writeFileSync(f.receiptPath, '{');
  assert.throws(() => ensureBinding(f.opts), /Cannot read creation receipt/);
  fs.writeFileSync(f.receiptPath, JSON.stringify({
    version: 1, taskId: f.id, planner: 'different-root', status: 'created', docId: f.docId,
  }));
  assert.throws(() => ensureBinding(f.opts), /Invalid creation receipt/);
  assert.deepEqual(f.counts(), { creates: 0, binds: 0 });
});

effectCase('receipt persistence failure prevents external creation', (f) => {
  fs.writeFileSync(f.opts.receiptDir, 'not a directory');
  assert.throws(() => ensureBinding(f.opts));
  assert.deepEqual(f.counts(), { creates: 0, binds: 0 });
});

console.log(`\n${pass} passed, ${fail} failed`);
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* temp dir */
}
process.exit(fail > 0 ? 1 : 0);
