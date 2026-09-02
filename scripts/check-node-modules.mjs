// check-node-modules.mjs -- turn "the shared install was emptied" into an immediate,
// self-explaining failure instead of a confusing one somewhere else later.
//
// GH #321: `git worktree remove --force` deletes THROUGH a `node_modules` junction,
// emptying the shared install for the main checkout and every other worktree at
// once. Reproduced in an isolated sandbox on 2026-09-02:
//
//     shared node_modules top-level entries: before=4 after=0
//     git exit code: 0
//
// The wreckage it leaves is the reason this file exists: `node_modules` STILL
// EXISTS, it is simply empty. Every existence check -- `fs.existsSync`,
// `Test-Path`, `[ -d node_modules ]` -- is TRUE for it. So the next command to run
// fails as "'vitest' is not recognized" or a partial suite, which reads like a
// broken change rather than a missing toolchain. That misattribution is what cost
// a run, and it is what this check ends.
//
// Wired as `pretest`, so the explanation arrives at the moment of breakage.
//
// DELIBERATELY NOT AN ERROR WHEN ABSENT. A missing `node_modules` is just "npm ci
// has not run yet", and npm already says so clearly. Failing on that would make
// this guard noise, and a noisy guard gets deleted. Only the Empty state -- the
// exact #321 signature -- is a failure.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Classify a node_modules directory. The three states are distinct on purpose:
 * collapsing Empty into Populated (existence-only) is the bug, and collapsing it
 * into Missing would blame the user for something that was done to them.
 */
export function classifyNodeModules(dir, io = fs) {
  let entries;
  try {
    entries = io.readdirSync(dir);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { state: 'missing', count: 0 };
    }
    return { state: 'unreadable', count: -1, error: String(err && err.message) };
  }
  return { state: entries.length > 0 ? 'populated' : 'empty', count: entries.length };
}

/** Human-readable verdict. `ok:false` only for the #321 signature. */
export function buildReport({ state, count }, dir) {
  switch (state) {
    case 'populated':
      return { ok: true, quiet: true, message: `node_modules ok (${count} top-level entries)` };
    case 'missing':
      return {
        ok: true,
        quiet: false,
        message: `node_modules is absent at ${dir} - run \`npm ci\` first.`,
      };
    case 'unreadable':
      return { ok: true, quiet: false, message: `node_modules at ${dir} could not be read.` };
    default:
      return {
        ok: false,
        quiet: false,
        message: [
          '',
          `  node_modules EXISTS BUT IS EMPTY: ${dir}`,
          '',
          '  This is the GH #321 signature: something deleted through a junction into',
          '  this directory, most likely `git worktree remove --force` run against a',
          '  worktree that junctioned its node_modules here.',
          '',
          '  Nothing you changed is broken. Fix it with:   npm ci',
          '',
          '  To stop it happening again, tear worktrees down with:',
          '    pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path <worktree>',
          '',
        ].join('\n'),
      };
  }
}

export function checkNodeModules(repoRoot, io = fs) {
  const dir = path.join(repoRoot, 'node_modules');
  return { dir, ...buildReport(classifyNodeModules(dir, io), dir) };
}

// Only run as a CLI, so the pure functions above stay importable by the tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const root = process.argv[2] || process.cwd();
  const report = checkNodeModules(root);
  if (!report.ok) {
    console.error(report.message);
    process.exit(1);
  }
  if (!report.quiet) console.log(report.message);
}
