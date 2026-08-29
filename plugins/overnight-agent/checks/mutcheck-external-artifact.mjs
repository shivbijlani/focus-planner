// mutcheck-external-artifact.mjs — prove external-artifact-sweep FIRES on the known-bad input it
// was built for, and stays quiet on the four ways it could cry wolf.
//
// This suite has been burned twice by detectors that read a confident, permanent 0:
//   - cross-task-dependency-sweep shipped with m[2] instead of m[1]; every id came back undefined
//     and it reported 0 forever. Caught only because a mutation check asserted it FIRES.
//   - reversible-gate-sweep filtered out every journal with no board row — which is exactly where
//     its victim lived.
// external-artifact-sweep currently reads 0 against the live corpus, which is the CORRECT answer
// (the 13:30 run repaired #228 by hand). That makes a firing proof mandatory, not optional.
//
// Method: build synthetic planner folders and run the REAL sweep as a child process against them.
// No reimplementation of the logic — the thing under test is the shipped file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SWEEP = path.join(import.meta.dirname, 'external-artifact-sweep.mjs');
const S = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';

// #310 as it actually exists: a calendar event this agent created, dated, naming Dubai Opera.
const T310 = `# Task 310: Ibrahim Maalouf concerts
${S}

**Status:** Done · 2026-07-02

**📅 Added to your Google Calendar (shiv@bijlanis.com):**
- *Ibrahim Maalouf & Hiba Tawaji — "À la Française"* — Fri 27 Nov 2026, 20:30, Dubai Opera. [event](https://www.google.com/calendar/event?eid=YjAyNmF2cTNjYjhnYzduMHM3aWd1MTZ2Zzggc2hpdkBiaWpsYW5pcy5jb20)
`;

// #228 as it stood BEFORE the 2026-08-26 repair: asking for a destination, never citing #310.
const T228_BAD = `# Task 228: Emirates nov trip
Trip to see Ibrahim Maalouf and Hiba Tawaji. Come back when parents leave ().
${S}

**Status:** blocked · 2026-06-18

**Needs from you:** confirm destination — I'll assume India via DXB unless you say otherwise.
`;

// The same task after a run has made the link. A citation is proof the two tasks now know about
// each other, which is precisely the defect being detected, so this must go quiet.
const T228_REPAIRED = T228_BAD.replace(
  "**Needs from you:** confirm destination",
  "Task #310 already put this on your calendar.\n\n**Needs from you:** confirm destination"
);

// Ambient-entity control: shares only "Microsoft", which appears all over the corpus.
const T900_AMBIENT = `# Task 900: Microsoft budget question
${S}

**Status:** blocked · 2026-06-18

**Needs from you:** which date works for the Microsoft review?
`;
const T901_AMBIENT_ART = `# Task 901: Microsoft thing
${S}

**Status:** Done · 2026-07-02

**📅 Added to your Google Calendar:**
- *Microsoft sync* — Fri 27 Nov 2026, 10:00. [event](https://www.google.com/calendar/event?eid=bXNmdHN5bmMxMjM0NTY3ODkw)
`;

// Dismissive ask: says nothing is required, so it is not asking Shiv for anything.
const T228_DISMISSIVE = T228_BAD.replace(
  "**Needs from you:** confirm destination — I'll assume India via DXB unless you say otherwise.",
  "**Needs from you:** none — the Ibrahim Maalouf destination is settled."
);

// Non-temporal, non-locative ask: a dated calendar artifact cannot answer it.
const T228_WRONGKIND = T228_BAD.replace(
  "**Needs from you:** confirm destination — I'll assume India via DXB unless you say otherwise.",
  "**Needs from you:** which seat category do you want for Ibrahim Maalouf?"
);

// Terminal status: settled work is not an open ask.
const T228_DONE = T228_BAD.replace('**Status:** blocked', '**Status:** done');

function run(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mut-'));
  const jdir = path.join(dir, 'journal');
  fs.mkdirSync(jdir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(jdir, name), body, 'utf8');
  fs.writeFileSync(path.join(dir, 'planner.md'), '| ID | Task |\n');
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [SWEEP], {
      env: { ...process.env, PLANNER_PATH: dir },
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
  {
    name: 'POSITIVE — historical #228 asking a destination #310 already answered',
    files: { 'task-228.md': T228_BAD, 'task-310.md': T310 },
    want: n => n === 1,
    expect: 'exactly 1',
  },
  {
    name: 'NEGATIVE — same pair, but #228 now cites #310 (link already made)',
    files: { 'task-228.md': T228_REPAIRED, 'task-310.md': T310 },
    want: n => n === 0,
    expect: '0',
  },
  {
    name: 'NEGATIVE — bridge entity is ambient ("Microsoft"), rarity gate must block',
    files: {
      'task-900.md': T900_AMBIENT, 'task-901.md': T901_AMBIENT_ART,
      // pad the corpus so "Microsoft" exceeds the >4-journal ambient threshold
      'task-902.md': `# Task 902: Microsoft\n${S}\n**Status:** blocked\n`,
      'task-903.md': `# Task 903: Microsoft\n${S}\n**Status:** blocked\n`,
      'task-904.md': `# Task 904: Microsoft\n${S}\n**Status:** blocked\n`,
      'task-905.md': `# Task 905: Microsoft\n${S}\n**Status:** blocked\n`,
    },
    want: n => n === 0,
    expect: '0',
  },
  {
    name: 'NEGATIVE — dismissive ask ("none") is not asking Shiv for anything',
    files: { 'task-228.md': T228_DISMISSIVE, 'task-310.md': T310 },
    want: n => n === 0,
    expect: '0',
  },
  {
    name: 'NEGATIVE — ask is neither temporal nor locative (seat category)',
    files: { 'task-228.md': T228_WRONGKIND, 'task-310.md': T310 },
    want: n => n === 0,
    expect: '0',
  },
  {
    name: 'NEGATIVE — task is terminal (done); settled work is not an open ask',
    files: { 'task-228.md': T228_DONE, 'task-310.md': T310 },
    want: n => n === 0,
    expect: '0',
  },
];

let ok = true;
for (const c of CASES) {
  const r = run(c.files);
  const pass = c.want(r.flagged);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`        flagged=${r.flagged} (want ${c.expect}), exit=${r.code}`);
  if (!pass) console.log(r.out.split('\n').map(l => '        | ' + l).join('\n'));
}

console.log(`\nRESULT: ${ok ? 'ALL GOOD — the sweep fires on the known-bad input and stays quiet on all four wolf-cry shapes' : 'DEFECT — do not trust this sweep'}`);
process.exit(ok ? 0 : 1);
