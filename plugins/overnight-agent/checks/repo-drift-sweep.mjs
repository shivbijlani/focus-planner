#!/usr/bin/env node
/**
 * repo-drift-sweep.mjs — the check that keeps the other 37 checks alive.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-26 a run measured the thing user-settings.md had only ever asserted:
 * of the 73 files that make up the nightly enforcement suite, **70 existed in
 * exactly one place** — `%LOCALAPPDATA%\overnight-agent` on one laptop. No git
 * history, no backup, not even in OneDrive. That included every one of the 37
 * detectors, all 6 shared libs, all 19 mutation checks, and *both* safety
 * wrappers — `run-sweeps.ps1` (which exists because six sweeps once silently
 * measured nothing) and `run-telegram-mirror.ps1` (which exists because
 * forgetting it floods Shiv's Telegram irreversibly).
 *
 * Copying them into the repo fixes that once. It does not keep it fixed: the
 * agent writes new sweeps into LOCALAPPDATA most nights, and a copy that nobody
 * checks is stale within a day. That is the exact failure shape this codebase
 * keeps re-learning — a rule kept as prose regresses, a rule kept as an
 * executable check does not.
 *
 * So this sweep asks one question every night: **is every file the live suite
 * actually depends on present in git, and identical to what is running?**
 *
 * THE THREE FINDINGS
 * ------------------
 *   UNVERSIONED  a file the live registry depends on that is in no archive.
 *                This is the arm that prevents recurrence: a sweep written
 *                tonight and never committed is caught tomorrow morning.
 *   MODIFIED     archived and live copies have diverged. Direction is reported,
 *                because "live is ahead" (uncommitted work) and "repo is ahead"
 *                (undeployed work) need opposite fixes.
 *   ORPHANED     archived but no longer referenced by the live registry.
 *                Informational only — a retired sweep is not a defect, but a
 *                silently vanished one should still be visible.
 *
 * WHY CONTENT IS COMPARED NORMALIZED
 * ----------------------------------
 * The repo has `core.autocrlf=true` and no `.gitattributes`, so git stores LF
 * and checks out CRLF. A byte-for-byte hash would therefore report every single
 * file as MODIFIED on a fresh clone — a detector that cries wolf on 70 files is
 * a detector that gets switched off in a week. Comparison normalizes line
 * endings and trailing whitespace, which is the only difference git is allowed
 * to introduce. Anything else is real drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const OA = process.env.OA_HOME || path.join(process.env.LOCALAPPDATA || '', 'overnight-agent');

// Candidate archive roots. Explicit env wins; otherwise probe the known checkout.
const CHECKS_REPO = process.env.OA_CHECKS_REPO || firstExisting([
  'V:\\repos\\focus-planner\\plugins\\overnight-agent\\checks',
  'V:\\repos\\focus-planner.worktrees\\oa-version-the-checks\\plugins\\overnight-agent\\checks',
]);

// Three files deliberately ship with the skill itself rather than in checks/,
// because the harness loads them from the skill folder.
const SKILL_REPO = process.env.OA_SKILL_REPO || firstExisting([
  'V:\\repos\\focus-planner\\plugins\\overnight-agent\\skills\\overnight-agent',
  'V:\\repos\\focus-planner.worktrees\\oa-version-the-checks\\plugins\\overnight-agent\\skills\\overnight-agent',
]);

const SKILL_OWNED = new Set([
  'write-turn.ps1',
  'mutcheck-write-turn.ps1',
  'reap-stale-mcp.ps1',
  'oa-state.ps1',
]);

// Orchestration is part of the asset even though no sweep imports it.
const ORCHESTRATION = [
  'run-sweeps.ps1',
  'run-telegram-mirror.ps1',
  'reap-stale-mcp.ps1',
  'check-browser-slots.ps1',
  'write-turn.ps1',
  'artifact-index.mjs',
  'sync-checks.ps1',
];

function firstExisting(paths) {
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * Every path ever tracked under the plugin, across ALL refs — not just the ref
 * this worktree happens to have checked out.
 *
 * Without this the sweep answers the wrong question. `write-turn.ps1` lives in
 * open PR #193; it is fully backed up and has history, but it is not on `main`,
 * so a working-tree-only check calls it UNVERSIONED and reports a file loss
 * that did not happen. A detector whose headline finding is wrong on its first
 * night is a detector nobody reads on its second. One `git log --all` scoped to
 * the plugin directory costs ~450 ms and answers "is this in version control?"
 * exactly.
 */
function trackedAnywhere(repoRoot) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '--all', '--name-only', '--pretty=format:', '--', 'plugins/overnight-agent/'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((p) => path.basename(p))
    );
  } catch {
    // No git, or not a repo. Fall back to working-tree-only comparison rather
    // than failing the whole sweep.
    return null;
  }
}

