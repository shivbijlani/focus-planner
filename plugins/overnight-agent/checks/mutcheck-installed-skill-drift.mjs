// mutcheck-installed-skill-drift.mjs
//
// Proves the three guards in installed-skill-drift-sweep.mjs are LOAD-BEARING, not decoration.
//
// Method: build a throwaway git repo and a throwaway "installed plugin" tree whose files
// exercise every verdict, run the REAL sweep against them as a child process (so nothing can
// be faked by importing internals), then neuter one guard at a time in a COPY of the source
// and assert each mutant breaks EXACTLY its own case and leaves the others correct.
//
// A guard whose removal breaks nothing is dead code. A guard whose removal breaks everything
// is not a guard, it is the matcher. Only "breaks exactly its own case" is evidence.
//
// exit 1 = the harness found a guard that is not load-bearing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SWEEP =
  process.env.OA_SWEEP ||
  join(process.env.LOCALAPPDATA || '.', 'overnight-agent', 'installed-skill-drift-sweep.mjs');

const SRC = readFileSync(SWEEP, 'utf8');

// --- the mutants -------------------------------------------------------------------------
// find -> replace, plus the ONE case id each is expected to break.
const MUTANTS = [
  {
    guard: 'g1 template-exclusion',
    find: "const TEMPLATES = new Set(['user-settings.md']);",
    repl: 'const TEMPLATES = new Set([]);',
    breaks: 'template',
  },  {
    guard: 'g2 newline-normalisation (both sides)',
    find: "  return text.replace(/\\r\\n/g, '\\n').replace(/\\s+$/, '') + '\\n';",
    repl: '  return text;',
    breaks: ['crlf', 'crlfInRepo'],
  },
  {
    guard: 'g3 plugin-scoping',
    find: "  if (!installedTopDirs.has(rel.split('/')[0])) continue; // g3",
    repl: '  if (false) continue; // g3',
    breaks: 'scaffolding',
  },
];

// `breaks` is a SET, not always a single case. g2 is one mechanism (norm()) that covers two
// symmetric halves -- a CRLF working copy against an LF blob, and an LF working copy against a
// CRLF blob. Splitting it into two "guards" to satisfy a one-case-each rule would be modelling
// the test, not the code. The discipline is preserved by asserting EXACT set equality: the
// mutant must break precisely the named cases, no more and no fewer.

// Deliberately NOT a mutant: main-first precedence. Neutering it broke 3 of 6 cases (both,
// crlf, onMain), because main is reachable under two ref names (origin/main and main), so any
// main-matching file has >= 2 hits and inverting precedence mislabels all of them. A change
// that breaks everything is the MATCHER, not a guard -- certifying it as one would be
// self-congratulation. The `both` case below asserts the precedence directly instead.

// --- the world ---------------------------------------------------------------------------
// case id -> { body, installedBody, expectedVerdict }
//   onMain        : identical to origin/main                       -> MAIN
//   branchOnly    : only on a side branch                          -> BRANCH-ONLY
//   unversioned   : on no ref at all                               -> UNVERSIONED
//   template      : bundled template, branch-only content          -> excluded (no verdict)
//   crlf          : main's content, CRLF on disk                   -> MAIN   (guard g2)
//   both          : on main AND a side branch                      -> MAIN   (guard g3)
//   missing       : on main, ABSENT from the installed tree        -> MISSING
//   scaffolding   : on main at the prefix ROOT, absent installed   -> excluded (guard g3)
const CASES = {
  onMain: { file: 'skills/overnight-agent/a-on-main.ps1', expect: 'MAIN' },
  branchOnly: { file: 'skills/overnight-agent/b-branch-only.ps1', expect: 'BRANCH-ONLY' },
  unversioned: { file: 'skills/overnight-agent/c-unversioned.ps1', expect: 'UNVERSIONED' },
  template: { file: 'skills/overnight-agent/user-settings.md', expect: null },
  crlf: { file: 'skills/overnight-agent/d-crlf.ps1', expect: 'MAIN' },
  both: { file: 'skills/overnight-agent/e-both.ps1', expect: 'MAIN' },
  missing: { file: 'skills/overnight-agent/f-missing.ps1', expect: 'MISSING' },
  scaffolding: { file: 'marketplace-note.md', expect: null },
  crlfInRepo: { file: 'skills/overnight-agent/g-crlf-in-repo.ps1', expect: 'MAIN' },
};

