// mutcheck-reversible-gate.mjs
//
// Mutation check for reversible-gate-sweep.mjs — specifically for the ARTEFACT signal
// added 2026-08-28.
//
// WHY THIS FILE EXISTS
// --------------------
// The 2026-08-28 02:00 PT run learning recorded the defect precisely:
//
//   "`reversible-gate-sweep` exists specifically to catch this, ran this run, and
//    reported FLAGGED: 0. It was not broken. `build` is not in [its verb list]."
//   "a vocabulary-matching detector's coverage is only ever as wide as the synonyms
//    someone happened to think of — `FLAGGED: 0` from a keyword sweep is weak evidence."
//
// The fix widened the list by one word. That closes #357 and nothing else. This file
// exists to prove the SECOND signal — "does the ask authorise producing a reversible
// artefact?" — closes the class, by asserting that #357's verbatim ask is still caught
// when the verb list is mutated back to its pre-fix state.
//
// Two standing rules honoured here:
//   - 2026-08-26 04:30: "a mutation check corrupted production state." Everything runs
//     against a synthetic planner in a temp dir, with PLANNER_PATH and LOCALAPPDATA
//     redirected. The real planner and state store are never read or written.
//   - 2026-08-26 11:15: "mutation-check the GUARDS, not just the matcher." Each of the
//     four suppressors added with the artefact signal (production relation, agent
//     subject, negation, irreversible token) is deleted in turn, and a fixture that is
//     silent today must go LOUD — otherwise the guard is decoration.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = import.meta.dirname;
const SWEEP = path.join(DIR, 'reversible-gate-sweep.mjs');
const TODAY = '2026-08-28';
const OLD = '2026-08-20';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- fixtures
// Verbatim from task-357.md, the ask that the verb list could not see.
const F357 = 'one word — **`build 188`** to have me open the draft PR for the board rendering. (Optional, unrelated: the video-demo call from Q4.)';

// Verbatim shape from task-262.md — the one live victim the artefact signal finds.
const F262 = 'one word — **`leave it`** (I close this as done, part A verified, rename dropped) or **`rename it`** (I write the full cutover checklist against the 12 files above and stage it behind #263\'s name choice).';

// task-459: the production phrase is an instruction to SHIV, not an agent offer.
const F459 = 'open the doc and leave **one** comment on any line — that\'s all step 1 needs.';

// task-244: the production phrase sits inside a dismissal ("needs nothing").
const F244 = 'nothing to make the checklist usable — it\'s ready to hand to Amy today. One answer would sharpen it: **the kids\' ages**.';

// task-357 as it stands TODAY: same artefact, but the token gates the irreversible finish.
const FMERGE = 'one word — **`merge 214`** to ship the draft PR for the board rendering.';

// task-284: artefact vocabulary with no production relation at all — a decision ask.
const F284 = '**"A, filtered"** (my recommendation), **"A, forward-all"**, or **"B"**.';

// --- Guard-isolating fixtures ----------------------------------------------------
// Each of the four suppressors has to be exercised by a fixture that reaches IT and not
// merely an earlier one. The first attempt at this file used the verbatim live asks and
// three mutants stayed silent — because F244 is stopped by the agent-subject guard long
// before the negation guard sees it, and F284/FMERGE never form a production relation at
// all. A mutant that stays silent for the wrong reason proves nothing, which is the same
// "the check answered a different question" trap this suite keeps recording.
const G_NEGATED = 'nothing from you — I don\'t need to write the comparison doc until you pick a lane, and **`go`** just starts it.';
const G_IRREVERSIBLE = 'one word — **`merge 214`**, and then I write the migration doc for the rollout.';
const G_NO_RELATION = '**`A`** (use the shortlist you already have) or **`B`** (wait for Q3 numbers).';

