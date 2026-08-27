// mutcheck-deliverable-gate.mjs
//
// Mutation check for deliverable-gate-sweep.mjs.
//
// Two rules this file exists to honour, both learned the hard way:
//   - 2026-08-26 04:30: "a mutation check corrupted production state." So this builds a
//     fully SYNTHETIC planner in a temp dir and points PLANNER_PATH *and* LOCALAPPDATA at
//     it. It never reads or writes the real planner or the real state store.
//   - 2026-08-26 11:15: "mutation-check the GUARDS, not just the matcher." So as well as
//     asserting true positives are caught, it asserts each SUPPRESSOR is load-bearing:
//     an irreversible-only gate, a doc-guard line, a verb with no approval conditional,
//     a terminal task, and a turn written today must each stay silent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SWEEP = path.join(import.meta.dirname, 'deliverable-gate-sweep.mjs');
const TODAY = '2026-08-26';
const OLD = '2026-06-01';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// Build a throwaway planner. `cases` = [{ id, status, deliverable, date, live }].
function sandbox(cases) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dgs-'));
  const planner = path.join(root, 'planner');
  const journal = path.join(planner, 'journal');
  const state = path.join(root, 'local', 'overnight-agent', 'state');
  fs.mkdirSync(journal, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  const rows = ['## Today', '', '| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '| --- | --- | --- | --- | --- | --- |'];
  for (const c of cases) rows.push(`| ${c.id} | 🟡 | Case ${c.id} | - |  |  |`);
  fs.writeFileSync(path.join(planner, 'planner.md'), rows.join('\n'), 'utf8');

  for (const c of cases) {
    const date = c.date || OLD;
    // A minimal journal with a live ask in the newest agent turn. `live` injects extra
    // prose into the agent block so the fulfilment guard can be exercised.
    const j = [
      `# Task ${c.id}: Case ${c.id}`,
      '',
      '---',
      '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
      '',
      '## 🌙 Overnight Agent',
      '',
      `**Status:** Proposed · plan v1 · ${date}`,
      '',
      '<!-- from: overnight-agent -->',
      `**Status:** ${date}`,
      '',
      ...(c.live ? [c.live, ''] : []),
      '**Needs from you:** a decision on the shape.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(journal, `task-${c.id}.md`), j, 'utf8');
    if (c.deliverable != null) {
      fs.writeFileSync(path.join(journal, `task-${c.id}-doc.md`), c.deliverable, 'utf8');
    }
    fs.writeFileSync(path.join(state, `task-${c.id}.json`), JSON.stringify({ status: c.status || 'proposed' }), 'utf8');
  }
  return { root, planner, local: path.join(root, 'local') };
}

function run(cases) {
  const s = sandbox(cases);
  let out = '';
  try {
    out = execFileSync(process.execPath, [SWEEP], {
      encoding: 'utf8',
      env: { ...process.env, PLANNER_PATH: s.planner, LOCALAPPDATA: s.local, OA_TODAY: TODAY },
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  fs.rmSync(s.root, { recursive: true, force: true });
  const m = out.match(/FLAGGED[^:]*:\s*(\d+)/);
  return { out, flagged: m ? Number(m[1]) : -1 };
}

// ---------------------------------------------------------------- true positives
const POSITIVES = [
  ['draft-PR, conditional first', 'On your approval I can open a **draft PR** on the repo as the reversible first step.'],
  ['draft-PR, conditional last', 'I can open a draft PR for the read-only section once you approve.'],
  ['say the word', 'Say the word and I will scaffold the module for you.'],
  ['pending sign-off', 'Pending your sign-off I will write up the comparison doc.'],
  ['upon approval + research', 'Upon approval I can research the three vendors and shortlist them.'],
  ['with your ok + prototype', 'With your ok I will prototype the picker.'],
];
for (const [name, line] of POSITIVES) {
  const r = run([{ id: '901', deliverable: `# Doc\n\n${line}\n` }]);
  check(`positive: ${name}`, r.flagged === 1, `flagged=${r.flagged}`);
}

// ---------------------------------------------------------------- guards must suppress
const NEGATIVES = [
  ['irreversible only — merge', 'On your approval I will merge the PR into main.'],
  ['irreversible only — send', 'Once you approve I will send the email to the vendor.'],
  ['irreversible only — buy', 'Say the word and I will buy the replacement.'],
  ['no conditional', 'I drafted the concept doc and can outline the next slice whenever.'],
  ['past tense', 'On your approval last week I opened the draft PR, which is now merged.'],
  ['doc-guard: names the sweep', 'The deliverable-gate sweep exists because "On your approval I can open a draft PR" is a defect.'],
  ['doc-guard: quotes the list', 'Per the reversible list, on your approval I can open a draft PR — which was already allowed.'],
];
for (const [name, line] of NEGATIVES) {
  const r = run([{ id: '902', deliverable: `# Doc\n\n${line}\n` }]);
  check(`negative: ${name}`, r.flagged === 0, `flagged=${r.flagged}`);
}

// past tense deserves a note: "opened" is not in REV as a bare verb, so it is suppressed by
// the verb list rather than by tense detection. Assert that explicitly so a future widening
// of REV cannot silently break it.
{
  const r = run([{ id: '903', deliverable: '# Doc\n\nOn your approval I opened the draft PR yesterday.\n' }]);
  check('negative: past-tense "opened" stays quiet', r.flagged === 0, `flagged=${r.flagged}`);
}

// ---------------------------------------------------------------- lifecycle guards
{
  const gate = '# Doc\n\nOn your approval I can open a draft PR.\n';
  const done = run([{ id: '904', status: 'done', deliverable: gate }]);
  check('guard: terminal (done) suppressed', done.flagged === 0, `flagged=${done.flagged}`);

  const skip = run([{ id: '905', status: 'skip', deliverable: gate }]);
  check('guard: terminal (skip) suppressed', skip.flagged === 0, `flagged=${skip.flagged}`);

  const today = run([{ id: '906', deliverable: gate, date: TODAY }]);
  check('guard: written today suppressed', today.flagged === 0, `flagged=${today.flagged}`);

  const noDeliverable = run([{ id: '907', deliverable: null }]);
  check('guard: no deliverable file → not considered', noDeliverable.flagged === 0, `flagged=${noDeliverable.flagged}`);
}

// A task NOT on the board must be ignored even with a gate.
{
  const s = sandbox([{ id: '908', deliverable: '# Doc\n\nOn your approval I can open a draft PR.\n' }]);
  fs.writeFileSync(path.join(s.planner, 'planner.md'), '## Today\n\n| ID | 🎯 | Task |\n| --- | --- | --- |\n', 'utf8');
  let out = '';
  try {
    out = execFileSync(process.execPath, [SWEEP], {
      encoding: 'utf8',
      env: { ...process.env, PLANNER_PATH: s.planner, LOCALAPPDATA: s.local, OA_TODAY: TODAY },
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  fs.rmSync(s.root, { recursive: true, force: true });
  const m = out.match(/FLAGGED[^:]*:\s*(\d+)/);
  check('guard: off-board task suppressed', Number(m?.[1]) === 0, `flagged=${m?.[1]}`);
}

// ---------------------------------------------------------------- mixed asks ARE reported
{
  const r = run([{ id: '909', deliverable: '# Doc\n\nOn your approval I can draft the email and then send it.\n' }]);
  check('mixed: reversible + irreversible still flagged', r.flagged === 1, `flagged=${r.flagged}`);
  check('mixed: labelled MIXED', /MIXED/.test(r.out));
}

// ---------------------------------------------------------------- multiple victims counted
{
  const r = run([
    { id: '910', deliverable: '# Doc\n\nOn your approval I can open a draft PR.\n' },
    { id: '911', deliverable: '# Doc\n\nSay the word and I will scaffold it.\n' },
    { id: '912', deliverable: '# Doc\n\nOn your approval I will merge it.\n' },
  ]);
  check('multi: exactly the two reversible victims', r.flagged === 2, `flagged=${r.flagged}`);
}

// ---------------------------------------------------------------- exit code contract
{
  const clean = run([{ id: '913', deliverable: '# Doc\n\nNothing to see here.\n' }]);
  check('clean run reports 0', clean.flagged === 0, `flagged=${clean.flagged}`);
}

// ================================================================================
// REGRESSION: the two false positives of 2026-08-27. Both are reproduced from the
// real text that fooled the sweep, and each is paired with a control proving the new
// guard is load-bearing rather than the fixture simply being inert.
// ================================================================================

// ---- FP 1 (#357): a postmortem QUOTING the retired gate, wrapped across lines. -----
// The gate matches on line 1; every doc-guard token sits on lines 2-4. Line-scoped
// guarding flagged the sentence that documents this sweep's own founding case.
const POSTMORTEM = [
  '# Doc',
  '',
  '*The previous version of this line said "On your approval I can open a **draft PR** … as the reversible',
  'first step." That sentence is why this task sat for 52 days: a draft PR is the headline item on',
  "SKILL.md's own list of things that need no approval, so the work should simply have been done and",
  'linked. Recorded as the founding case of `deliverable-gate-sweep`.*',
  '',
].join('\n');
{
  const r = run([{ id: '920', deliverable: POSTMORTEM }]);
  check('FP1: wrapped postmortem quoting a retired gate is suppressed', r.flagged === 0, `flagged=${r.flagged}`);
}
{
  // CONTROL: identical gate sentence, same wrapping, but WITHOUT the documentation
  // markers. Must still flag — otherwise the fix suppressed the whole shape.
  const bare = [
    '# Doc',
    '',
    'On your approval I can open a **draft PR** … as the reversible',
    'first step for the read-only section, once the data half is settled.',
    '',
  ].join('\n');
  const r = run([{ id: '921', deliverable: bare }]);
  check('FP1 control: same wrapped gate WITHOUT doc markers still flags', r.flagged === 1, `flagged=${r.flagged}`);
}
{
  // CONTROL: a doc marker must not launder a genuinely live gate in a DIFFERENT
  // paragraph of the same file.
  const mixedFile = [
    '# Doc',
    '',
    'Background: `deliverable-gate-sweep` exists to catch approval gates in deliverables.',
    '',
    'On your approval I can scaffold the importer as the first step.',
    '',
  ].join('\n');
  const r = run([{ id: '922', deliverable: mixedFile }]);
  check('FP1 control: doc paragraph does not launder a live gate elsewhere in the file', r.flagged === 1, `flagged=${r.flagged}`);
}

// ---- FP 2 (#253): a gate that was SATISFIED, evidence in the journal not the file. --
// The June offer text stays verbatim in the tracker forever; the packet was written in
// August and the live block says so.
const SATISFIED_GATE = "# Doc\n\nSay the word and I'll **draft one tailored application** to your pick — review-only, nothing submitted.\n";
{
  const r = run([{ id: '930', deliverable: SATISFIED_GATE, live: '**Status:** in-progress · **application packet drafted (both roles)**' }]);
  check('FP2: gate whose offer the live journal reports as drafted is suppressed', r.flagged === 0, `flagged=${r.flagged}`);
  check('FP2: the suppression is REPORTED, not silent', /suppressed — offer already fulfilled/.test(r.out), r.out.slice(0, 200));
}
{
  // CONTROL: same deliverable, live block silent about drafting. Must flag — proving the
  // suppression keys on the delivery evidence and not on the gate text.
  const r = run([{ id: '931', deliverable: SATISFIED_GATE }]);
  check('FP2 control: same gate with NO delivery evidence still flags', r.flagged === 1, `flagged=${r.flagged}`);
}
{
  // CONTROL: the delivery must be of the SAME verb family. "Built the tracker" does not
  // discharge an offer to *draft an application*.
  const r = run([{ id: '932', deliverable: SATISFIED_GATE, live: '**Status:** built the tracker and researched the shortlist.' }]);
  check('FP2 control: an unrelated verb does not discharge the offer', r.flagged === 1, `flagged=${r.flagged}`);
}
{
  // CONTROL: the draft-PR family resolves through a PR link, which is how a run log
  // actually records it.
  const prGate = '# Doc\n\nOn your approval I can open a draft PR for the renderer.\n';
  const withPr = run([{ id: '933', deliverable: prGate, live: 'Opened https://github.com/shivbijlani/focus-planner/pull/188 for the renderer.' }]);
  check('FP2: draft-PR offer discharged by a real PR link', withPr.flagged === 0, `flagged=${withPr.flagged}`);
  const withoutPr = run([{ id: '934', deliverable: prGate }]);
  check('FP2 control: same PR offer with no PR still flags', withoutPr.flagged === 1, `flagged=${withoutPr.flagged}`);
}
{
  // CONTROL: fulfilment evidence must live BELOW the sentinel (the live block). Text in
  // the user's own notes above it must not discharge an agent offer.
  const s = sandbox([{ id: '935', deliverable: SATISFIED_GATE }]);
  const jf = path.join(s.planner, 'journal', 'task-935.md');
  const j = fs.readFileSync(jf, 'utf8').replace('# Task 935: Case 935', '# Task 935: Case 935\n\nI already drafted something myself ages ago.');
  fs.writeFileSync(jf, j, 'utf8');
  let out = '';
  try {
    out = execFileSync(process.execPath, [SWEEP], {
      encoding: 'utf8',
      env: { ...process.env, PLANNER_PATH: s.planner, LOCALAPPDATA: s.local, OA_TODAY: TODAY },
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  fs.rmSync(s.root, { recursive: true, force: true });
  const m = out.match(/FLAGGED[^:]*:\s*(\d+)/);
  check('FP2 control: delivery claim ABOVE the sentinel does not discharge the gate', Number(m?.[1]) === 1, `flagged=${m?.[1]}`);
}

console.log(`mutcheck-deliverable-gate: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail ? 1 : 0);
