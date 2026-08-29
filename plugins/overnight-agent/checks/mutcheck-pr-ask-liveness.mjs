// mutcheck-pr-ask-liveness.mjs
//
// Proves pr-ask-liveness-sweep actually pins the behaviour it claims, on throwaway trees
// with a fixed GitHub fixture. Rule this exists for (user-settings.md, 2026-08-26 11:15 and
// 12:10): "a detector that goes to zero right after you edit it has not necessarily been
// fixed", and "mutation-check the GUARDS, not just the matcher".
//
// Each case builds a miniature planner (board + journal + agent state) plus a fixture
// describing GitHub, runs the real sweep, and asserts on its output.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWEEP = path.join(HERE, 'pr-ask-liveness-sweep.mjs');

let pass = 0; let fail = 0;
const failures = [];

function build(tmp, { journal, fixture, id = '900' }) {
  fs.mkdirSync(path.join(tmp, 'journal'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'planner.md'),
    `## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|------|---|---|---|\n| ${id} | 🟡 | Fixture task | - |  |  |\n`);
  fs.writeFileSync(path.join(tmp, 'journal', `task-${id}.md`), journal);
  fs.writeFileSync(path.join(tmp, 'state', `task-${id}.json`), JSON.stringify({ status: 'in-progress' }));
  fs.writeFileSync(path.join(tmp, 'fixture.json'), JSON.stringify(fixture));
}

function run(tmp) {
  const env = {
    ...process.env,
    PLANNER_PATH: tmp,
    LOCALAPPDATA: tmp,            // state dir resolves to <tmp>/overnight-agent/state
    OA_PR_SWEEP_FIXTURE: path.join(tmp, 'fixture.json'),
    OA_PR_SWEEP_REPOS: 'acme/widget',
  };
  // state dir is <LOCALAPPDATA>/overnight-agent/state
  fs.mkdirSync(path.join(tmp, 'overnight-agent'), { recursive: true });
  fs.cpSync(path.join(tmp, 'state'), path.join(tmp, 'overnight-agent', 'state'), { recursive: true });
  try {
    return { out: execFileSync('node', [SWEEP], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 };
  }
}

function check(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-prsweep-'));
  try {
    fn(tmp);
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n          ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const turn = (askLine, extra = '') => `# Task 900: Fixture task

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## 🌙 Overnight Agent

**Status:** In-progress

Linked: https://github.com/acme/widget/pull/42
${extra}

<!-- from: overnight-agent -->
**Needs from you:** ${askLine}
`;

// ---------------------------------------------------------------------------------------
console.log('pr-ask-liveness-sweep — mutation checks\n');

check('FIRES on an ask naming a MERGED pr (dead ask)', (tmp) => {
  build(tmp, {
    journal: turn('one word - **`merge 42`** and I will land it.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'already landed' } } } },
  });
  const { out, code } = run(tmp);
  assert(/dead-merged/.test(out), 'expected dead-merged verdict');
  assert(code === 1, `expected exit 1, got ${code}`);
});

check('FIRES on an ask naming a CLOSED pr (dead ask)', (tmp) => {
  build(tmp, {
    journal: turn('reply **`merge 42`**.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'CLOSED', title: 'abandoned' } } } },
  });
  assert(/dead-closed/.test(run(tmp).out), 'expected dead-closed verdict');
});

check('FIRES on a MISSING reference (the dangerous case)', (tmp) => {
  build(tmp, {
    journal: turn('reply **`merge 42`**.'),
    fixture: { 'acme/widget': { prs: { 7: { state: 'OPEN', title: 'unrelated' } } } },
  });
  const out = run(tmp).out;
  assert(/missing/.test(out), 'expected missing verdict');
  assert(/WRONG REFERENCE/.test(out), 'missing refs must be marked as dangerous');
});

check('FIRES on an OPEN but CONFLICTING pr (the `merge 121` rule)', (tmp) => {
  build(tmp, {
    journal: turn('reply **`merge 42`**.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'OPEN', mergeable: 'CONFLICTING', title: 'cannot merge' } } } },
  });
  const out = run(tmp).out;
  // Assert on the FINDING, not the word: "unexecutable" also appears in the [A] header
  // line, so a bare /unexecutable/ match is satisfied by our own scaffolding.
  assert(/absent or unexecutable: 1/.test(out), 'the [A] finding count must be 1');
  assert(/^\s+unexecutable\s+`merge 42`/m.test(out), 'expected an unexecutable finding row for `merge 42`');
});

check('SILENT on an OPEN + MERGEABLE pr (the healthy case)', (tmp) => {
  build(tmp, {
    journal: turn('reply **`merge 42`**.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'OPEN', mergeable: 'MERGEABLE', title: 'fine' } } } },
  });
  const { out, code } = run(tmp);
  assert(/FLAGGED - ask points at a PR that is merged, closed, absent or unexecutable: 0/.test(out), 'healthy ask must not be flagged');
  assert(code === 0, `expected exit 0, got ${code}`);
});

check('GUARD: unresolved refs are reported but NEVER counted as findings', (tmp) => {
  // No github URL anywhere -> the number cannot be tied to a repo.
  const j = `# Task 900: Fixture task

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

<!-- from: overnight-agent -->
**Needs from you:** reply **\`merge 999\`**.
`;
  build(tmp, { journal: j, fixture: { 'acme/widget': { prs: {} } } });
  const { out, code } = run(tmp);
  assert(/unresolved \(no URL in the journal ties the number to a repo\): 1/.test(out), 'expected 1 unresolved');
  assert(/absent or unexecutable: 0/.test(out), 'unresolved must not become a finding');
  assert(code === 0, 'unresolved alone must not fail the sweep');
});

check('GUARD: a number in an OLDER turn is history, not a live ask', (tmp) => {
  const j = `# Task 900: Fixture task

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

Linked: https://github.com/acme/widget/pull/42

<!-- from: overnight-agent -->
**Needs from you:** reply **\`merge 42\`**.

## 2026-08-20
<!-- from: me -->
ok

<!-- from: overnight-agent -->
**Needs from you:** nothing - all set.
`;
  build(tmp, {
    journal: j,
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'landed' } } } },
  });
  const out = run(tmp).out;
  assert(/names an action on a PR\/issue: 0/.test(out), 'a superseded turn must not be treated as the live ask');
});

check('GUARD: documentation lines do not trip the detector', (tmp) => {
  build(tmp, {
    journal: turn('nothing. (Historical note: this sweep once treated `merge 42` as a dead ask.)'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'landed' } } } },
  });
  const out = run(tmp).out;
  assert(/names an action on a PR\/issue: 0/.test(out), 'a line documenting the defect must be skipped');
});

