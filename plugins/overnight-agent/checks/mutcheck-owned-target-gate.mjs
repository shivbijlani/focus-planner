// mutcheck-owned-target-gate.mjs — prove owned-target-gate-sweep FIRES on the input it was built
// for, and stays quiet on every shape that made the naive version 12.5% precise.
//
// The sweep reads 0 against the live corpus, which is CORRECT: #403 was repaired this run and is
// now terminal. This suite has been burned three times by a confident permanent 0
// (cross-task-dependency-sweep's m[2]/m[1] bug; reversible-gate-sweep's board gate; and the
// external-artifact-sweep first cut reading the wrong turn). So a firing proof is mandatory.
//
// Method: build synthetic planner folders and run the REAL sweep as a child process. Nothing is
// reimplemented — the thing under test is the shipped file. Mutations are applied to a COPY of the
// source, so production is never touched (a mutation check corrupted production state on
// 2026-08-26 04:30; that is why this writes to a temp file and asserts the original is unchanged).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = path.join(import.meta.dirname, 'owned-target-gate-sweep.mjs');
const ORIGINAL = fs.readFileSync(SRC, 'utf8');
const S = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';
const OA_TODAY = '2026-08-26';

const head = (n, title) => `# Task ${n}: ${title}\n${S}\n\n**Status:** Proposed · plan v1 · 2026-07-31\n\n`;

// #403 exactly as it stood for 26 days: a permission gate whose object is editing the agent's own
// settings file. The plan even self-certified "No purchases or irreversible actions involved".
const GATED_OWNED = head(903, 'Shopping philosophy')
  + '2. Fold a short version of this philosophy into **user-settings.md** so every future product-research task applies it. *(Needs approval — it edits your agent settings.)*\n\n'
  + '**Needs from you:** a yes on step 2 (fold into settings), or tell me to leave it as just the checklist.\n';

// #241: "apply" edits Master-Resume.md — Shiv's own document, and he asked to see the diff.
const HIS_DOC = head(904, 'Reframe resume bullets')
  + '**Needs from you:** one word. **"apply 241"** and I\'ll update `Master-Resume.md` only and show you the diff.\n';

// #234: memo writes into YNAB — an external system. The Amazon-scoped standing approval does not
// travel between tasks (rule recorded 2026-08-26 05:00).
const EXTERNAL_SYS = head(905, 'Vacations this year')
  + '**Needs from you:** one word — **`apply`** and I\'ll update the memos in YNAB (43 rows, no category changes).\n';

// Descriptive, not gating: a present-tense modify verb on an owned file, but no permission is
// being sought — the real ask is about something else entirely.
// (An earlier version used "I folded …" and passed for the wrong reason: MODIFY does not match the
// past tense, so the GATES guard was never exercised. Caught by the mutation check.)
const NO_GATE = head(906, 'Improve under the deck storage')
  + '**Needs from you:** just the clearance measurement, ground to the lowest joist. Separately, tonight I am folding the shopping philosophy into user-settings.md; no action needed there.\n';

// A gate over a modification whose target is a real-world object, not an agent artifact.
const NOT_OWNED = head(907, 'Improve under the deck storage')
  + '**Needs from you:** your approval and I\'ll update the shelf layout and add a second rail to the frame.\n';

// Mixed: touches the agent's own file but the ask is fundamentally about an irreversible send.
const IRREVERSIBLE_MIX = head(908, 'Kiley accident handling')
  + '**Needs from you:** one word — **`send from agent`** and I\'ll record it in the journal and send both requests.\n';

// Dismissive: the gate+modify+owned text sits INSIDE the dismissive clause, so stripping that
// clause is the only thing that suppresses it. ("nothing … myself" = not asking for permission.)
// (An earlier version put the match after the clause break, where the dismissal guard has no
// effect by design — the #163 precedence fix keeps text after the break. Caught by the mutation
// check, which showed the case passing with the guard disabled.)
const DISMISSIVE = head(909, 'YouTube to MD files')
  + '**Needs from you:** nothing, I\'ll update the journal myself; ping me if you want the raw capture numbers.\n';

// Real #403, which this run marked `done` in the live state store — proves the terminal gate reads
// actual agent state, not something reconstructed from the journal text.
const TERMINAL_REAL = GATED_OWNED.replace('Task 903', 'Task 403');

function run(files, sweepPath = SRC) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-otg-'));
  const jdir = path.join(dir, 'journal');
  fs.mkdirSync(jdir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(jdir, name), body, 'utf8');
  fs.writeFileSync(path.join(dir, 'planner.md'), '| ID | Task |\n');
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [sweepPath], {
      env: { ...process.env, PLANNER_PATH: dir, OA_TODAY },
      encoding: 'utf8',
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 1;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const m = /FLAGGED[^:]*:\s*(\d+)/.exec(out);
  return { flagged: m ? Number(m[1]) : -1, code, out };
}