function norm(text) {
  // Strip a UTF-8 BOM, normalize CRLF -> LF, drop trailing whitespace per line
  // and at EOF. These are exactly the transforms git/autocrlf may apply.
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function hash(text) {
  return crypto.createHash('sha256').update(norm(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The registry is `run-sweeps.ps1` itself, not a list maintained here. If this
 * file kept its own copy of the roster it would be one more thing to forget to
 * update — the same class of bug the sweep is built to catch.
 */
function readRegistry() {
  const p = path.join(OA, 'run-sweeps.ps1');
  if (!fs.existsSync(p)) {
    console.error(`FATAL: no run-sweeps.ps1 at ${p} - cannot determine the corpus.`);
    process.exit(2);
  }
  const src = fs.readFileSync(p, 'utf8');
  const suite = [...src.matchAll(/@\{\s*n\s*=\s*'([^']+)'/g)].map((m) => m[1]);
  const exBlock = src.match(/\$Excluded\s*=\s*@\(([^)]*)\)/);
  const excluded = exBlock ? [...exBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  if (suite.length === 0) {
    console.error('FATAL: parsed 0 sweeps out of run-sweeps.ps1 - the registry format changed.');
    process.exit(2);
  }
  return { suite, excluded };
}

/** Walk local imports transitively so a lib can never be left behind. */
function closure(entryFiles) {
  const seen = new Set();
  const stack = [...entryFiles];
  while (stack.length) {
    const file = stack.pop();
    const base = path.basename(file);
    if (seen.has(base)) continue;
    if (!fs.existsSync(file)) continue;
    seen.add(base);
    const src = fs.readFileSync(file, 'utf8');
    const specs = [
      ...[...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const s of specs) {
      if (!s.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), s);
      if (fs.existsSync(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

function main() {
  if (!CHECKS_REPO) {
    console.error('FATAL: no archive directory found. Set OA_CHECKS_REPO.');
    process.exit(2);
  }

  const { suite, excluded } = readRegistry();

  const entries = [...suite, ...excluded].map((n) => path.join(OA, `${n}.mjs`));
  const mutchecks = fs
    .readdirSync(OA)
    .filter((f) => /^mutcheck-.*\.(mjs|ps1)$/.test(f) && !f.includes('.bak'));
  for (const m of mutchecks) entries.push(path.join(OA, m));

  const corpus = closure(entries);
  for (const m of mutchecks) corpus.add(m);
  for (const o of ORCHESTRATION) if (fs.existsSync(path.join(OA, o))) corpus.add(o);

  const unversioned = [];
  const elsewhere = [];
  const modified = [];
  const ok = [];

  // Walk up from the archive dir to the repo root so `git -C` has a real repo.
  const repoRoot = path.resolve(CHECKS_REPO, '..', '..', '..');
  const tracked = trackedAnywhere(repoRoot);

  for (const file of [...corpus].sort()) {
    const live = path.join(OA, file);
    if (!fs.existsSync(live)) continue;

    const archiveDir = SKILL_OWNED.has(file) && SKILL_REPO ? SKILL_REPO : CHECKS_REPO;
    let archived = path.join(archiveDir, file);

    // A skill-owned file may legitimately sit in either place; accept both
    // before declaring it unversioned.
    if (!fs.existsSync(archived) && fs.existsSync(path.join(CHECKS_REPO, file))) {
      archived = path.join(CHECKS_REPO, file);
    }

    if (!fs.existsSync(archived)) {
      // Absent from THIS worktree is not absent from git. Only a file in no ref
      // at all is genuinely at risk of being lost with the machine.
      if (tracked && tracked.has(file)) elsewhere.push(file);
      else unversioned.push(file);
      continue;
    }

    const a = hash(fs.readFileSync(live, 'utf8'));
    const b = hash(fs.readFileSync(archived, 'utf8'));
    if (a !== b) {
      const liveLen = norm(fs.readFileSync(live, 'utf8')).length;
      const repoLen = norm(fs.readFileSync(archived, 'utf8')).length;
      modified.push({
        file,
        direction: liveLen > repoLen ? 'live ahead (uncommitted)' : 'repo ahead (undeployed)',
        delta: liveLen - repoLen,
      });
    } else {
      ok.push(file);
    }
  }

  // Orphans: archived but no longer part of the live corpus.
  const archivedFiles = fs.existsSync(CHECKS_REPO)
    ? fs.readdirSync(CHECKS_REPO).filter((f) => /\.(mjs|ps1)$/.test(f))
    : [];
  const orphaned = archivedFiles.filter((f) => !corpus.has(f));

  console.log(`corpus (from the live run-sweeps.ps1 registry): ${corpus.size} files`);
  console.log(`archive: ${CHECKS_REPO}`);
  console.log(`in sync: ${ok.length}`);

  if (elsewhere.length) {
    console.log(
      `\nversioned in another ref, not on this branch: ${elsewhere.length} (backed up - not a finding)`
    );
    for (const f of elsewhere) console.log(`  - ${f}`);
  }

  if (orphaned.length) {
    console.log(`\norphaned in archive (retired or renamed): ${orphaned.length}`);
    for (const f of orphaned) console.log(`  - ${f}`);
  }

  const findings = unversioned.length + modified.length;
  if (findings === 0) {
    console.log('\nno drift: every file the live suite depends on is in git and identical.');
    process.exit(0);
  }

  if (unversioned.length) {
    console.log(`\nUNVERSIONED (exists only on this machine): ${unversioned.length}`);
    for (const f of unversioned) console.log(`  - ${f}`);
  }
  if (modified.length) {
    console.log(`\nMODIFIED (archived copy has diverged): ${modified.length}`);
    for (const m of modified) {
      console.log(`  - ${m.file}  ${m.direction}  ${m.delta > 0 ? '+' : ''}${m.delta} chars`);
    }
  }
  console.log(`\nFINDINGS: ${findings}`);
  process.exit(1);
}

main();