// ---------------------------------------------------------------- sandbox
function sandbox(cases) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-rgs-'));
  const planner = path.join(root, 'planner');
  const journal = path.join(planner, 'journal');
  const state = path.join(root, 'local', 'overnight-agent', 'state');
  fs.mkdirSync(journal, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  const rows = ['## Today', '', '| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '| --- | --- | --- | --- | --- | --- |'];
  for (const c of cases) rows.push(`| ${c.id} | 🟡 | Case ${c.id} | - |  |  |`);
  fs.writeFileSync(path.join(planner, 'planner.md'), rows.join('\n'), 'utf8');

  for (const c of cases) {
    const j = [
      `# Task ${c.id}: Case ${c.id}`,
      '',
      '---',
      '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
      '',
      '## 🌙 Overnight Agent',
      '',
      '<!-- from: overnight-agent -->',
      `**Status:** In progress · ${c.date || OLD}`,
      '',
      `**Needs from you:** ${c.ask}`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(journal, `task-${c.id}.md`), j, 'utf8');
    fs.writeFileSync(path.join(state, `task-${c.id}.json`), JSON.stringify({ status: c.status || 'in-progress' }), 'utf8');
  }
  return { root, planner, local: path.join(root, 'local') };
}

// Run a (possibly mutated) copy of the sweep. The mutant is written INTO the sweep's own
// directory so its relative `./lib-live-ask.mjs` import still resolves, and removed after.
let mutSeq = 0;
function run(cases, mutate) {
  const s = sandbox(cases);
  let script = SWEEP;
  let mutPath = null;
  if (mutate) {
    const src = fs.readFileSync(SWEEP, 'utf8');
    const out = mutate(src);
    if (out === src) throw new Error('mutation was a no-op — the anchor text moved');
    mutPath = path.join(DIR, `_mut-rgs-${process.pid}-${mutSeq++}.mjs`);
    fs.writeFileSync(mutPath, out, 'utf8');
    script = mutPath;
  }
  let out = '';
  try {
    out = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, PLANNER_PATH: s.planner, LOCALAPPDATA: s.local, OA_TODAY: TODAY },
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  fs.rmSync(s.root, { recursive: true, force: true });
  if (mutPath) fs.rmSync(mutPath, { force: true });
  const m = out.match(/FLAGGED[^:]*:\s*(\d+)/);
  return { out, flagged: m ? Number(m[1]) : -1 };
}

// Does the report for #id carry an `artefact:` reason?
function artefactFired(out, id) {
  const lines = out.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`#${id}`));
  if (i === -1) return false;
  return (lines[i + 1] || '').includes('artefact:');
}

// ================================================================ 1. true positives
{
  const r = run([{ id: '901', ask: F357 }]);
  check('TP #357: `build 188` -> "open the draft PR" is flagged', r.flagged === 1, `flagged=${r.flagged}`);
  check('TP #357: flagged BY the artefact signal', artefactFired(r.out, '901'), r.out.slice(0, 300));
}
{
  const r = run([{ id: '902', ask: F262 }]);
  check('TP #262: `rename it` -> "I write the full cutover checklist"', r.flagged === 1, `flagged=${r.flagged}`);
  check('TP #262: flagged BY the artefact signal', artefactFired(r.out, '902'));
}
{
  const r = run([{ id: '903', ask: 'Reply `go` and I will put up a draft PR for the importer.' }]);
  check('TP: "put up a draft PR" — a production verb outside the old list', r.flagged === 1, `flagged=${r.flagged}`);
}

// ============================================== 2. THE POINT: verb list is not load-bearing
// Revert the verb list to its pre-2026-08-28 state (drop build/implement/code up) and the
// #357 ask must STILL be caught. This is the assertion the 02:00 learning asked for: the
// class is closed by the artefact relation, not by remembering another synonym.
const DROP_BUILD_VERBS = (s) => s.replace('(build|implement|code\\s+up|draft|', '(draft|');
{
  const r = run([{ id: '904', ask: F357 }], DROP_BUILD_VERBS);
  check('CLASS: #357 still caught with `build` REMOVED from the verb list', r.flagged === 1, `flagged=${r.flagged}`);
  check('CLASS: and it is the artefact signal that catches it', artefactFired(r.out, '904'), r.out.slice(0, 300));
}
{
  // Control: with BOTH signals disabled the same fixture must go quiet — otherwise the
  // assertion above proves nothing (it could have been matching on something incidental).
  const r = run([{ id: '905', ask: F357 }], (s) => DROP_BUILD_VERBS(s)
    .replace('const art = offersToProduce(scope);', 'const art = null;'));
  check('CLASS control: verb list reverted AND artefact disabled -> silent', r.flagged === 0, `flagged=${r.flagged}`);
}

// ================================================================ 3. guards must suppress
const NEGATIVES = [
  ['#459 — Shiv is the subject of "open the doc"', '911', F459],
  ['#244 — production phrase inside a dismissal', '912', F244],
  ['#357 today — irreversible token gates an existing PR', '913', FMERGE],
  ['#284 — artefact vocabulary, no production relation', '914', F284],
  ['negated: "I don\'t need to write the comparison doc"', '916', G_NEGATED],
  ['mixed: `merge 214` then "I write the migration doc"', '917', G_IRREVERSIBLE],
  ['no relation: "use the shortlist you already have"', '918', G_NO_RELATION],
];
for (const [name, id, ask] of NEGATIVES) {
  const r = run([{ id, ask }]);
  check(`negative: ${name}`, !artefactFired(r.out, id), r.out.slice(0, 300));
}