check('UNKNOWN mergeability is surfaced, never silently read as clean', (tmp) => {
  build(tmp, {
    journal: turn('reply **`merge 42`**.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'OPEN', mergeable: 'UNKNOWN', title: 'not computed' } } } },
  });
  const out = run(tmp).out;
  assert(/still UNKNOWN/.test(out), 'unresolved mergeability must be reported in the header');
});

check('[B] FIRES on a CONFLICTING open PR even when no ask names it', (tmp) => {
  build(tmp, {
    journal: turn('nothing right now.'),
    fixture: {
      'acme/widget': {
        prs: {
          42: { state: 'OPEN', mergeable: 'MERGEABLE', title: 'fine' },
          43: { state: 'OPEN', mergeable: 'CONFLICTING', title: 'latent dead ask' },
        },
      },
    },
  });
  const { out, code } = run(tmp);
  assert(/CONFLICTING \(latent dead asks\): 1/.test(out), 'repo-level conflict must be reported');
  assert(/acme\/widget#43/.test(out), 'the conflicting PR must be named');
  assert(code === 1, 'a latent dead ask must fail the sweep');
});

check('MUTATION: removing the mergeable check would miss the #121 class', (tmp) => {
  // Pin that the OPEN+CONFLICTING case is decided by `mergeable`, not by `state`:
  // same state, different mergeable, must give different [A] verdicts.
  //
  // NB: this asserts on the [A] FLAGGED COUNT, not on the exit code. Dimension B also
  // fails the run for a conflicting PR, so an exit-code comparison stays 0/1 even when
  // the ask-level check is deleted — a false green that the first draft of this harness
  // actually shipped.
  const A = (s) => Number((s.match(/absent or unexecutable: (\d+)/) || [, '-1'])[1]);
  build(tmp, {
    journal: turn('reply **`merge 42`**.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'OPEN', mergeable: 'MERGEABLE', title: 'x' } } } },
  });
  const clean = A(run(tmp).out);
  fs.writeFileSync(path.join(tmp, 'fixture.json'),
    JSON.stringify({ 'acme/widget': { prs: { 42: { state: 'OPEN', mergeable: 'CONFLICTING', title: 'x' } } } }));
  const dirty = A(run(tmp).out);
  assert(clean === 0 && dirty === 1,
    `state is identical in both runs; only mergeable differs, so the [A] count must go 0 -> 1 (got ${clean} -> ${dirty})`);
});

// ---------------------------------------------------------------------------------------
// ORPHAN-JOURNAL COVERAGE (2026-08-29)
//
// The sweep used to build its universe from planner.md rows only, so a task with a journal
// but no board row was never examined. Measured live: 69 such journals, and they are almost
// exactly the agent-programme cluster — the tasks that actually carry `merge NNN` asks. The
// sweep reported 0 stale asks while #425 asked for `merge 252`, merged an hour earlier.
//
// These cases pin BOTH directions: the orphan must be seen, and a task the user has
// COMPLETED must still be ignored (otherwise the fix trades a blind spot for a noise source).

function buildBoardless(tmp, { journal, fixture, id = '900', completed = false }) {
  fs.mkdirSync(path.join(tmp, 'journal'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  // An open board with NO row for this task - this is the orphan shape.
  fs.writeFileSync(path.join(tmp, 'planner.md'),
    '## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|------|---|---|---|\n');
  fs.writeFileSync(path.join(tmp, 'planner-completed.md'),
    completed
      ? `| ID | Task |\n|---|---|\n| ${id} | Fixture task |\n`
      : '| ID | Task |\n|---|---|\n');
  fs.writeFileSync(path.join(tmp, 'journal', `task-${id}.md`), journal);
  fs.writeFileSync(path.join(tmp, 'state', `task-${id}.json`), JSON.stringify({ status: 'in-progress' }));
  fs.writeFileSync(path.join(tmp, 'fixture.json'), JSON.stringify(fixture));
}

check('FIRES on a dead ask in a journal with NO board row (the #425 regression)', (tmp) => {
  buildBoardless(tmp, {
    journal: turn('reply **`merge 42`** if you want it landed.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'already landed' } } } },
  });
  const { out, code } = run(tmp);
  assert(/dead-merged/.test(out), 'an orphan journal must still be checked');
  assert(/\+ 1 journal\(s\) with no board row/.test(out), 'the orphan must be counted in the reported universe');
  assert(code === 1, `expected exit 1, got ${code}`);
});

check('IGNORES a boardless task the user has COMPLETED (no new noise)', (tmp) => {
  buildBoardless(tmp, {
    completed: true,
    journal: turn('reply **`merge 42`** if you want it landed.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'already landed' } } } },
  });
  const { out, code } = run(tmp);
  assert(!/dead-merged/.test(out), 'a completed task must not be revived as a finding');
  assert(/\+ 0 journal\(s\) with no board row/.test(out), 'a completed task must not enter the universe');
  assert(code === 0, `expected a clean exit, got ${code}`);
});

check('MUTATION: reverting to a board-only universe loses the orphan finding', (tmp) => {
  // Same journal, same fixture, same GitHub state. The ONLY difference is whether the task
  // has a board row. Pre-fix the boardless run found nothing; both must now find it, which
  // is what proves the universe - not the matcher - was the defect.
  const A = (s) => Number((s.match(/absent or unexecutable: (\d+)/) || [, '-1'])[1]);
  const journal = turn('reply **`merge 42`**.');
  const fixture = { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'landed' } } } };

  buildBoardless(tmp, { journal, fixture });
  const boardless = A(run(tmp).out);

  build(tmp, { journal, fixture });
  fs.writeFileSync(path.join(tmp, 'planner-completed.md'), '| ID | Task |\n|---|---|\n');
  const onBoard = A(run(tmp).out);

  assert(onBoard === 1 && boardless === 1,
    `a dead ask must be found whether or not the task has a board row (on-board ${onBoard}, boardless ${boardless})`);
});

check('a terminal agent status still wins for a boardless task', (tmp) => {
  buildBoardless(tmp, {
    journal: turn('reply **`merge 42`**.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'landed' } } } },
  });
  // done/skip is the agent's own "finished" signal and must keep suppressing the check.
  fs.writeFileSync(path.join(tmp, 'state', 'task-900.json'), JSON.stringify({ status: 'done' }));
  const { out, code } = run(tmp);
  assert(!/dead-merged/.test(out), 'a done task must stay out of the findings');
  assert(code === 0, `expected a clean exit, got ${code}`);
});

check('GUARD: a line RETRACTING an old ask is not a finding (#353 false positive)', (tmp) => {
  // Found by widening the universe: #353's live turn says the old `merge 150`/`merge 126`
  // ask is done and to ignore it, and was flagged for the tokens it was withdrawing.
  buildBoardless(tmp, {
    journal: turn('nothing. The old ask here (**`merge 42`**) is done - both are merged. Ignore it if you see it above.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'landed' } } } },
  });
  const { out, code } = run(tmp);
  assert(!/dead-merged/.test(out), 'a retracted ask must not be re-reported as a live dead ask');
  assert(code === 0, `expected a clean exit, got ${code}`);
});

check('MUTATION: the retraction guard must not silence a GENUINE dead ask', (tmp) => {
  // The counterweight to the case above. A guard that suppresses noise is only safe if it
  // still lets the real thing through - otherwise the fix for a false positive becomes a
  // new blind spot, which is the exact trade this whole sweep exists to prevent.
  buildBoardless(tmp, {
    journal: turn('reply **`merge 42`** and I will land it.'),
    fixture: { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'landed' } } } },
  });
  const { out, code } = run(tmp);
  assert(/dead-merged/.test(out), 'an un-retracted dead ask must still fire');
  assert(code === 1, `expected exit 1, got ${code}`);
});

console.log(`\n${pass + fail} assertions - ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
