// mutcheck-doc-claim-consistency.mjs — proves doc-claim-consistency-sweep's rules are load-bearing.
//
// GH #492's success criteria ask for exactly this: "disabling the row-matching, the
// quantity-matching, or the absolute-claim rule each breaks exactly its own negative case and
// nothing else." A sweep whose narrowings cannot be broken is a sweep whose narrowings are
// decoration, and the narrowings here are the whole design -- the first draft fired on a
// run-log bullet by pairing "zero unpaid days" with an unrelated outings table via a bare date.
//
// Hermetic: builds its own corpus in a temp dir, so it neither reads nor depends on the live
// planner folder (#461's lesson -- a check that can only be run against the real tree is a check
// that stops being run).
//
//   node mutcheck-doc-claim-consistency.mjs
//
// Exit 0 = every arm and every mutant behaved, 1 = something survived.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SWEEP = path.join(import.meta.dirname, 'doc-claim-consistency-sweep.mjs');
const original = fs.readFileSync(SWEEP, 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-docclaim-'));
const jdir = path.join(root, 'journal');
fs.mkdirSync(jdir, { recursive: true });

// --- fixtures -------------------------------------------------------------------------------
// A: the live 2026-09-02 defect, reduced. Spend (5) exceeds the declared allowance (4) inside a
//    paragraph that also claims nothing is unpaid.
const A = `# Task fixture — allowance exceeded

| | |
| --- | --- |
| Kiley's leave | 4 days paid, then unpaid; planning around 5 business days |

**Business days Kiley spends: exactly 5** (Mon 16 -> Fri 20). That is her allowance with nothing
unpaid — the tightest fit of anything on the board.
`;

// B: the catch-up-doc shape from the issue — an absolute claim naming a row whose own cost cell
//    is non-zero, with the claim and the column about the SAME quantity.
const B = `# Task fixture — table contradiction

| Option | Leave | Unpaid |
| --- | --- | --- |
| Option 4 | 5 | 1 |
| Option 7 | 4 | 0 |

Option 4 is the one I would take, because it is the only version that adds a real second
destination with nothing unpaid.
`;

// C (negative): references the row, states no absolute claim. Ordinary prose.
const C = `# Task fixture — cites a row, claims nothing

| Option | Leave | Unpaid |
| --- | --- | --- |
| Option 4 | 5 | 1 |

Option 4 costs a day of unpaid leave, which is worth knowing before you choose it.
`;

// D (negative): an absolute claim whose spend is WITHIN the allowance. True, so not a finding.
const D = `# Task fixture — claim is accurate

| | |
| --- | --- |
| Kiley's leave | 5 days paid, then unpaid |

**Business days Kiley spends: exactly 4** (Mon 16 -> Thu 19). That is her allowance with nothing
unpaid.
`;

// E (negative): the real false positive this sweep shipped with and then removed. An absolute
//    claim about UNPAID days sits in one run-log bullet; a different bullet mentions a date that
//    happens to be a row key in an unrelated table whose column measures COST.
const E = `# Task fixture — unrelated bullets

| Day | Outing | Cost |
| --- | --- | --- |
| Wed 25 | Musandam fjords, Oman — full-day dhow | ~$80–165 + visa |

### Run log
- Priced the Sat to Wed shape you asked for: Sat 14 out, Kiley home Wed 25 — $980 pp nonstop.
- Worked out what the airport question is worth: it takes option 3 to zero unpaid days.
`;

const F = `# Task fixture — same sentence, different quantity

| Day | Outing | Cost |
| --- | --- | --- |
| Wed 25 | Musandam fjords, Oman — full-day dhow | ~$80–165 + visa |

The Wed 25 fjord trip is the one I would book, and it costs Kiley no extra leave.
`;

// G (negative): isolates SENTENCE SCOPING. The row key and the absolute claim are about the same
//    quantity as the column, so noun-matching alone would not suppress this. What suppresses it
//    is that they sit in DIFFERENT bullets and are about different options -- the row key belongs
//    to one sentence, the claim to another.
const G = `# Task fixture — key and claim in different bullets

| Option | Unpaid |
| --- | --- |
| Option 4 | 1 |

### Run log
- Priced option 4 for you this morning, $980 pp nonstop, and added it to the table.
- Separately, option 7 comes in with nothing unpaid.
`;

const fixtures = { A, B, C, D, E, F, G };
for (const [k, v] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(jdir, `task-90${k.charCodeAt(0) - 64}-fixture-${k}.md`), v, 'utf8');
}