function buildWorld() {
  const root = mkdtempSync(join(tmpdir(), 'oa-installed-drift-'));
  const repo = join(root, 'repo');
  const installed = join(root, 'installed', 'focus-planner');
  const pluginDir = join(repo, 'plugins', 'overnight-agent', 'skills', 'overnight-agent');
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(join(installed, 'skills', 'overnight-agent'), { recursive: true });

  const g = (args, opts = {}) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...opts });

  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'mutcheck@example.invalid']);
  g(['config', 'user.name', 'mutcheck']);
  // Control line endings explicitly: the harness needs a blob stored WITH CRLF (crlfInRepo) and
  // blobs stored with LF. Leaving autocrlf to the machine's global config makes that
  // non-deterministic -- and line endings are the very thing under test.
  g(['config', 'core.autocrlf', 'false']);

  const repoFile = (name) => join(repo, 'plugins', 'overnight-agent', name);

  // main carries: a-on-main, d-crlf, e-both, f-missing (never installed), and the
  // marketplace-level scaffolding file that must NOT be reported as MISSING.
  writeFileSync(repoFile(CASES.onMain.file), 'on main\n');
  writeFileSync(repoFile(CASES.crlf.file), 'crlf body\n');
  writeFileSync(repoFile(CASES.both.file), 'both body\n');
  writeFileSync(repoFile(CASES.missing.file), 'merged but never deployed\n');
  writeFileSync(repoFile(CASES.scaffolding.file), 'marketplace registry readme\n');
  // stored in the repo WITH CRLF -- the direction the first cut of g2 could not handle.
  writeFileSync(repoFile(CASES.crlfInRepo.file), 'crlf in repo body\r\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'main content']);

  // a side branch carries: b-branch-only, user-settings.md, and a DIFFERENT e-both is not
  // needed -- e-both keeps main's content so it is on both refs.
  g(['checkout', '-q', '-b', 'side']);
  writeFileSync(repoFile(CASES.branchOnly.file), 'branch only body\n');
  writeFileSync(repoFile(CASES.template.file), 'template body\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'side content']);
  g(['checkout', '-q', 'main']);

  // The sweep resolves refs as origin/main + refs/heads + refs/remotes. There is no remote
  // here, so give it a local ref literally named origin/main under refs/heads.
  g(['branch', '-q', 'origin/main', 'main']);

  // --- the installed tree ---
  const inst = (name, body) =>
    writeFileSync(join(installed, name), body, 'utf8');
  inst(CASES.onMain.file, 'on main\n');
  inst(CASES.branchOnly.file, 'branch only body\n');
  inst(CASES.unversioned.file, 'this content is on no ref anywhere\n');
  inst(CASES.template.file, 'template body\n');
  inst(CASES.crlf.file, 'crlf body\r\n'); // same content, Windows line ending
  inst(CASES.both.file, 'both body\n');
  inst(CASES.crlfInRepo.file, 'crlf in repo body\n'); // LF on disk, CRLF in the blob

  return { root, repo, installed };
}

function runSweep(sweepPath, world) {
  let out = '';
  try {
    out = execFileSync('node', [sweepPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OA_REPO: world.repo,
        OA_INSTALLED_PLUGIN: world.installed,
        OA_REPO_PREFIX: 'plugins/overnight-agent',
      },
    });
  } catch (err) {
    out = (err.stdout || '') + (err.stderr || '');
  }
  // Parse the verdict table: "  VERDICT   path    [where]"
  const verdicts = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s{2}(MAIN|BRANCH-ONLY|UNVERSIONED|MISSING)\s+(\S+)\s+\[/.exec(line);
    if (m) verdicts.set(m[2], m[1]);
  }
  return { out, verdicts };
}

function evaluate(world, sweepPath) {
  const { verdicts } = runSweep(sweepPath, world);
  const wrong = [];
  for (const [id, c] of Object.entries(CASES)) {
    const actual = verdicts.get(c.file) ?? null;
    if (actual !== c.expect) wrong.push({ id, expect: c.expect, actual });
  }
  return wrong;
}

const world = buildWorld();
let exit = 0;
try {
  console.log(`sweep under test: ${SWEEP}`);
  console.log(`synthetic world:  ${world.root}\n`);

  const baseWrong = evaluate(world, SWEEP);
  console.log('case         expect        actual');
  const { verdicts } = runSweep(SWEEP, world);
  for (const [id, c] of Object.entries(CASES)) {
    const actual = verdicts.get(c.file) ?? null;
    const ok = actual === c.expect ? 'PASS' : 'FAIL';
    console.log(
      `${id.padEnd(12)} ${String(c.expect ?? 'excluded').padEnd(13)} ${String(actual ?? 'excluded').padEnd(13)} [${ok}]`,
    );
  }
  console.log(
    `\nbaseline: ${Object.keys(CASES).length - baseWrong.length}/${Object.keys(CASES).length} correct`,
  );
  if (baseWrong.length) {
    console.log('BASELINE FAILED -- the sweep is wrong before any mutation.');
    for (const w of baseWrong) console.log(`  ${w.id}: expected ${w.expect}, got ${w.actual}`);
    exit = 1;
  }

  for (const m of MUTANTS) {
    if (!SRC.includes(m.find)) {
      console.log(`\nmutant ${m.guard}: ANCHOR NOT FOUND -- harness is stale, cannot certify.`);
      exit = 1;
      continue;
    }
    const mutPath = join(world.root, `mutant-${m.breaks}.mjs`);
    writeFileSync(mutPath, SRC.replace(m.find, m.repl), 'utf8');
    const wrong = evaluate(world, mutPath);
    const broke = wrong.map((w) => w.id).sort();
    const want = (Array.isArray(m.breaks) ? m.breaks : [m.breaks]).slice().sort();
    const ok = broke.length === want.length && broke.every((b, i) => b === want[i]);
    console.log(`\nmutant (${m.guard} neutered):`);
    console.log(`  cases broken   : ${broke.join(', ') || '(none)'}`);
    console.log(`  expected breaks: ${want.join(', ')}`);
    if (!ok) {
      console.log(
        broke.length === 0
          ? '  VERDICT: NOT load-bearing -- removing it changed nothing. Dead guard.'
          : '  VERDICT: wrong blast radius -- it does not break exactly the cases it claims.',
      );
      exit = 1;
    } else {
      console.log('  VERDICT: load-bearing - breaks exactly the cases it claims.');
    }
  }

  if (exit === 0) {
    console.log(
      '\nAll three guards are load-bearing against both line endings, a 3-ref world, and both\n' +
        'drift directions (installed-not-in-git AND on-main-not-installed); main-first\n' +
        'precedence is asserted by the `both` baseline case (see the note above the mutant list).',
    );
  }
} finally {
  rmSync(world.root, { recursive: true, force: true });
}
process.exit(exit);
