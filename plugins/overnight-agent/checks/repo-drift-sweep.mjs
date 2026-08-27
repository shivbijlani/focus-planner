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
  'deploy-installed-plugin.ps1',
];

/**
 * THE SECOND REGISTRY (added 2026-08-27)
 * --------------------------------------
 * `run-sweeps.ps1` answers "what runs tonight, unattended". It is not the only
 * roster. `user-settings.md` is the operating manual a future run reads and
 * executes from, and it names runnable files that no sweep imports and no
 * registry lists -- among them `fix-playwright-npx-slots.ps1`, the apply-script
 * Shiv is explicitly being asked to approve.
 *
 * Measured 2026-08-27: 30 live .mjs/.ps1 files sat outside the corpus, and
 * **25 of them were named in user-settings.md**. All 30 were untracked in every
 * git ref and absent from the archive. The previous run had recorded these as
 * "mostly genuine scratch (yt-*, ynab-*, cdp-*)" and deferred them as a scoping
 * question; that assessment was wrong, and it was wrong because nobody had
 * asked the file.
 *
 * This is the same defect the sweep already exists to catch, one level up, and
 * for the third time: (1) 70 files lived on one laptop; (2) `sync-checks
 * -Capture` enumerated the repo side, so a NEW check was structurally
 * uncapturable; (3) both tools then treated `run-sweeps.ps1` as *the* registry
 * while a second roster went unread.
 *
 * The fix applies this file's own stated principle -- derive the roster, never
 * keep a copy of it (see readRegistry below) -- to that second roster. A
 * filename token only counts if the file actually exists in OA home, so the
 * arm is grounded in reality rather than in prose.
 */
const SKILL_DIRS = [
  'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent',
  process.env.OA_SKILL_INSTALLED,
].filter(Boolean);

const SETTINGS_CANDIDATES = [
  process.env.OVERNIGHT_AGENT_SETTINGS,
  process.env.PLANNER_PATH ? path.join(process.env.PLANNER_PATH, 'user-settings.md') : null,
  process.env.OneDrive ? path.join(process.env.OneDrive, 'Apps', 'Focus Planner', 'user-settings.md') : null,
  path.join(OA, 'user-settings.md'),
].filter(Boolean);

/**
 * Filenames the manual tells a future run to execute.
 *
 * Returns three groups, because they are different defects:
 *   present   - named and living in OA home -> part of the asset, must be versioned.
 *   elsewhere - named and found, but outside OA home (the skill folder, a
 *               subdirectory like planner-ui\, or secrets\). Not this sweep's
 *               to archive -- installed-skill-drift-sweep covers the skill
 *               folder -- but emphatically NOT a dead pointer.
 *   dangling  - named and found nowhere. The manual points at a command that
 *               cannot be run.
 *
 * ⚠️ The `elsewhere` bucket is why this arm resolves a name against more than
 * OA home's root. The first cut checked the root only and declared 21 dangling
 * references, of which the majority were real files one directory away --
 * `oa-state.ps1` (the skill's own state tool, named on nearly every page),
 * `telegram-secret.ps1` (secrets\), `cdp-step.mjs` (planner-ui\). A list that
 * is mostly false positives trains the reader to skip it, which is precisely
 * how the 6 crashed sweeps went unnoticed for weeks. Resolve before reporting.
 *
 * `dangling` is reported but never failed on: a 6,800-line file accumulated
 * over months will legitimately mention retired one-offs, and a detector that
 * goes red on its first night for something nobody intends to fix is a
 * detector nobody reads on its second.
 */
function docsReferenced() {
  const present = new Set();
  const elsewhere = new Map();
  const dangling = new Set();
  const source = SETTINGS_CANDIDATES.find((p) => fs.existsSync(p));
  if (!source) return { present, elsewhere, dangling, source: null };

  // Index every plausible home for a named command, once.
  const searchRoots = [OA, ...SKILL_DIRS.filter((d) => fs.existsSync(d))];
  const index = new Map(); // basename -> dir it was found in
  const skipDirs = new Set(['sweep-runs', 'state', 'node_modules', 'telegram-bridge', 'backups', 'logs']);
  for (const root of searchRoots) walk(root, 0);

  function walk(dir, depth) {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skipDirs.has(e.name.toLowerCase())) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (/\.(mjs|ps1)$/.test(e.name) && !e.name.includes('.bak')) {
        if (!index.has(e.name)) index.set(e.name, dir);
      }
    }
  }

  const text = fs.readFileSync(source, 'utf8');
  for (const m of text.matchAll(/([A-Za-z0-9._-]+\.(?:mjs|ps1))/g)) {
    const name = m[1];
    if (name.includes('.bak')) continue;
    if (fs.existsSync(path.join(OA, name))) present.add(name);
    else if (index.has(name)) elsewhere.set(name, index.get(name));
    else dangling.add(name);
  }
  return { present, elsewhere, dangling, source };
}

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