// ============================================ 4. each guard is individually load-bearing
// Delete one guard at a time; the fixture it protects must go LOUD.
const GUARD_MUTANTS = [
  [
    'agent-subject guard',
    '911', F459,
    (s) => s.replace('if (!AGENT_SUBJECT.test(back)) continue;', 'if (false) continue;'),
  ],
  [
    'negation guard',
    '916', G_NEGATED,
    (s) => s.replace('if (NEGATED.test(back)) continue;', 'if (false) continue;'),
  ],
  [
    'irreversible-token suppression',
    '917', G_IRREVERSIBLE,
    (s) => s.replace('&& !IRREVERSIBLE.test(scope)', ''),
  ],
  [
    'production-relation requirement',
    '918', G_NO_RELATION,
    (s) => s.replace(
      'const art = offersToProduce(scope);',
      'const art = (scope.match(new RegExp(ARTEFACT, "i")) || [null])[0];',
    ),
  ],
];
for (const [name, id, ask, mutate] of GUARD_MUTANTS) {
  const r = run([{ id, ask }], mutate);
  check(`guard load-bearing: ${name} (removing it makes #${id} flag)`, artefactFired(r.out, id), `flagged=${r.flagged} :: ${r.out.slice(0, 260)}`);
}
{
  // The command-token requirement: without a token, an artefact offer alone must not fire
  // the artefact signal (the verb path may still catch it, which is fine and separate).
  const noToken = 'I can open a draft PR whenever the data half settles.';
  const r = run([{ id: '915', ask: noToken }]);
  check('guard: no command token -> artefact signal silent', !artefactFired(r.out, '915'), r.out.slice(0, 260));
  const r2 = run([{ id: '915', ask: noToken }], (s) => s.replace('if (tokens.length && art', 'if (art'));
  check('guard load-bearing: token requirement (removing it makes #915 flag)', artefactFired(r2.out, '915'), r2.out.slice(0, 260));
}

// ================================================================ 5. lifecycle guards
{
  const done = run([{ id: '921', ask: F357, status: 'done' }]);
  check('lifecycle: terminal (done) suppressed', done.flagged === 0, `flagged=${done.flagged}`);
  const skip = run([{ id: '922', ask: F357, status: 'skip' }]);
  check('lifecycle: terminal (skip) suppressed', skip.flagged === 0, `flagged=${skip.flagged}`);
  const today = run([{ id: '923', ask: F357, date: TODAY }]);
  check('lifecycle: written today suppressed', today.flagged === 0, `flagged=${today.flagged}`);
}
{
  // Off-board tasks are not the agent's queue.
  const s = sandbox([{ id: '924', ask: F357 }]);
  fs.writeFileSync(path.join(s.planner, 'planner.md'), '## Today\n\n| ID | 🎯 | Task |\n| --- | --- | --- |\n', 'utf8');
  let out = '';
  try {
    out = execFileSync(process.execPath, [SWEEP], {
      encoding: 'utf8',
      env: { ...process.env, PLANNER_PATH: s.planner, LOCALAPPDATA: s.local, OA_TODAY: TODAY },
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  fs.rmSync(s.root, { recursive: true, force: true });
  check('lifecycle: off-board task suppressed', /FLAGGED[^:]*:\s*0/.test(out), out.slice(0, 200));
}

// ================================================================ 6. provenance labelling
// The report must say WHICH signal fired. Without that, a future run cannot tell whether
// the verb list still earns its keep — which is the whole complaint the 02:00 learning made.
{
  const r = run([{ id: '931', ask: 'Say the word and I will scaffold the module.' }]);
  check('provenance: verb hits are labelled verb:', /offer:\s*verb:/.test(r.out), r.out.slice(0, 260));
  const r2 = run([{ id: '932', ask: F357 }]);
  check('provenance: artefact hits are labelled artefact:', /offer:.*artefact:/.test(r2.out), r2.out.slice(0, 260));
}

// ================================================================ 7. no stray mutants
{
  const strays = fs.readdirSync(DIR).filter((f) => f.startsWith('_mut-rgs-'));
  check('hygiene: no mutant files left behind', strays.length === 0, strays.join(', '));
}

console.log(`mutcheck-reversible-gate: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail ? 1 : 0);
