#!/usr/bin/env node
/**
 * version-bump-sweep.mjs — "merged" only means "running" if the version moved.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shiv, on task #448 (2026-08-31):
 *
 *   > "Yr making these overnight agent fixes are you bumping the version? It still
 *   >  says 1.3.1. Yr fixes will only be applied if the version is updated, the
 *   >  overnight agent watchdog runs and detects it needs to update version. Then
 *   >  it goes and updates the plugin."
 *
 * He was right, and the interesting part is WHY it was missed. There are **two**
 * update mechanisms with two different definitions of "current":
 *
 *   auto-deploy-plugin.ps1  compares FILE CONTENT  -> copies everything, and then
 *                           truthfully reports `verified-current True`
 *   the watchdog / CLI      compares plugin.json's VERSION -> sees an unchanged
 *                           version and correctly decides it has nothing to do
 *
 * So a change can be fully deployed by one and completely invisible to the other,
 * and **the blind one reports success**. That is the same shape as every other
 * "merged isn't running" bug in this repo (#196, #151): a gap between two
 * components that is silent in the safe-looking direction.
 *
 * Nothing FAILS when you merge without bumping. That is precisely why it slipped
 * past, and why it needed a human to notice. A promise to remember would regress;
 * this codebase's own repeated lesson is that a rule kept as prose regresses and a
 * rule kept as an executable check does not. Hence a check, not a note.
 *
 * PROOF IT IS NOT HYPOTHETICAL
 * ----------------------------
 * Written 2026-08-31, immediately after the bump-to-1.5.0 conversation, against
 * live `main`:
 *
 *   ba598a6  (#282)  bumped version -> 1.5.0
 *   4f68818  (#283)  changed skills/overnight-agent/oa-state.ps1   <-- NO bump
 *
 * `oa-state.ps1` is the state engine that decides which tasks are eligible. It
 * shipped to `main` still labelled 1.5.0, so a version-keyed updater would skip
 * it. The defect recurred within hours of being discussed, on the very next merge.
 *
 * THE FINDING
 * -----------
 *   UNBUMPED   one or more tracked files under plugins/overnight-agent/ changed in
 *              commits AFTER the commit that last changed plugin.json's `version`.
 *
 * WHY "LAST BUMP" IS FOUND BY VALUE, NOT BY TOUCH
 * -----------------------------------------------
 * Looking for "the last commit that touched plugin.json" would be wrong: #279 and
 * #280 both touched plugin.json without the version necessarily moving, and a
 * commit editing `description` or `keywords` is not a release. This walks
 * plugin.json's own history and compares the PARSED `version` against the same
 * field in that commit's first parent, so only a genuine value change counts.
 *
 * WHY IT REFUSES TO PASS WHEN IT CANNOT MEASURE
 * ---------------------------------------------
 * If the repo cannot be located, this exits 1 (a finding) rather than 0. The
 * failure this suite keeps re-learning is "a roster that reports all clean while
 * structurally blind to part of itself" -- six sweeps once silently measured
 * nothing on an unset BRIDGE_SRC. A check that cannot see must say so out loud.
 *
 * Everything goes to stdout: run-sweeps.ps1 classifies any stderr output as CRASH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = 'plugins/overnight-agent';
const PLUGIN_JSON = `${PLUGIN_DIR}/plugin.json`;

/** git, captured. Returns null on any non-zero exit so callers can branch. */
function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function isRepoWithPlugin(dir) {
  if (!dir) return false;
  try {
    if (!fs.existsSync(path.join(dir, PLUGIN_JSON.split('/').join(path.sep)))) return false;
    return git(dir, ['rev-parse', '--git-dir']) !== null;
  } catch {
    return false;
  }
}

/**
 * Locate the checkout. Explicit env wins; then walk up from this script (which
 * works when running from the repo); then the known checkout, because the suite
 * normally runs from the flat OA home where no ancestor is a repo.
 */