/**
 * Is this EXACT live content already committed at this path on some ref?
 *
 * `trackedAnywhere` applies the across-all-refs principle to EXISTENCE only.
 * The MODIFIED arm never got it, so it compared the live file against the one
 * ref this worktree happens to have checked out and called anything else drift.
 *
 * That is not hypothetical: on 2026-08-27 it reported `dropped-ask-sweep.mjs`
 * and `mutcheck-dropped-ask.mjs` as "live ahead (uncommitted)" while both were
 * committed, reviewed and open as PR #203 — a PR based on the very branch the
 * archive had checked out. Acting on that reading duplicated #203's change into
 * its own base branch, which would have collided when #203 merged. The file's
 * own recorded lesson applies: a fix made in one arm of a checker is evidence
 * the other arm is wrong, not evidence the problem is handled.
 *
 * Cost is paid only on the finding path — one `hash-object` plus the commits
 * that touch this single file (4, here), never the whole corpus.
 *
 * Returns the commit that carries the content, or null.
 */
function committedAtPathElsewhere(repoRoot, relPath, livePath) {
  try {
    const blob = execFileSync('git', ['-C', repoRoot, 'hash-object', livePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!blob) return null;
    const commits = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '--all', '--format=%H', '--', relPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const c of commits) {
      try {
        const at = execFileSync('git', ['-C', repoRoot, 'rev-parse', `${c}:${relPath}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (at === blob) return c;
      } catch {
        /* path absent in that commit */
      }
    }
  } catch {
    /* no git, or unreadable — fall through to reporting drift, the safe direction */
  }
  return null;
}

/** Which ref names contain a commit — so the report can name where the content lives. */
function refsContaining(repoRoot, commit) {
  try {
    return execFileSync(
      'git',
      ['-C', repoRoot, 'for-each-ref', '--format=%(refname:short)', '--contains', commit],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
  } catch {
    return [];
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

  // The second registry: everything the operating manual names as runnable.
  const docs = docsReferenced();
  const addedByDocs = [];
  for (const d of docs.present) {
    if (!corpus.has(d)) addedByDocs.push(d);
    corpus.add(d);
  }

  const unversioned = [];
  const elsewhere = [];
  const modified = [];
  const elsewhereContent = [];
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
      // Diverged from THIS worktree — but the live bytes may already be committed
      // on another ref (typically an open PR stacked on the checked-out branch).
      // That is backed up, not drift, and reporting it invites a duplicate commit.
      const relPath = path.relative(repoRoot, archived).replace(/\\/g, '/');
      const at = committedAtPathElsewhere(repoRoot, relPath, live);
      if (at) {
        elsewhereContent.push({ file, commit: at.slice(0, 7), refs: refsContaining(repoRoot, at) });
        continue;
      }
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
  if (docs.source) {
    console.log(
      `manual: ${docs.source} -> ${docs.present.size} named runnable file(s), ${addedByDocs.length} not otherwise in the corpus`
    );
  } else {
    console.log('manual: NOT FOUND - the user-settings.md arm is not running.');
  }
  console.log(`in sync: ${ok.length}`);

  if (addedByDocs.length) {
    console.log(`\nnamed by the manual, not by any registry: ${addedByDocs.length}`);
    for (const f of addedByDocs.sort()) console.log(`  - ${f}`);
  }

  if (docs.dangling.size) {
    console.log(
      `\ndangling references in the manual (named, found nowhere): ${docs.dangling.size} (informational)`
    );
    for (const f of [...docs.dangling].sort()) console.log(`  - ${f}`);
  }
  if (docs.elsewhere.size) {
    console.log(
      `\nnamed by the manual, resolved outside OA home: ${docs.elsewhere.size} (not this sweep's to archive)`
    );
  }

  if (elsewhere.length) {
    console.log(
      `\nversioned in another ref, not on this branch: ${elsewhere.length} (backed up - not a finding)`
    );
    for (const f of elsewhere) console.log(`  - ${f}`);
  }

  if (elsewhereContent.length) {
    console.log(
      `\nlive content committed on another ref, not on this branch: ${elsewhereContent.length} (backed up - not a finding)`
    );
    for (const e of elsewhereContent) {
      const where = e.refs.length ? e.refs.join(', ') : 'unnamed ref';
      console.log(`  - ${e.file}  ${e.commit}  [${where}]`);
    }
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
