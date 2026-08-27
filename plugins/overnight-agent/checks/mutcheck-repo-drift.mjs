#!/usr/bin/env node
/**
 * mutcheck-repo-drift.mjs — proves repo-drift-sweep's guards are load-bearing.
 *
 * WHY THIS IS MANDATORY
 * ---------------------
 * `repo-drift-sweep` reads 0 the night it ships, because the run that wrote it
 * also archived everything it looks at. A detector that has only ever printed
 * "no drift" is indistinguishable from a detector that cannot detect. This
 * codebase has already shipped one of those — `rule-coverage` reported
 * 157/157 = 100% because its corpus included the comments restating each rule,
 * so every rule matched its own quotation.
 *
 * So: build synthetic fixtures, run the REAL sweep as a child process against
 * them, and assert both directions — it fires when it should, and stays silent
 * when it should. Then disable each guard in turn and assert that exactly its
 * own case breaks and nothing else does.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SWEEP = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'repo-drift-sweep.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-drift-'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`  FAIL  ${name}  -- ${detail}`);
  }
}

/** A synthetic world: a fake OA_HOME plus a fake repo archive. */
function makeWorld(id) {
  const w = path.join(root, id);
  const oa = path.join(w, 'oa');
  const repo = path.join(w, 'repo');
  const checks = path.join(repo, 'plugins', 'overnight-agent', 'checks');
  const skill = path.join(repo, 'plugins', 'overnight-agent', 'skills', 'overnight-agent');
  fs.mkdirSync(oa, { recursive: true });
  fs.mkdirSync(checks, { recursive: true });
  fs.mkdirSync(skill, { recursive: true });

  // Minimal but format-faithful registry.
  const registry = [
    '$Suite = @(',
    "  @{ n = 'alpha-sweep';  bridge = $false }",
    "  @{ n = 'beta-sweep';   bridge = $false }",
    ')',
    "$Excluded = @('gamma-sweep')",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(oa, 'run-sweeps.ps1'), registry);
  // run-sweeps.ps1 is itself part of the corpus (it is in ORCHESTRATION), so it
  // must be archived too. Leaving it out gave every fixture a constant +1
  // UNVERSIONED finding, which pinned every exit code at 1 and made the
  // mutation tests read "before=1 after=1" - i.e. it silently destroyed the
  // signal the whole harness exists to measure.
  fs.writeFileSync(path.join(checks, 'run-sweeps.ps1'), registry);

  return { w, oa, repo, checks, skill };
}

function writeBoth(world, name, body, { archive = true, archiveBody = null } = {}) {
  fs.writeFileSync(path.join(world.oa, name), body);
  if (archive) fs.writeFileSync(path.join(world.checks, name), archiveBody ?? body);
}