function resolveRepo() {
  if (process.env.OA_PLUGIN_REPO) {
    const p = process.env.OA_PLUGIN_REPO;
    return isRepoWithPlugin(p) ? p : null;
  }
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (let i = 0; i < 6; i++) {
    if (isRepoWithPlugin(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of ['V:\\repos\\focus-planner', '/v/repos/focus-planner']) {
    if (isRepoWithPlugin(c)) return c;
  }
  return null;
}

/**
 * Which commit to measure. Default HEAD, so an ad-hoc run and CI both behave as before.
 *
 * WHY THIS IS A PARAMETER (measured 2026-09-04, and it was reporting confident nonsense)
 * -------------------------------------------------------------------------------------
 * The nightly suite runs from the flat OA home, so `resolveRepo()` falls through to the
 * known checkout `V:\repos\focus-planner` -- a WORKING TREE that nothing updates. On
 * 2026-09-04 it sat at `0e7e372`, ELEVEN commits behind `origin/main`, so the sweep read
 * `1.18.0 / 9 commits` while the shipped truth at `779703b` was `1.19.0 / 0`. It was
 * answering a question nobody asked, about a tree nobody runs.
 *
 * That direction is the dangerous one. A stale tree can never observe the bump that fixes
 * it, so the finding is PERMANENTLY red and no correct action can clear it -- which
 * desensitises the signal and gets the detector switched off. This file's own header
 * argues the opposite failure ("a check that cannot see must not report clean"); this is
 * the same rule on the other side, because a check that reports a confident WRONG red is
 * no better. It is #461 exactly: a check resolving its root to the wrong tree and
 * reporting about files it never opened.
 *
 * So the two callers now say what they mean, rather than both inheriting a default that is
 * right for only one of them:
 *
 *   CI  (`plugin-version-bump`)  OA_PLUGIN_REF=HEAD        gate THIS pull request
 *   nightly (`run-sweeps.ps1`)   OA_PLUGIN_REF=origin/main gate WHAT IS SHIPPED
 *
 * An unresolvable ref is a finding, not a pass, for the reason above.
 */
function resolveRef(repo) {
  const want = (process.env.OA_PLUGIN_REF || 'HEAD').trim();

  // A remote-tracking ref is only as fresh as the last fetch, so measuring `origin/main`
  // without fetching just MOVES the staleness rather than removing it -- the same defect
  // one layer out, and the layer where it would be invisible. Callers that measure a
  // remote ref therefore ask for the fetch explicitly.
  //
  // A FAILED FETCH IS NOT A PASS. Offline, or a dead remote, means the ref on disk is of
  // unknown age, and reporting `OK` from it is the false-green this whole file exists to
  // prevent. It degrades to NOT MEASURED (exit 1) instead, which is the direction #346
  // and this sweep's own "cannot see must not report clean" rule both demand.
  if (process.env.OA_PLUGIN_FETCH === '1' && want.includes('/')) {
    const [remote, ...rest] = want.split('/');
    const branch = rest.join('/');
    if (git(repo, ['fetch', '--quiet', remote, branch]) === null) {
      return { want, sha: null, stale: `could not fetch ${remote}/${branch}` };
    }
  }

  const sha = (git(repo, ['rev-parse', want]) || '').trim();
  return { want, sha: sha || null };
}

/**
 * Is this checkout behind the ref we are measuring? Reported even when the measurement is
 * otherwise fine, because "the number is right but the tree is stale" is the state that
 * produced the wrong answer above, and it is invisible from the output otherwise.
 */
function behindBy(repo, sha) {
  const out = git(repo, ['rev-list', '--count', `HEAD..${sha}`]);
  const n = Number((out || '').trim());
  return Number.isFinite(n) ? n : 0;
}

function versionAt(repo, commit) {
  const raw = git(repo, ['show', `${commit}:${PLUGIN_JSON}`]);
  if (raw === null) return null; // file absent at that commit
  try {
    const v = JSON.parse(raw).version;
    return typeof v === 'string' ? v : null;
  } catch {
    // A malformed plugin.json in history must not crash the sweep.
    const m = raw.match(/"version"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  }
}

function lines(out) {
  return (out || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * The commit that last CHANGED the version value, walking first-parent history.
 * First-parent is correct here: PRs land on main as single squash commits, so
 * first-parent is the release history. Returns { commit, from, to } or null.
 */
function lastBump(repo, head) {
  const touched = lines(git(repo, ['log', '--first-parent', '--format=%H', head, '--', PLUGIN_JSON]));
  for (const c of touched) {
    const cur = versionAt(repo, c);
    const parents = lines(git(repo, ['rev-list', '--parents', '-n', '1', c])); // "<sha> <p1> <p2>..."
    const parent = parents.length ? parents[0].split(/\s+/)[1] : undefined;
    const prev = parent ? versionAt(repo, parent) : null;
    if (cur !== prev) return { commit: c, from: prev, to: cur };
  }
  return null;
}

function short(repo, c) {
  return (git(repo, ['rev-parse', '--short', c]) || c).trim();
}

function subject(repo, c) {
  return (git(repo, ['log', '-1', '--format=%s', c]) || '').trim();
}

// --- run ---------------------------------------------------------------------

const repo = resolveRepo();

if (!repo) {
  console.log('version-bump-sweep: CANNOT MEASURE - no focus-planner checkout found.');
  console.log('  set OA_PLUGIN_REPO to the checkout root.');
  console.log('  Reporting this as a finding rather than passing: a check that cannot');
  console.log('  see must not report clean.');
  process.exit(1);
}

const ref = resolveRef(repo);
if (!ref.sha) {
  console.log('version-bump-sweep: NOT MEASURED - the ref could not be resolved.');
  console.log(`  ref  : ${ref.want}`);
  console.log(`  repo : ${repo}`);
  if (ref.stale) console.log(`  why  : ${ref.stale}`);
  console.log('  Reporting this as a finding rather than passing: a check that cannot');
  console.log('  see must not report clean, and a ref of unknown age is not seeing.');
  process.exit(1);
}

const head = ref.sha;
const headVersion = versionAt(repo, head);
const bump = lastBump(repo, head);
const behind = behindBy(repo, head);

console.log(`repo            : ${repo}`);
console.log(`ref             : ${ref.want}`);
console.log(`head            : ${short(repo, head)}`);
console.log(`plugin version  : ${headVersion ?? '(unreadable)'}`);
if (behind > 0) {
  console.log(`stale checkout  : this working tree is ${behind} commit(s) behind ${ref.want};`);
  console.log(`                  measuring ${ref.want}, not the tree.`);
}

if (!bump) {
  console.log('last version bump: NONE FOUND in history');
  console.log('');
  console.log('FLAGGED - plugin.json has no version-change commit, so nothing can be');
  console.log('compared against. Treated as a finding, not a pass.');
  process.exit(1);
}

console.log(`last bump       : ${short(repo, bump.commit)}  ${bump.from ?? '(none)'} -> ${bump.to}  ${subject(repo, bump.commit)}`);

// Commits after the bump that touch the plugin at all.
const since = lines(git(repo, ['log', '--first-parent', '--format=%H', `${bump.commit}..${head}`, '--', PLUGIN_DIR]));

// Files changed across that whole range. plugin.json can legitimately appear here
// -- a commit editing `description` or `keywords` changes deployed content without
// changing the version, and that is a real finding, not a bookkeeping artifact.
//
// This is deliberately computed unconditionally rather than guarded by
// `since.length`. With that short-circuit the two pathspecs masked each other:
// removing either one alone still produced the right verdict, so neither was
// independently load-bearing and a future edit could have deleted one silently.
// Proven by mutcheck-version-bump.mjs, which is how the redundancy was found.
const files = lines(git(repo, ['diff', '--name-only', `${bump.commit}..${head}`, '--', PLUGIN_DIR]));

console.log(`commits since   : ${since.length}`);
console.log(`files changed   : ${files.length}`);
console.log('');

if (!files.length) {
  console.log('OK - nothing under the plugin has changed since the last version bump.');
  process.exit(0);
}

console.log(`FLAGGED - plugin content changed WITHOUT a version bump: ${files.length} file(s)`);
console.log('');
console.log('  The installed copy is keyed off plugin.json\'s version, so a version-based');
console.log('  updater sees no work to do and these changes never reach the running agent.');
console.log('');
for (const c of since) {
  console.log(`  ${short(repo, c)}  ${subject(repo, c)}`);
}
console.log('');
for (const f of files) {
  console.log(`    ${f}`);
}
console.log('');
console.log(`  Fix: bump "version" in ${PLUGIN_JSON} (currently ${headVersion ?? '?'}) and commit it.`);
process.exit(1);
