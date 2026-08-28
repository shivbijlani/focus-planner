// lib-gh-refs.mjs — shared helpers for "does this ask point at a REAL, still-open PR/issue?"
//
// WHY THIS EXISTS (2026-08-26 12:30 PT)
// ------------------------------------
// All 41 existing detectors are text-over-journals: not one of them ever leaves the
// filesystem. So an ask that says **`merge 120`** is checked for its wording, its age, its
// markers and its truncation — but never for whether PR #120 still exists, is already
// merged, or was closed weeks ago.
//
// That is the "falsified premise" pattern this settings file has now recorded EIGHT times
// (2026-08-25 10:20, 10:45, 11:00, 2026-08-26 02:30 …). Every one of those was found by
// hand, one task at a time, because the outside world moved and no checker could see it.
//
// The cost is asymmetric and worse than an ordinary stale ask:
//   * A merged/closed PR makes the ask DEAD — Shiv is being asked for a decision that no
//     longer has an object, and it still occupies a slot in his phone digest.
//   * A WRONG number is actively dangerous: `merge` is on SKILL.md's irreversible list, so
//     a one-word "merge 120" against a mis-numbered ask asks him to authorise something
//     nobody has read.
//
// RESOLUTION RULES (deliberately conservative)
// --------------------------------------------
// A bare `merge 63` does not say which repo. We map number -> repo ONLY from full URLs
// found in that same journal (`github.com/<owner>/<repo>/pull/63`). If a number cannot be
// resolved that way we report it as `unresolved` and it is NOT a finding: guessing the repo
// would manufacture false "this PR is dead" claims, and a wrong positive here would tell a
// run to rewrite a perfectly good ask.

import { execFileSync } from 'node:child_process';

/** All `github.com/<owner>/<repo>/(pull|issues)/<n>` links in a journal -> Map<"n", "owner/repo">. */
export function repoIndexFromText(text) {
  const idx = new Map();
  const rx = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)/g;
  for (const m of text.matchAll(rx)) {
    const key = `${m[3] === 'pull' ? 'pr' : 'issue'}:${m[4]}`;
    if (!idx.has(key)) idx.set(key, `${m[1]}/${m[2]}`);
    // Also index number-only, so a bare `merge 63` can resolve when the journal
    // only ever links #63 in one repo.
    const nk = `n:${m[4]}`;
    if (!idx.has(nk)) idx.set(nk, `${m[1]}/${m[2]}`);
    else if (idx.get(nk) !== `${m[1]}/${m[2]}`) idx.set(nk, null); // ambiguous -> refuse
  }
  return idx;
}

const cache = new Map();

/** One `gh` call per repo, cached: Map<number, {state,isDraft,mergedAt,title,kind}>. */
export function repoState(repo) {
  if (cache.has(repo)) return cache.get(repo);
  const out = new Map();
  for (const kind of ['pr', 'issue']) {
    try {
      const json = execFileSync(
        'gh',
        [kind, 'list', '--repo', repo, '--state', 'all', '--limit', '400',
          '--json', kind === 'pr' ? 'number,title,state,isDraft' : 'number,title,state'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 },
      );
      for (const o of JSON.parse(json)) {
        // A PR is also an issue number on GitHub; PRs win because `merge N` means the PR.
        if (kind === 'pr' || !out.has(o.number)) {
          out.set(o.number, { state: o.state, isDraft: !!o.isDraft, title: o.title, kind });
        }
      }
    } catch { /* repo unreadable / no auth — leave what we have */ }
  }
  cache.set(repo, out);
  return out;
}
