// mutcheck-ps1-encoding.mjs -- proves the gates in ps1-encoding-sweep.mjs are load-bearing
// rather than decoration, by driving the REAL sweep as a subprocess against synthetic trees.
//
// Three things have to be demonstrated, because each of them was got wrong at least once while
// the sweep was being written:
//
//   1. The BOM is what is detected, not the characters. The identical bytes must PASS with a BOM
//      and FAIL without one. A check that merely notices "this file has an emoji" would flag the
//      already-correct files forever.
//   2. Severity is a decision, not a label. A comparison against a non-ASCII literal must come
//      back LOAD-BEARING; the same literal in console output must not.
//   3. A non-ASCII character in a TRAILING COMMENT on a line that also contains `-eq` must NOT
//      be LOAD-BEARING. This is not hypothetical: the first heuristic written for this job
//      flagged oa-state.ps1 L745 -- `if ($null -eq $store) { return $board }   # ... -> legacy`
//      -- purely because the arrow and the operator shared a line. A severity system that cries
//      wolf on the repo's most load-bearing script is worse than none, because the next reader
//      learns to skip the output.
//
// Every fixture builds its non-ASCII from \u escapes, so THIS file stays pure ASCII. That is the
// same defect the sweep hunts, one layer up: a fixture corrupted on the way in reads exactly
// like a broken implementation.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sweep = join(import.meta.dirname, 'ps1-encoding-sweep.mjs');

const MOON = '\u{1F319}';   // an astral-plane emoji (surrogate pair in UTF-16)
const WARN = '\u26a0';      // a BMP symbol
const ARROW = '\u2192';     // the character behind the measured false positive

const ASCII_ONLY = 'param()\nWrite-Output "plain ascii only"\n';
const COMMENT_ONLY = `param()\n# ${WARN} this note is prose ${ARROW} nothing depends on it\nWrite-Output "ok"\n`;
const LITERAL = `param()\nWrite-Output "${WARN} done"\n`;
const LOAD_BEARING = `param()\nif ($line -match '^##\\s*${MOON}') { Write-Output "heading ok" }\n`;
const TRAILING_COMMENT_COMPARE = `param()\nif ($null -eq $store) { return $board }   # no store yet ${ARROW} legacy behaviour\n`;
// The same shape, but with QUOTES inside the trailing comment. This is the fixture that actually
// exercises the '#' cutoff: without it, the quote characters in the comment open a literal span
// that swallows the arrow, and the line's `-eq` then promotes prose to LOAD-BEARING. run-sweeps.ps1
// alone carries 61 non-ASCII comment lines, many of them quoting things, so this is the common shape.
const TRAILING_COMMENT_QUOTED = `param()\nif ($null -eq $store) { return $board }   # no store yet, so "${ARROW} legacy" applies\n`;

const BOM = '\ufeff';

function runSweep(files) {
  const root = mkdtempSync(join(tmpdir(), 'mutcheck-ps1enc-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const full = join(root, name);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body, 'utf8');
    }
    try {
      const out = execFileSync('node', [sweep], {
        encoding: 'utf8',
        env: { ...process.env, PS1_SWEEP_ROOT: root },
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
    name: 'an ASCII-only .ps1 is clean (no crying wolf)',
    files: { 'a.ps1': ASCII_ONLY },
    expectCode: 0,
    expectText: 'clean - every .ps1',
  },
  {
    name: 'BOM-less + non-ASCII in a COMMENT is still a finding (the latent trap)',
    files: { 'a.ps1': COMMENT_ONLY },
    expectCode: 1,
    expectText: '[COMMENT-ONLY] a.ps1',
  },
  {
    name: 'THE SAME BYTES WITH A BOM PASS -- the BOM is what is detected, not the emoji',
    files: { 'a.ps1': BOM + COMMENT_ONLY },
    expectCode: 0,
    expectText: 'clean - every .ps1',
  },
  {
    name: 'a load-bearing literal with a BOM also passes (fix is the BOM, not deleting the char)',
    files: { 'a.ps1': BOM + LOAD_BEARING },
    expectCode: 0,
    expectText: 'clean - every .ps1',
  },
  {
    name: 'non-ASCII in console output is LITERAL, not LOAD-BEARING',
    files: { 'a.ps1': LITERAL },
    expectCode: 1,
    expectText: '[LITERAL] a.ps1',
  },
  {
    name: 'non-ASCII inside a -match literal is LOAD-BEARING (the class that breaks guards)',
    files: { 'a.ps1': LOAD_BEARING },
    expectCode: 1,
    expectText: '[LOAD-BEARING] a.ps1',
  },
  {
    name: 'REGRESSION: non-ASCII in a TRAILING COMMENT beside -eq is NOT load-bearing',
    files: { 'a.ps1': TRAILING_COMMENT_COMPARE },
    expectCode: 1,
    expectText: '[COMMENT-ONLY] a.ps1',
  },
  {
    name: 'REGRESSION: a QUOTED non-ASCII phrase in a trailing comment is NOT load-bearing',
    files: { 'a.ps1': TRAILING_COMMENT_QUOTED },
    expectCode: 1,
    expectText: '[COMMENT-ONLY] a.ps1',
  },
  {
    name: 'a LOAD-BEARING file among comment-only ones is still reported (not averaged away)',
    files: { 'a.ps1': COMMENT_ONLY, 'b.ps1': COMMENT_ONLY, 'c.ps1': LOAD_BEARING },
    expectCode: 1,
    expectText: 'LOAD-BEARING (logic at risk)  : 1',
  },
  {
    name: 'node_modules is skipped (a vendored .ps1 is not ours to re-save)',
    files: { 'node_modules/pkg/a.ps1': LOAD_BEARING, 'b.ps1': ASCII_ONLY },
    expectCode: 0,
    expectText: 'clean - every .ps1',
  },
  {
    name: 'nested directories are walked (findings do not hide one level down)',
    files: { 'plugins/deep/a.ps1': COMMENT_ONLY },
    expectCode: 1,
    expectText: 'plugins/deep/a.ps1',
  },
];

let failed = 0;
for (const c of cases) {
  const r = runSweep(c.files);
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
