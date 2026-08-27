// installed-skill-drift-sweep.mjs
//
// GUARDS: the skill files the agent ACTUALLY EXECUTES must be a version we can name.
//
// repo-drift-sweep (2026-08-26 18:00) asks whether every *detector* is in git. It walks the
// run-sweeps.ps1 registry in %LOCALAPPDATA%. It never looks at
// ~\.copilot\installed-plugins\focus-planner\ -- the plugin the CLI loads and runs. So the
// live SKILL.md and the live oa-state.ps1 were checked by nothing at all.
//
// Why that matters, measured 2026-08-26 18:40: the installed oa-state.ps1 was byte-identical
// to commit 90716eb -- the #191 sibling-skill fix, which is NOT an ancestor of origin/main.
// So the running agent was executing a hand-deployed file that exists on no merged ref, while
// origin/main still carried the 217-line Aug-3 version with none of the reopen fixes. Two
// consequences, both silent:
//
//   1. FORWARD: a fix can be committed, pushed, PR'd and green in git while production stays
//      broken, because deploying it is a manual copy nobody scheduled.
//      unstamped-runlog-reopen-sweep probes the INSTALLED script; it was red for 8
//      consecutive runs (17:17 -> 18:32) against a branch that was green the whole time, and
//      the run that shipped it recorded "turns green when 192 lands". That is false: merging
//      to main does not write to installed-plugins. Nothing would have turned it green.
//   2. BACKWARD: a plugin reinstall/update would overwrite the hand-deployed file with main's
//      copy and silently REVERT both reopen fixes, with no detector to notice.
//
// VERDICTS
//   MAIN         the installed bytes match origin/main. Fine.
//   BRANCH-ONLY  they match some other ref but not main -- a live fix that is backed up (it is
//                pushed) but that a reinstall would revert. A finding, severity "revert risk".
//   UNVERSIONED  they match no ref at all -- not recoverable from git. A finding, severity
//                "no backup". Same rationale repo-drift-sweep uses to rank an open-PR file as
//                backed-up rather than lost: reachable-from-a-ref is the line that matters.
//
// GUARDS (each must be load-bearing; see mutcheck-installed-skill-drift.mjs)
//   g1 template-exclusion: the bundled user-settings.md is a PLACEHOLDER by design -- SKILL.md
//      says so and the real settings live in OneDrive. It matches 13 stale branches and no
//      main, so without this guard the sweep reports permanent BRANCH-ONLY noise on a file
//      nobody should ever deploy from. Excluding it is a conscious exclusion, printed, not a
//      silent skip.
//   g2 newline-normalisation: these files round-trip through OneDrive and Windows editors.
//      Comparing raw bytes reports every file as drifted. This is the same CRLF trap that made
//      the 17:00 run's first RunLogRe a silent no-op, so it is guarded deliberately.
// NOT a guard, deliberately: main-first precedence. A file on main AND on a side branch must
//   report MAIN, and the `both` case in mutcheck-installed-skill-drift.mjs asserts it. It is
//   NOT in the mutant list, because it cannot be isolated by mutation: main is reachable under
//   two names (origin/main and the local main), so every main-matching file has >= 2 hits and
//   any inversion of the precedence breaks onMain and crlf as well as both. The harness said
//   so out loud -- neutering it broke 3 of 6 cases. Per the standing rule, a change that breaks
//   everything is the MATCHER, not a guard; calling it one would have certified matcher logic
//   as a safety property. Its correctness is evidenced by the baseline case instead.
//
// exit 1 = findings.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

const REPO =
  process.env.OA_REPO || 'V:\\repos\\focus-planner';
const INSTALLED =
  process.env.OA_INSTALLED_PLUGIN ||
  join(homedir(), '.copilot', 'installed-plugins', 'focus-planner');
// Path prefix inside the repo that the installed tree maps onto.
const REPO_PREFIX = process.env.OA_REPO_PREFIX || 'plugins';

// g1: files that are bundled templates, not deployable artifacts.
const TEMPLATES = new Set(['user-settings.md']);

const EXTS = new Set(['.ps1', '.md', '.json', '.mjs', '.js']);

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

