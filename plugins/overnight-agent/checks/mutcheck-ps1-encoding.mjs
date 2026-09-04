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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sweep = join(import.meta.dirname, 'ps1-encoding-sweep.mjs');

// The repo's checks directory, which is NOT necessarily where this file lives: -IncludeMutchecks
// runs mutation checks from the flat OA home, where `import.meta.dirname` is the OA home and
// `../../..` from it is C:\Users. Assuming otherwise made this check report 13/14 in the one
// environment it actually runs in -- the same root-resolution defect it was written to pin,
// reproduced inside the pin. Resolve it explicitly, exactly as the sweep does.
const REPO_CHECKS = [
  'V:\\repos\\focus-planner\\plugins\\overnight-agent\\checks',
  'V:\\repos\\focus-planner.worktrees\\oa-version-the-checks\\plugins\\overnight-agent\\checks',
  import.meta.dirname,
].find((p) => existsSync(join(p, 'ps1-encoding-sweep.mjs')));

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

// --- ROOT RESOLUTION -------------------------------------------------------------------
// The sweep's first live run scanned 1,004 .ps1 files instead of 40, because it derived its
// root from its OWN location -- correct in the repo, and C:\Users\<name> once deployed to the
// flat OA home, where sweeps actually execute. These two cases pin the contract that replaced
// it: an unresolvable root must say so and scan NOTHING, rather than fall back to some
// arbitrary ancestor directory. A detector that invents a corpus is worse than one that is
// absent, because its findings look real.
function runSweepRaw(env) {
  try {
    const out = execFileSync('node', [sweep], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// The deployed shape, reproduced exactly: a COPY of the sweep sitting in a directory that is
// not the repo, with a decoy BOM-less .ps1 planted three levels above it. That decoy is the
// whole point -- it is the "wrong corpus" marker. Resolving the root from the file's own
// location finds the decoy tree; resolving it from OA_CHECKS_REPO finds the repo. Only the
// second is correct once deployed, and without this case the difference is invisible, because
// running in place the two agree.
function runDeployedCopy() {
  const root = mkdtempSync(join(tmpdir(), 'ps1-flat-'));
  try {
    writeFileSync(join(root, 'decoy.ps1'), `# ${WARN} not ours to re-save\n`, 'utf8');
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const copy = join(deep, 'ps1-encoding-sweep.mjs');
    copyFileSync(sweep, copy);
    try {
      const out = execFileSync('node', [copy], {
        encoding: 'utf8',
        env: { ...process.env, PS1_SWEEP_ROOT: '', OA_CHECKS_REPO: REPO_CHECKS },
      });
      return { code: 0, out };
    } catch (err) {
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The WORKTREE shape (#461), and the mirror of runDeployedCopy above. A copy of the sweep placed
// at <root>/plugins/overnight-agent/checks/ -- the layout every per-task session runs in -- with a
// BOM-less .ps1 planted inside that same tree. With no env overrides at all, the sweep must scan
// the tree it is PART OF and find that file.
//
// Before the fix it resolved to a hardcoded `V:\repos\focus-planner`, so from a worktree it
// scanned the main checkout and reported "clean" about files it had never opened. That is the
// defect this case exists to keep dead, and it is invisible without a synthetic root: run in
// place, the hardcoded path and the self-located path agree.
//
// `package.json` is required because it is what makes self-location an assertion rather than a
// guess -- a directory that merely has the right three trailing segments is not a repo.
function runWorktreeCopy() {
  const root = mkdtempSync(join(tmpdir(), 'ps1-worktree-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"synthetic-worktree"}\n', 'utf8');
    const checks = join(root, 'plugins', 'overnight-agent', 'checks');
    mkdirSync(checks, { recursive: true });
    copyFileSync(sweep, join(checks, 'ps1-encoding-sweep.mjs'));
    writeFileSync(join(checks, 'worktree-only.ps1'), `Write-Host "${WARN} in the worktree"\n`, 'utf8');
    try {
      const out = execFileSync('node', [join(checks, 'ps1-encoding-sweep.mjs')], {
        encoding: 'utf8',
        env: { ...process.env, PS1_SWEEP_ROOT: '', OA_CHECKS_REPO: '' },
      });
      return { code: 0, out };
    } catch (err) {
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rootCases = [
  {
    name: 'ROOT: an unresolvable root scans nothing and exits 0 (never a guessed corpus)',
    env: { PS1_SWEEP_ROOT: join(tmpdir(), 'ps1-sweep-absent-' + Date.now()), OA_CHECKS_REPO: '' },
    expectCode: 0,
    expectText: 'no repo root found',
    reject: null,
  },
  {
    name: 'ROOT: OA_CHECKS_REPO resolves the repo 3 levels up (how the DEPLOYED copy finds it)',
    // Exit code is deliberately not asserted: it depends on whether the repo currently has a
    // finding, which is not what this case is about. What matters is that the root RESOLVED --
    // a scan happened, and it was not the "I gave up" path.
    env: { PS1_SWEEP_ROOT: '', OA_CHECKS_REPO: REPO_CHECKS },
    expectCode: null,
    expectText: '.ps1 files scanned',
    reject: 'no repo root found',
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

for (const c of rootCases) {
  const r = runSweepRaw(c.env);
  const codeOk = c.expectCode === null || r.code === c.expectCode;
  const ok = codeOk && r.out.includes(c.expectText) && (!c.reject || !r.out.includes(c.reject));
  if (!ok) {
    failed += 1;
    console.log(`FAIL  ${c.name}`);
    console.log(`      expected ${c.expectCode === null ? 'any exit' : `exit ${c.expectCode}`} containing ${JSON.stringify(c.expectText)}`);
    if (c.reject) console.log(`      and NOT containing ${JSON.stringify(c.reject)}`);
    console.log(`      got exit ${r.code}`);
    console.log(`      ${r.out.trim().split('\n').slice(0, 8).join('\n      ')}`);
  } else {
    console.log(`ok    ${c.name}`);
  }
}

const total = cases.length + rootCases.length + 2;

{
  const r = runWorktreeCopy();
  const name = 'ROOT: a copy inside a WORKTREE scans that worktree, not the main checkout (#461)';
  if (!r.out.includes('worktree-only.ps1')) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log('      the sweep did not scan the tree it is part of - it reported on some other checkout');
    console.log(`      ${r.out.trim().split('\n').slice(0, 8).join('\n      ')}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

{
  const r = runDeployedCopy();
  const name = 'ROOT: a DEPLOYED copy scans the repo, not its own ancestors (the live regression)';
  if (r.out.includes('decoy.ps1')) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log('      the sweep resolved its root from its own location and scanned the wrong tree');
    console.log(`      ${r.out.trim().split('\n').slice(0, 8).join('\n      ')}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

console.log(`\n${total - failed}/${total} assertions passed`);
process.exit(failed ? 1 : 0);
