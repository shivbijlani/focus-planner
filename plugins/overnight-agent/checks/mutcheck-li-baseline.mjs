// mutcheck-li-baseline.mjs — prove the lost-interpolation baseline can silence
// ONLY the exact damaged lines it was minted for, and can never swallow new
// corruption.
//
// WHY THIS IS THE LOAD-BEARING TEST
// -----------------------------------------------------------------------------
// A baseline is the one change to a detector that can make it WORSE than having
// no detector at all: it converts a loud, honest red into a confident green. If
// the key were the filename, every future corruption in #247 or #320 — both
// large, actively-appended journals — would be silently absorbed. So the key is
// sha1(file | kind | exact line text), and that claim has to be executable, not
// asserted in a comment.
//
// Five scenarios, run against a throwaway journal tree:
//   A  no baseline                        -> both damaged lines are NEW, exit 1
//   B  baseline minted from A             -> 0 new, exit 0
//   C  a brand-new damaged line appears   -> exactly that line is NEW, exit 1
//   D  a baselined line is EDITED         -> it fires again (content-addressed)
//   E  a baselined line is REPAIRED       -> reported stale, still exit 0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SWEEP = path.join(HERE, 'lost-interpolation-sweep.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'li-baseline-'));
const journal = path.join(root, 'journal');
fs.mkdirSync(journal);
const baselineFile = path.join(root, 'baseline.json');

// Verbatim damage shapes from the live corpus.
const DAMAGED_A = '- Price **~\\**, market cap **~\\**. 52-week range **\\.57 – \\** — down ~55%';
const DAMAGED_B = '| **Ayres Hotel Mission Viejo** | ~5.5 mi | \\–\\ | **~\\–\\,392** | Cheapest |';
const DAMAGED_C = 'Would you take **\\ shipped**? Can pay + arrange right away.';
const CLEAN = 'the range is ~\\$150–275 for the whole materials list';

const fileA = path.join(journal, 'task-901.md');
const fileB = path.join(journal, 'task-902.md');

function write(f, lines) {
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
}

function run(args = []) {
  const env = { ...process.env, PLANNER_PATH: root, LI_BASELINE: baselineFile };
  try {
    const stdout = execFileSync(process.execPath, [SWEEP, ...args], { env, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

function json(args = []) {
  const r = run(['--json', ...args]);
  return { code: r.code, data: JSON.parse(r.stdout) };
}

let pass = 0;
let fail = 0;
const bad = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    bad.push(`${label}${detail ? `\n         ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- scenario A --
write(fileA, ['# Task 901', DAMAGED_A, CLEAN]);
write(fileB, ['# Task 902', DAMAGED_B]);

let a = json();
check('A: both damaged lines are NEW', a.data.newCount === 2, `newCount=${a.data.newCount}`);
check('A: nothing is pre-acknowledged', a.data.knownCount === 0, `knownCount=${a.data.knownCount}`);
check('A: exits non-zero', a.code === 1, `exit=${a.code}`);
check('A: the correctly-escaped line is not flagged', a.data.flagged === 2, `flagged=${a.data.flagged}`);

// ---------------------------------------------------------------- scenario B --
run(['--update-baseline']);
check('B: baseline file created', fs.existsSync(baselineFile));

let b = json();
check('B: no new findings once acknowledged', b.data.newCount === 0, `newCount=${b.data.newCount}`);
check('B: both are counted as known', b.data.knownCount === 2, `knownCount=${b.data.knownCount}`);
check('B: exits ZERO', b.code === 0, `exit=${b.code}`);
check('B: nothing stale', b.data.stale.length === 0, `stale=${b.data.stale.length}`);

// ---------------------------------------------------------------- scenario C --
// The scenario that matters: brand-new damage in a file that is ALREADY in the
// baseline. A filename-keyed baseline would swallow this completely.
write(fileA, ['# Task 901', DAMAGED_A, CLEAN, DAMAGED_C]);
let c = json();
check('C: new damage in an already-baselined file fires', c.data.newCount === 1, `newCount=${c.data.newCount}`);
check('C: exits non-zero', c.code === 1, `exit=${c.code}`);
const cFile = c.data.report.find((r) => r.file === 'task-901.md');
check(
  'C: the NEW line is the new one, not the baselined one',
  cFile && cFile.hits.filter((h) => !h.known).length === 1 &&
    cFile.hits.find((h) => !h.known).line.includes('shipped'),
  cFile ? JSON.stringify(cFile.hits.filter((h) => !h.known).map((h) => h.line)) : 'file missing',
);
check('C: the old damage is still acknowledged', c.data.knownCount === 2, `knownCount=${c.data.knownCount}`);

// ---------------------------------------------------------------- scenario D --
// Editing a baselined line changes its hash, so it must stop being silenced.
// This is what stops a baseline entry from becoming a blanket licence for a line
// number that someone later overwrites with different damage.
write(fileA, ['# Task 901', DAMAGED_A.replace('52-week', '52-wk'), CLEAN]);
let d = json();
check('D: an edited baselined line fires again', d.data.newCount === 1, `newCount=${d.data.newCount}`);
check('D: exits non-zero', d.code === 1, `exit=${d.code}`);
check('D: and the original entry reports stale', d.data.stale.length === 1, `stale=${d.data.stale.length}`);

// ---------------------------------------------------------------- scenario E --
// Repairing damage must not fail the run; it should just prune-able as stale.
write(fileA, ['# Task 901', CLEAN]);
let e = json();
check('E: repaired damage yields no findings', e.data.newCount === 0, `newCount=${e.data.newCount}`);
check('E: exits ZERO', e.code === 0, `exit=${e.code}`);
check('E: the obsolete entry is reported stale', e.data.stale.length === 1, `stale=${e.data.stale.length}`);

const plain = run();
check('E: stale is visible in human output', /no longer match any line/.test(plain.stdout));

fs.rmSync(root, { recursive: true, force: true });

console.log(`mutcheck-li-baseline: ${pass} passed, ${fail} failed`);
if (bad.length) {
  console.log('');
  for (const x of bad) console.log('  ' + x);
}
process.exit(fail ? 1 : 0);