function run(world, extraEnv = {}, sweepPath = SWEEP) {
  const r = spawnSync(process.execPath, [sweepPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OA_HOME: world.oa,
      OA_CHECKS_REPO: world.checks,
      OA_SKILL_REPO: world.skill,
      ...extraEnv,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** Register an extra sweep in BOTH copies, so the registry edit is not itself drift. */
function addToRegistry(world, name) {
  const p = path.join(world.oa, 'run-sweeps.ps1');
  const next = fs
    .readFileSync(p, 'utf8')
    .replace(
      "  @{ n = 'beta-sweep';   bridge = $false }",
      `  @{ n = 'beta-sweep';   bridge = $false }\n  @{ n = '${name}';  bridge = $false }`
    );
  fs.writeFileSync(p, next);
  fs.writeFileSync(path.join(world.checks, 'run-sweeps.ps1'), next);
}

/**
 * The verdict, not just the exit code.
 *
 * Comparing exit codes alone is too coarse to prove a guard load-bearing: a
 * world with two findings that a mutant reduces to one still exits 1 both
 * times, so the guard reads as inert when it is doing real work. Compare the
 * actual finding lines instead.
 */
function verdict(r) {
  return r.out
    .split('\n')
    .filter((l) => /^\s+- /.test(l) || /^(UNVERSIONED|MODIFIED|FINDINGS|no drift)/.test(l.trim()))
    .map((l) => l.trim())
    .join('|');
}

// ---------------------------------------------------------------------------
console.log('\n== baseline: fully archived world stays silent ==');
{
  const w = makeWorld('baseline');
  writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n');
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  const r = run(w);
  check('baseline exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
  check('baseline says no drift', /no drift/.test(r.out), r.out);
}

// ---------------------------------------------------------------------------
console.log('\n== G1 registry-derived corpus: a registered-but-unarchived sweep FIRES ==');
{
  const w = makeWorld('g1');
  writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n');
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n', { archive: false }); // never committed
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  const r = run(w);
  check('G1 exits 1', r.code === 1, `exit=${r.code}\n${r.out}`);
  check('G1 names the unversioned file', /UNVERSIONED[\s\S]*beta-sweep\.mjs/.test(r.out), r.out);
}

// ---------------------------------------------------------------------------
console.log('\n== G2 transitive imports: an unarchived LIB pulled in by a sweep FIRES ==');
{
  const w = makeWorld('g2');
  // alpha imports a lib. The lib is in no registry - only the import reveals it.
  writeBoth(w, 'alpha-sweep.mjs', "import './lib-thing.mjs';\nconsole.log(1);\n");
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  writeBoth(w, 'lib-thing.mjs', 'export const x = 1;\n', { archive: false });
  const r = run(w);
  check('G2 exits 1', r.code === 1, `exit=${r.code}\n${r.out}`);
  check(
    'G2 names the lib no registry mentions',
    /UNVERSIONED[\s\S]*lib-thing\.mjs/.test(r.out),
    r.out
  );
}

// ---------------------------------------------------------------------------
console.log('\n== G3 line-ending normalization: CRLF-vs-LF alone must NOT fire ==');
{
  const w = makeWorld('g3');
  writeBoth(w, 'alpha-sweep.mjs', 'const a = 1;\r\nconst b = 2;\r\n', {
    archiveBody: 'const a = 1;\nconst b = 2;\n',
  });
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  const r = run(w);
  check('G3 exits 0 (no false positive)', r.code === 0, `exit=${r.code}\n${r.out}`);
  check('G3 reports no MODIFIED', !/MODIFIED/.test(r.out), r.out);
}

// ---------------------------------------------------------------------------
console.log('\n== G5 real content drift FIRES, with direction ==');
{
  const w = makeWorld('g5');
  writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n// a new line added tonight\n', {
    archiveBody: 'console.log(1);\n',
  });
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  const r = run(w);
  check('G5 exits 1', r.code === 1, `exit=${r.code}\n${r.out}`);
  check('G5 reports MODIFIED', /MODIFIED[\s\S]*alpha-sweep\.mjs/.test(r.out), r.out);
  check('G5 reports live ahead', /live ahead \(uncommitted\)/.test(r.out), r.out);
}

// ---------------------------------------------------------------------------
console.log('\n== G4 git-aware: a file in ANOTHER ref is backed up, not a finding ==');
{
  const w = makeWorld('g4');
  writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n');
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  // Lives only on a side branch, exactly like write-turn.ps1 in open PR #193.
  writeBoth(w, 'delta-sweep.mjs', 'console.log(4);\n', { archive: false });
  addToRegistry(w, 'delta-sweep');

  const git = (...args) => execFileSync('git', ['-C', w.repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'mutcheck@example.com');
  git('config', 'user.name', 'mutcheck');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'side');
  fs.writeFileSync(path.join(w.checks, 'delta-sweep.mjs'), 'console.log(4);\n');
  git('add', '-A');
  git('commit', '-qm', 'add delta on side branch');
  git('checkout', '-q', '-');
  fs.rmSync(path.join(w.checks, 'delta-sweep.mjs'), { force: true });

  const r = run(w);
  check('G4 exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
  check(
    'G4 classifies as versioned-elsewhere, not UNVERSIONED',
    /versioned in another ref[\s\S]*delta-sweep\.mjs/.test(r.out) && !/UNVERSIONED/.test(r.out),
    r.out
  );
}

// ---------------------------------------------------------------------------
// G6 is G4's principle applied to CONTENT rather than EXISTENCE.
//
// G4 proved a file absent from this worktree but present on another ref is
// backed up. The MODIFIED arm had no equivalent, so a file that EXISTS here but
// whose live bytes are committed on a different ref was reported as
// "live ahead (uncommitted)".
//
// That fired for real on 2026-08-27 against `dropped-ask-sweep.mjs` and
// `mutcheck-dropped-ask.mjs`, both committed and open as PR #203 — a PR based
// on the very branch the archive had checked out. A run believed the report and
// committed #203's change onto #203's own base branch, which would have
// collided on merge. The reading was wrong; the action it invited was worse.
console.log('\n== G6 git-aware CONTENT: live bytes committed on ANOTHER ref are backed up ==');
{
  const w = makeWorld('g6');
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  // Archive (this worktree) holds OLD; the live copy holds the NEW bytes that
  // are committed on `side` — exactly the open-PR-stacked-on-this-branch shape.
  writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n// tonight\n', {
    archiveBody: 'console.log(1);\n',
  });

  const git = (...args) => execFileSync('git', ['-C', w.repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'mutcheck@example.com');
  git('config', 'user.name', 'mutcheck');
  git('add', '-A');
  git('commit', '-qm', 'base with OLD alpha');
  git('checkout', '-qb', 'side');
  fs.writeFileSync(path.join(w.checks, 'alpha-sweep.mjs'), 'console.log(1);\n// tonight\n');
  git('add', '-A');
  git('commit', '-qm', 'alpha advanced on side branch');
  git('checkout', '-q', '-');
  fs.writeFileSync(path.join(w.checks, 'alpha-sweep.mjs'), 'console.log(1);\n');

  const r = run(w);
  check('G6 exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
  check(
    'G6 classifies as committed-elsewhere, not MODIFIED',
    /live content committed on another ref[\s\S]*alpha-sweep\.mjs/.test(r.out) &&
      !/MODIFIED \(archived copy has diverged\)/.test(r.out),
    r.out
  );
  check('G6 names the ref carrying the content', /alpha-sweep\.mjs[^\n]*side/.test(r.out), r.out);
}

// ---------------------------------------------------------------------------
// G7 pins the cross-PATH half of G6. A check legitimately lives at two paths
// across branches -- `mutcheck-write-turn.ps1` sits in `checks/` on one branch
// and in `skills/overnight-agent/` on the branch that now owns it. G6's first
// cut searched only the path this worktree uses and reported the file as
// uncommitted while its bytes were committed verbatim one directory over.
console.log('\n== G7 git-aware CONTENT across a RENAME: same filename, different path ==');
{
  const w = makeWorld('g7');
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n// moved\n', {
    archiveBody: 'console.log(1);\n',
  });

  const git = (...args) => execFileSync('git', ['-C', w.repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'mutcheck@example.com');
  git('config', 'user.name', 'mutcheck');
  git('add', '-A');
  git('commit', '-qm', 'base');
  // The NEW bytes are committed under skills/, never under checks/.
  git('checkout', '-qb', 'side');
  const skillPath = path.join(w.skill, 'alpha-sweep.mjs');
  fs.writeFileSync(skillPath, 'console.log(1);\n// moved\n');
  git('add', '-A');
  git('commit', '-qm', 'alpha moved to skills/ on side branch');
  git('checkout', '-q', '-');
  fs.rmSync(skillPath, { force: true });

  const r = run(w);
  check('G7 exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
  check(
    'G7 finds the content at a DIFFERENT path on another ref',
    /live content committed on another ref[\s\S]*alpha-sweep\.mjs/.test(r.out) &&
      !/MODIFIED \(archived copy has diverged\)/.test(r.out),
    r.out
  );
}

// ---------------------------------------------------------------------------
// Mutation: disable each guard and assert exactly its own case breaks.
// ---------------------------------------------------------------------------
console.log('\n== mutation: each guard must be load-bearing ==');

const src = fs.readFileSync(SWEEP, 'utf8');

const mutants = [
  {
    name: 'G2 import walk',
    // Neuter the transitive walk: stop following local imports.
    find: "      if (!s.startsWith('.')) continue;",
    repl: '      continue;',
    breaks: 'g2',
  },
  {
    name: 'G3 normalization',
    // Stop collapsing CRLF, so autocrlf differences look like real drift.
    find: "    .replace(/\\r\\n/g, '\\n')",
    repl: '',
    breaks: 'g3',
  },
  {
    name: 'G4 git awareness',
    find: '      if (tracked && tracked.has(file)) elsewhere.push(file);',
    repl: '      if (false) elsewhere.push(file);',
    breaks: 'g4',
  },
  {
    name: 'G6 git-aware content',
    find: '      const at = committedAtPathElsewhere(repoRoot, relPath, live);',
    repl: '      const at = null;',
    breaks: 'g6',
  },
];

function worldFor(kind) {
  const w = makeWorld(`mut-${kind}-${Math.random().toString(36).slice(2, 8)}`);
  if (kind === 'g2') {
    writeBoth(w, 'alpha-sweep.mjs', "import './lib-thing.mjs';\nconsole.log(1);\n");
    writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
    writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
    writeBoth(w, 'lib-thing.mjs', 'export const x = 1;\n', { archive: false });
    return { w, expectFires: true };
  }
  if (kind === 'g3') {
    writeBoth(w, 'alpha-sweep.mjs', 'const a = 1;\r\nconst b = 2;\r\n', {
      archiveBody: 'const a = 1;\nconst b = 2;\n',
    });
    writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
    writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
    return { w, expectFires: false };
  }
  if (kind === 'g6') {
    writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
    writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
    writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n// tonight\n', {
      archiveBody: 'console.log(1);\n',
    });
    const g = (...args) => execFileSync('git', ['-C', w.repo, ...args], { stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 'm@e.com');
    g('config', 'user.name', 'm');
    g('add', '-A');
    g('commit', '-qm', 'base');
    g('checkout', '-qb', 'side');
    fs.writeFileSync(path.join(w.checks, 'alpha-sweep.mjs'), 'console.log(1);\n// tonight\n');
    g('add', '-A');
    g('commit', '-qm', 'side');
    g('checkout', '-q', '-');
    fs.writeFileSync(path.join(w.checks, 'alpha-sweep.mjs'), 'console.log(1);\n');
    return { w, expectFires: false };
  }
  // g4
  writeBoth(w, 'alpha-sweep.mjs', 'console.log(1);\n');
  writeBoth(w, 'beta-sweep.mjs', 'console.log(2);\n');
  writeBoth(w, 'gamma-sweep.mjs', 'console.log(3);\n');
  writeBoth(w, 'delta-sweep.mjs', 'console.log(4);\n', { archive: false });
  addToRegistry(w, 'delta-sweep');
  const git = (...args) => execFileSync('git', ['-C', w.repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'm@e.com');
  git('config', 'user.name', 'm');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'side');
  fs.writeFileSync(path.join(w.checks, 'delta-sweep.mjs'), 'console.log(4);\n');
  git('add', '-A');
  git('commit', '-qm', 'side');
  git('checkout', '-q', '-');
  fs.rmSync(path.join(w.checks, 'delta-sweep.mjs'), { force: true });
  return { w, expectFires: false };
}

for (const m of mutants) {
  if (!src.includes(m.find)) {
    fail++;
    failures.push(`${m.name}: mutation anchor not found - the mutcheck is stale`);
    console.log(`  FAIL  ${m.name} -- anchor not found, mutcheck is stale`);
    continue;
  }
  const mutPath = path.join(root, `mutant-${m.breaks}.mjs`);
  fs.writeFileSync(mutPath, src.replace(m.find, m.repl));

  // Its own case must change verdict.
  const own = worldFor(m.breaks);
  const before = run(own.w, {}, SWEEP);
  const after = run(own.w, {}, mutPath);
  const changed = verdict(before) !== verdict(after);
  check(
    `${m.name} LOAD-BEARING (its own case flips)`,
    changed,
    `verdict unchanged: ${verdict(before)}`
  );

  // Every other case must be unaffected: no collateral.
  let collateral = [];
  for (const other of ['g2', 'g3', 'g4', 'g6'].filter((k) => k !== m.breaks)) {
    const ow = worldFor(other);
    const b = run(ow.w, {}, SWEEP);
    const a = run(ow.w, {}, mutPath);
    if (verdict(b) !== verdict(a)) collateral.push(`${other}: ${verdict(b)} -> ${verdict(a)}`);
  }
  check(`${m.name} zero collateral`, collateral.length === 0, collateral.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