// g2: compare content, not bytes. Normalise CRLF and a trailing-newline difference, which is
// all that separates a OneDrive round-trip from a real edit.
function norm(text) {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

function blobIdOf(text) {
  return git(['hash-object', '--stdin'], { input: norm(text) }).trim();
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else {
      const dot = name.lastIndexOf('.');
      if (dot > 0 && EXTS.has(name.slice(dot))) out.push(p);
    }
  }
  return out;
}

if (!existsSync(INSTALLED)) {
  console.log(`installed plugin not found: ${INSTALLED}`);
  console.log('\nnothing to check.');
  process.exit(0);
}

const files = walk(INSTALLED).sort();

// Every ref we consider a backup: origin/main first (g3), then all local and remote heads.
const refs = ['origin/main'];
for (const line of git([
  'for-each-ref',
  '--format=%(refname:short)',
  'refs/heads',
  'refs/remotes',
]).split('\n')) {
  const r = line.trim();
  if (r && r !== 'origin/main' && !r.endsWith('/HEAD')) refs.push(r);
}

// One `git cat-file --batch-check` for every (ref, path) pair -- one process, not 126 per file.
const rows = files.map((abs) => {
  const rel = relative(INSTALLED, abs).split(sep).join('/');
  return { abs, rel, repoPath: `${REPO_PREFIX}/${rel}` };
});

const queries = [];
for (const r of rows) for (const ref of refs) queries.push(`${ref}:${r.repoPath}`);

let batch = '';
if (queries.length) {
  batch = git(['cat-file', '--batch-check=%(objectname) %(rest)'], {
    input: queries.join('\n') + '\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
// Map "ref:path" -> objectname (or null when missing).
const objOf = new Map();
{
  const lines = batch.split('\n').filter(Boolean);
  lines.forEach((line, i) => {
    const q = queries[i];
    const m = /^([0-9a-f]{40})\s/.exec(line);
    objOf.set(q, m ? m[1] : null);
  });
}

const findings = [];
const report = [];
const skipped = [];

for (const r of rows) {
  const base = r.rel.split('/').pop();
  if (TEMPLATES.has(base)) {
    skipped.push(r.rel);
    continue;
  }
  const want = blobIdOf(readFileSync(r.abs, 'utf8'));

  // Main-first precedence. See the note in the sweep header: this is matcher logic, not a
  // guard, so it is asserted by the `both` baseline case rather than by a mutant.
  const mainObj = objOf.get(`origin/main:${r.repoPath}`);
  if (mainObj && mainObj === want) {
    report.push({ rel: r.rel, verdict: 'MAIN', where: 'origin/main' });
    continue;
  }

  const hits = [];
  for (const ref of refs) {
    if (ref === 'origin/main') continue;
    if (objOf.get(`${ref}:${r.repoPath}`) === want) hits.push(ref);
  }

  if (hits.length) {
    const row = {
      rel: r.rel,
      verdict: 'BRANCH-ONLY',
      where: hits.slice(0, 3).join(', ') + (hits.length > 3 ? ` (+${hits.length - 3})` : ''),
    };
    report.push(row);
    findings.push(row);
  } else {
    const row = { rel: r.rel, verdict: 'UNVERSIONED', where: 'no ref' };
    report.push(row);
    findings.push(row);
  }
}

console.log(`installed plugin: ${INSTALLED}`);
console.log(`repo:             ${REPO}  (refs searched: ${refs.length})`);
console.log(`files checked:    ${report.length}` + (skipped.length ? `   bundled templates excluded: ${skipped.join(', ')}` : ''));
console.log('');
for (const row of report) {
  console.log(`  ${row.verdict.padEnd(12)} ${row.rel}    [${row.where}]`);
}

if (!findings.length) {
  console.log('\nno drift: every installed skill file is the version on main.');
  process.exit(0);
}

console.log(`\nFINDINGS: ${findings.length} installed file(s) are not the version on main`);
for (const f of findings) {
  if (f.verdict === 'BRANCH-ONLY') {
    console.log(
      `  ${f.rel}: live fix exists only on ${f.where} -- a plugin reinstall REVERTS it, ` +
        'and merging that branch does NOT deploy it (installed-plugins is written by hand).',
    );
  } else {
    console.log(
      `  ${f.rel}: matches no git ref -- the running agent is executing code that is not ` +
        'recoverable from git.',
    );
  }
}
process.exit(1);