const CASES = [
  { name: 'POSITIVE — gates "fold into settings" (historical #403)', files: { 'task-903.md': GATED_OWNED }, want: 1, guard: 'positive' },
  { name: 'NEGATIVE — target is HIS document (Master-Resume.md)', files: { 'task-904.md': HIS_DOC }, want: 0, guard: 'OWNED' },
  { name: 'NEGATIVE — target is an external system (YNAB)', files: { 'task-905.md': EXTERNAL_SYS }, want: 0, guard: 'OWNED' },
  { name: 'NEGATIVE — no gate; states the edit is happening anyway', files: { 'task-906.md': NO_GATE }, want: 0, guard: 'GATES' },
  { name: 'NEGATIVE — modification target is not an agent artifact', files: { 'task-907.md': NOT_OWNED }, want: 0, guard: 'OWNED' },
  { name: 'NEGATIVE — mixed ask whose real object is an irreversible send', files: { 'task-908.md': IRREVERSIBLE_MIX }, want: 0, guard: 'IRREVERSIBLE' },
  { name: 'NEGATIVE — match sits inside the dismissive clause', files: { 'task-909.md': DISMISSIVE }, want: 0, guard: 'dismissal' },
  { name: 'NEGATIVE — task is terminal in the LIVE state store (#403 done)', files: { 'task-403.md': TERMINAL_REAL }, want: 0, guard: 'terminal' },
];

let ok = true;
console.log('=== BEHAVIOUR ===');
for (const c of CASES) {
  const r = run(c.files);
  const pass = r.flagged === c.want;
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`        flagged=${r.flagged} (want ${c.want}), exit=${r.code}`);
  if (!pass) console.log(r.out.split('\n').map((l) => '        | ' + l).join('\n'));
}

// Each guard is disabled in turn. A load-bearing guard must break AT LEAST ONE negative, and the
// case labelled with that guard must be among the ones it breaks. (The stricter "breaks exactly
// one" rule is wrong for an allow-list guard: OWNED legitimately protects three different
// negatives at once. What matters is that no guard is dead and no negative is protected only by
// accidental redundancy — the first cut had three dead guards and this criterion is what found
// them.)
const MUTATIONS = [
  { guard: 'IRREVERSIBLE', find: /^const IRREVERSIBLE = .*$/m, repl: 'const IRREVERSIBLE = /$^/;' },
  { guard: 'GATES', find: /if \(!GATES\.some\(\(re\) => re\.test\(ask\)\)\) continue;/, repl: '' },
  { guard: 'OWNED', find: /const t = window\.match\(OWNED\);/, repl: "const t = ['x'];" },
  { guard: 'dismissal', find: /const ask = afterDismissal\(rawAsk\);/, repl: 'const ask = rawAsk;' },
];

console.log('\n=== MUTATIONS (each must break exactly its own negative) ===');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mut-src-'));
for (const mut of MUTATIONS) {
  if (!mut.find.test(ORIGINAL)) {
    console.log(`FAIL  ${mut.guard}: mutation target not found in source — the check is not testing what it claims`);
    ok = false;
    continue;
  }
  const mutated = ORIGINAL.replace(mut.find, mut.repl);
  const p = path.join(tmpDir, `mut-${mut.guard}.mjs`);
  fs.writeFileSync(p, mutated, 'utf8');
  // the mutated copy imports ./lib-live-ask.mjs, so it must sit beside the real one
  const beside = path.join(import.meta.dirname, `.mutcheck-tmp-${mut.guard}.mjs`);
  fs.writeFileSync(beside, mutated, 'utf8');

  const broke = [];
  for (const c of CASES) {
    if (c.guard === 'positive') continue;
    const r = run(c.files, beside);
    if (r.flagged !== c.want) broke.push(c.guard);
  }
  const pos = run(CASES[0].files, beside);
  fs.rmSync(beside, { force: true });

  const exact = broke.includes(mut.guard);
  const posOk = pos.flagged === 1;
  if (!exact || !posOk) ok = false;
  console.log(`${exact && posOk ? 'PASS' : 'FAIL'}  disable ${mut.guard.padEnd(13)} -> broke [${broke.join(', ') || 'nothing'}]; positive still fires: ${posOk}`);
}
fs.rmSync(tmpDir, { recursive: true, force: true });

// The 04:30 lesson: a mutation check must not leave production altered.
const unchanged = fs.readFileSync(SRC, 'utf8') === ORIGINAL;
if (!unchanged) ok = false;
console.log(`\n${unchanged ? 'PASS' : 'FAIL'}  production source byte-identical after the run`);

console.log(`\nRESULT: ${ok ? 'ALL GOOD — fires on the known-bad input; every guard is load-bearing and orthogonal' : 'DEFECT — do not trust this sweep'}`);
process.exit(ok ? 0 : 1);