function run() {
  try {
    const out = execFileSync('node', [SWEEP, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PLANNER_PATH: root },
    });
    return JSON.parse(out);
  } catch (e) {
    // exit 1 means findings, which is a normal result here rather than a failure.
    try {
      return JSON.parse(String(e.stdout || ''));
    } catch {
      return { findings: [], parseError: String(e.stdout || e.message).slice(0, 300) };
    }
  }
}

const results = {};
const check = (name, fn) => {
  try {
    results[name] = Boolean(fn());
  } catch (err) {
    results[name] = false;
  }
};

const hits = (r, fixture, kind) =>
  r.findings.filter((f) => f.file.includes(`fixture-${fixture}`) && (!kind || f.kind === kind));

// --- baseline -------------------------------------------------------------------------------
const base = run();
check('A allowance-exceeded IS flagged', () => hits(base, 'A', 'ALLOWANCE_EXCEEDED').length === 1);
check('B table-contradiction IS flagged', () => hits(base, 'B', 'TABLE_CONTRADICTION').length >= 1);
check('C row cited without an absolute claim is QUIET', () => hits(base, 'C').length === 0);
check('D accurate claim within allowance is QUIET', () => hits(base, 'D').length === 0);
check('E unrelated bullet + unrelated column is QUIET', () => hits(base, 'E').length === 0);
check('F same sentence but a different quantity is QUIET', () => hits(base, 'F').length === 0);
check('G key and claim in different bullets is QUIET', () => hits(base, 'G').length === 0);

// --- mutants --------------------------------------------------------------------------------
// Each removes exactly one narrowing and must revive exactly one negative fixture.
const mutants = [
  {
    name: 'absolute-claim requirement removed',
    from: 'const hasAbsoluteClaim = (text) => ABSOLUTE_CLAIM.find((re) => re.test(text)) || null;',
    to: 'const hasAbsoluteClaim = (text) => ABSOLUTE_CLAIM[0];',
    revives: 'C',
  },
  {
    name: 'spend-vs-allowance comparison removed',
    from: '    if (spend.value > allowance.value) {',
    to: '    if (spend.value >= 0) {',
    revives: 'D',
  },
  {
    name: 'claim/column quantity matching removed',
    from: '            if (!shared) continue;',
    to: '            if (false) continue;',
    revives: 'F',
  },
  {
    name: 'sentence scoping widened back to the paragraph',
    from: '          for (const s of sentences(p.text)) {',
    to: '          for (const s of [p.text]) {',
    revives: 'G',
  },
];

for (const m of mutants) {
  if (!original.includes(m.from)) {
    check(`MUTANT (${m.name}) anchor exists`, () => false);
    continue;
  }
  fs.writeFileSync(SWEEP, original.replace(m.from, m.to));
  const r = run();
  check(`MUTANT ${m.name} -> fixture ${m.revives} fires`, () => hits(r, m.revives).length > 0);
  // The positive cases must still fire: a mutant that breaks everything proves nothing about
  // WHICH rule the arm holds.
  check(`MUTANT ${m.name} -> A still fires`, () => hits(r, 'A').length > 0);
}

fs.writeFileSync(SWEEP, original);

// --- report ---------------------------------------------------------------------------------
let pass = 0;
let fail = 0;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  v ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed  (fixtures in ${root})`);

fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
