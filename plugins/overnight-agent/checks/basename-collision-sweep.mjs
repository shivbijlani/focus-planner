// basename-collision-sweep.mjs
//
// GUARDS: no two deployable scripts under plugins/overnight-agent/ may share a basename.
//
// WHY THIS EXISTS
// ---------------
// sync-oa-home.ps1 deploys into a FLAT directory (%LOCALAPPDATA%\overnight-agent\), so it
// indexes the repo by BASENAME. When one basename resolves to two repo paths it cannot say
// which one a live file is, and it refuses -- correctly, because guessing would overwrite a
// file with an unrelated one. The refusal is the safe behaviour. The problem is that it is
// also PERMANENT: a naming collision cannot resolve itself, so those files are frozen in the
// OA home and a fix merged to main can never reach the copy that actually runs.
//
// Measured 2026-08-29 (#251): `mutcheck-turn-ask.ps1` and `mutcheck-write-turn.ps1` each
// existed at two paths and were refused on EVERY run. Both are guards -- and a guard that
// cannot be updated fails in the quiet direction: it keeps passing, against the wrong
// version. sync-oa-home deliberately does not escalate an ambiguous basename to exit 2
// (it would pin the exit code at 2 forever and train the reader to ignore it), and it is
// right not to. That is exactly why the condition needs a detector at the SOURCE layer,
// where it is a repo defect with a real fix, rather than at the deploy layer where it is
// only ever a symptom. This sweep is that detector.
//
// GUARDS (each must be load-bearing; see mutcheck-basename-collision.mjs)
//
//   g1 NAME-ONLY VERDICT: a collision is a finding even when the two copies are byte
//      identical. This is the guard most likely to be "simplified" away, because reporting
//      identical files feels like noise. It is not: sync-oa-home refuses on the NAME, before
//      it ever compares content. `mutcheck-turn-ask.ps1`'s two copies were identical and were
//      refused on every single run for exactly as long as the differing pair was. A sweep that
//      only flagged differing copies would have reported this repo CLEAN while one of the two
//      frozen guards stayed frozen.
//
//   g2 ENCODING-NORMALISED COMPARISON: decide IDENTICAL vs DIVERGENT on text with the BOM
//      stripped and newlines LF-normalised, never on raw bytes. Two real instances of this
//      false-difference class showed up while writing this sweep, which is why the guard is
//      wider than "handle CRLF":
//        - #251's issue body tabulated the turn-ask copies as differing (078B76EECA vs
//          E2AC074832). Those hashes were taken over raw bytes.
//        - This sweep's own first cut then called the same pair DIVERGENT -- because the two
//          copies differ by exactly three bytes, a UTF-8 BOM (EF BB BF), and nothing else.
//          Same LF endings, same 66 lines, same text.
//      A BOM is an encoding artifact, not content. The misreading is not cosmetic: DIVERGENT
//      says "a human must choose which version survives" while IDENTICAL says "delete either
//      one", and the first framing turns a safe deletion into a merge nobody needs to do.
//      Caught only because an independent measurement disagreed with the sweep and the
//      disagreement was chased instead of dismissed.
//
//   g3 DOCS EXCLUDED, AND SAID SO: two README.md files are legitimate -- a directory is allowed
//      to document itself, and sync-oa-home deploys scripts, not prose. Flagging them would be
//      permanent unfixable noise, which is the alarm-fatigue failure this codebase has already
//      hit from the other direction. The exclusion is PRINTED rather than silent, so nobody has
//      to read this file to find out what was skipped.
//
// Exit: 0 no collisions - 1 at least one collision (or the tree could not be read).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'plugins/overnight-agent';

// The classes sync-oa-home actually deploys into the flat home. `.md` is deliberately absent
// (g3) -- see the header.
const DEPLOYABLE = new Set(['.ps1', '.mjs', '.js']);

// Locate the repo. This sweep runs from two places -- the repo checkout and the flat OA
// home (%LOCALAPPDATA%\overnight-agent), which is not a git repo at all -- so "walk up from
// me" alone is wrong in exactly the same way the hard-coded paths this sweep exists to
// police are wrong. Order: explicit env, then walk up for a .git, then the known checkout.
// The candidate must actually contain plugins/overnight-agent, so a wrong guess fails loudly
// here rather than reporting a clean tree it never read.
function hasPrefix(root) {
  return !!root && fs.existsSync(path.join(root, PREFIX.split('/').join(path.sep)));
}

function walkUpForRepo(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, '.git')) && hasPrefix(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function repoRoot() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const candidates = [
    process.env.OA_REPO,
    walkUpForRepo(here),
    'V:\\repos\\focus-planner',
  ];
  for (const c of candidates) {
    if (hasPrefix(c)) return c;
  }
  return null;
}

function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', `${PREFIX}/`], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// g2: strip the encoding artifacts that make an identical script look different -- a leading
// UTF-8 BOM and CRLF endings -- then trim trailing whitespace. What is left is the content a
// human would have to reconcile, which is the only thing the verdict should turn on.
function normalised(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
}

function main() {
  const root = repoRoot();
  if (!root) {
    console.error(`[basename-collision] cannot locate a checkout containing ${PREFIX}/. Set OA_REPO.`);
    process.exit(1);
  }
  let files;
  try {
    files = trackedFiles(root);
  } catch (err) {
    console.error(`[basename-collision] cannot list tracked files under ${PREFIX}/: ${err.message}`);
    process.exit(1);
  }

  const deployable = files.filter((f) => DEPLOYABLE.has(path.extname(f).toLowerCase()));
  const excluded = files.length - deployable.length;

  console.log(`[basename-collision] repo   = ${root}`);
  console.log(`[basename-collision] scope  = ${PREFIX}/ (${deployable.length} deployable files)`);
  // g3: say what was skipped rather than skipping it quietly.
  console.log(`[basename-collision] skipped ${excluded} non-deployable file(s) (docs/other); sync-oa-home deploys ${[...DEPLOYABLE].join(', ')} only.`);

  const byName = new Map();
  for (const f of deployable) {
    const n = path.basename(f);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f);
  }

  const findings = [];
  for (const [name, paths] of [...byName.entries()].sort()) {
    if (paths.length < 2) continue;
    // g1: the collision itself is the finding. Content only sets the severity/remedy.
    const texts = paths.map((p) => normalised(root, p));
    const allSame = texts.every((t) => t !== null && t === texts[0]);
    findings.push({ name, paths, verdict: allSame ? 'IDENTICAL' : 'DIVERGENT' });
  }

  console.log('');
  if (findings.length === 0) {
    console.log('[basename-collision] PASS - 0 collisions; every deployable basename resolves to one path.');
    process.exit(0);
  }

  for (const f of findings) {
    const remedy = f.verdict === 'IDENTICAL'
      ? 'copies are the same file - delete the one whose directory does not own it'
      : 'copies DIFFER - promote the canonical one, then delete the other (never let the sync pick a winner)';
    console.log(`  COLLISION  ${f.name}  [${f.verdict}] - ${remedy}`);
    for (const p of f.paths) console.log(`               ${p}`);
  }
  console.log('');
  console.log(`[basename-collision] FAIL - ${findings.length} collision(s). sync-oa-home.ps1 refuses these on every run, so they are frozen in the OA home.`);
  console.log('[basename-collision] Ownership is declared in checks/sync-checks.ps1 ($skillOwned) and checks/repo-drift-sweep.mjs (SKILL_OWNED).');
  process.exit(1);
}

main();
