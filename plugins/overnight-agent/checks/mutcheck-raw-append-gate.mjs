// mutcheck-raw-append-gate.mjs -- proves the live-exposure gate in raw-append-reopen-sweep.mjs
// is load-bearing rather than decoration.
//
// The gate exists because the sweep printed "157 exposed" and exited 0 for weeks: the number
// was computed correctly and wired to nothing. A gate that cannot fail is worth exactly as
// much as no gate, so it has to be demonstrated failing on a corpus that deserves it and
// passing on one that does not.
//
// It drives the REAL sweep as a subprocess against synthetic planner folders, so it cannot be
// fooled by source text that merely mentions the fix.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sweep = join(import.meta.dirname, 'raw-append-reopen-sweep.mjs');

const TURN = `# Task 9xx: synthetic

Shiv's own notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-29

<!-- from: overnight-agent -->

### What I did

Wrote the thing.
`;

const EXPOSED = TURN;                                              // turn runs to EOF, no stamp
const STAMPED = `${TURN}\r\n<!-- /overnight-agent turn-end -->\r\n`; // explicit boundary
const BOUNDED = `${TURN}\r\n## 2026-08-29\r\n\r\n<!-- from: me -->\r\napprove\r\n`; // `## ` boundary

function runSweep(journals) {
  const root = mkdtempSync(join(tmpdir(), 'mutcheck-rawappend-'));
  mkdirSync(join(root, 'journal'));
  try {
    for (const [name, body] of Object.entries(journals)) {
      writeFileSync(join(root, 'journal', name), body, 'utf8');
    }
    try {
      const out = execFileSync('node', [sweep], {
        encoding: 'utf8',
        env: { ...process.env, PLANNER_PATH: root },
      });
      return { code: 0, out };
    } catch (err) {
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: 'an exposed journal must FAIL the sweep (this is the mutation the gate exists for)',
    journals: { 'task-901.md': EXPOSED },
    expectCode: 1,
    expectText: 'would silently swallow',
  },
  {
    name: 'a stamped journal must PASS (no crying wolf)',
    journals: { 'task-902.md': STAMPED },
    expectCode: 0,
    expectText: 'behavioural probe',
  },
  {
    name: 'a journal with a `## ` boundary below the turn must PASS',
    journals: { 'task-903.md': BOUNDED },
    expectCode: 0,
    expectText: 'behavioural probe',
  },
  {
    name: 'one exposed journal among healthy ones must still FAIL (not averaged away)',
    journals: { 'task-904.md': STAMPED, 'task-905.md': BOUNDED, 'task-906.md': EXPOSED },
    expectCode: 1,
    expectText: 'exposed: 906',
  },
];

let failed = 0;
for (const c of cases) {
  const r = runSweep(c.journals);
  const ok = r.code === c.expectCode && r.out.includes(c.expectText);
  if (!ok) {
    failed += 1;
    console.log(`FAIL  ${c.name}`);
    console.log(`      expected exit ${c.expectCode} containing ${JSON.stringify(c.expectText)}`);
    console.log(`      got exit ${r.code}`);
    console.log(`      ${r.out.trim().split('\n').join('\n      ')}`);
  } else {
    console.log(`ok    ${c.name}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} assertions passed`);
process.exit(failed ? 1 : 0);
