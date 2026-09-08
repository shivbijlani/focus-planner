#!/usr/bin/env node
// issue-shipped.mjs -- GH #635
//
// WHY THIS EXISTS
//
// `shipped-but-open-sweep.mjs` (#630) established the fact: in this repo a
// shipped PR does not close its issue, so `OPEN` spans "unworked" and
// "shipped, awaiting his review", and the tracker renders both identically.
// It measured 98 of 169 open issues as already shipped.
//
// Measuring was not enough, and the sweep's own header says why in the line
// it wrote about agent-lore.md: A RULE NOTHING ENFORCES IS PROSE. The sweep
// reports a census after the fact, to a suite log. The moment that matters is
// earlier and elsewhere -- a run deciding what to hand a sub-session -- and at
// that moment nothing consults it. Twelve recommendations of already-shipped
// work were made across 2026-09-07/08 while the knowledge to refuse every one
// of them was already computable.
//
// So this file is the same classification, addressable ONE ISSUE AT A TIME and
// cheap enough to sit in front of a decision rather than behind it:
//
//     node issue-shipped.mjs 588 620      -> exit 1 if ANY is already shipped
//
// The sweep imports it, so the census and the gate cannot drift into two
// different opinions about what "shipped" means -- which is the failure this
// codebase keeps recording between a writer and its reader.
//
// COST. The sweep asks 169 questions because it is a census. A gate asks about
// the handful of issues actually being proposed, so it is one `git grep` per
// candidate -- fast enough for write-turn.ps1 to call on every wake.
//
// LIMITS, INHERITED AND RESTATED. This reads citations, not behaviour. A fix
// that shipped without naming its issue reads here as unworked. It cannot
// prove an issue is FINISHED, only that implementation source claims it. Both
// directions are not equally bad: a false SHIPPED wrongly blocks real work, a
// false unworked wastes a wake. The verdict therefore requires an
// implementation hit -- tests, mutation checks and docs are reported but never
// classify on their own.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const REPO_PATHS = ['packages', 'plugins']

function gitIn(cwd, args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// Returns the repository ROOT for a path inside a checkout, or null.
//
// Returning "some directory inside the work tree" is not good enough, and the
// difference is not cosmetic (GH #632, second instance). `git grep <rev> --
// packages plugins` resolves its pathspecs RELATIVE TO CWD, so run from
// plugins/overnight-agent/checks the pathspecs match nothing, every issue comes
// back uncited, and the answer is a confident, exit-0, wrong clean pass.
// `rev-parse --is-inside-work-tree` is true in that directory, so the obvious
// check passes while the answer is garbage.
export function repoRoot(p) {
  if (!p || !existsSync(p)) return null
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: p })
  if (r.status !== 0) return null
  return (r.stdout || '').trim() || null
}

/**
 * WHY THIS IS NOT `process.cwd()` (measured 2026-09-08, GH #632)
 * -------------------------------------------------------------
 * The sweep shipped registered in run-sweeps.ps1 and, in that home, measured
 * NOTHING: the suite runs with cwd set to the planner data folder, which is not
 * a checkout. Same binary, same commit, one `cwd` apart:
 *
 *   via run-sweeps.ps1        -> ok, exit 0, "nothing to measure"
 *   in V:\repos\focus-planner -> 169 open / 98 SHIPPED / 71 unworked
 *
 * That matters even more here than it did there. write-turn.ps1 runs from the
 * INSTALLED plugin (`~/.copilot/installed-plugins/...`), which is not a
 * checkout at all, so a cwd-bound resolver would make this gate permanently
 * blind in the one place it is meant to fire.
 *
 * Order matters. cwd is tried FIRST so an ad-hoc run in some other checkout
 * measures that checkout, and so hermetic fixture repos stay the subject.
 */
export function resolveRepo() {
  const forced = process.env.SHIPPED_SWEEP_REPO
  if (forced) return repoRoot(forced)
  const here = repoRoot(process.cwd())
  if (here) return here
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const top = repoRoot(dir)
    if (top) return top
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const c of ['V:\\repos\\focus-planner', '/v/repos/focus-planner']) {
    const top = repoRoot(c)
    if (top) return top
  }
  return null
}

// A test fixture or a doc mentioning an issue is not the issue being fixed.
// Weight implementation hits above everything else, and say which kind was
// found, so a reader can disagree with the classification rather than having
// to trust it.
export function classifyPath(p) {
  const f = p.replace(/^[^:]*:/, '')
  if (/\.test\.(m?js|ts)$/.test(f)) return 'test'
  if (/\/mutcheck-/.test(f)) return 'mutcheck'
  if (/\.md$/i.test(f)) return 'doc'
  return 'impl'
}

/**
 * Ensure `origin/main` is resolvable in `cwd`, returning its sha or null.
 *
 * The gate deliberately does NOT fetch. The sweep does, because a census can
 * afford a network round trip; a guard that runs on every journal turn cannot,
 * and a gate that hangs on an offline network is a gate that gets switched off.
 * A slightly stale origin/main can only produce a false "unworked", which is
 * the safe direction (it lets real work proceed), never a false refusal.
 */
export function resolveRef(cwd) {
  const ref = gitIn(cwd, ['rev-parse', '--verify', '--quiet', 'origin/main'])
  if (ref.code !== 0 || !ref.out) return null
  return ref.out
}

/**
 * Files on `origin/main` citing issue #n, within implementation-bearing paths.
 *
 * WHY `git grep`, NOT `git log --grep`. A commit subject names the PR, not the
 * issue -- #588's fix landed under "(#592)". Measured contrast:
 * `git log --grep "#588"` returns 0 while `git grep "#588"` returns 14. The log
 * is assertively wrong, not merely incomplete, so it is the more dangerous of
 * the two.
 *
 * Word-boundary on #N, because a bare number collides and so does a longer one:
 * `#1111` must not satisfy a query for `#111`.
 */
export function citationsFor(cwd, n) {
  const g = gitIn(cwd, ['grep', '-l', '-E', `#${n}([^0-9]|$)`, 'origin/main', '--', ...REPO_PATHS])
  return g.code === 0 && g.out ? g.out.split('\n').filter(Boolean) : []
}

/**
 * Classify issue numbers as shipped / unworked against source on origin/main.
 *
 * Returns { ok, reason, ref, results } where `ok:false` means NOT MEASURED --
 * never "clean". Every caller must treat those as different, because the whole
 * defect class here is a guard that cannot see reporting the same shape as a
 * guard that looked and found nothing (#520, #632).
 */
export function classifyIssues(numbers, opts = {}) {
  const cwd = opts.cwd || resolveRepo()
  if (!cwd) {
    return { ok: false, reason: 'no focus-planner checkout resolved (set SHIPPED_SWEEP_REPO)', results: [] }
  }
  const ref = resolveRef(cwd)
  if (!ref) {
    return { ok: false, reason: 'origin/main not resolvable in ' + cwd, results: [] }
  }

  const results = []
  for (const raw of numbers) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) continue
    const files = citationsFor(cwd, n).map((f) => f.replace(/^[^:]*:/, ''))
    const kinds = [...new Set(files.map(classifyPath))]
    results.push({
      n,
      shipped: kinds.includes('impl'),
      kinds,
      impl: files.filter((f) => classifyPath(f) === 'impl'),
      files
    })
  }
  return { ok: true, cwd, ref, results }
}

// ---------------------------------------------------------------- CLI
//
// EXIT CODES, and why "cannot measure" is not 0.
//
//   0  every candidate is unworked -- safe to pick up
//   1  at least one is already shipped -- do NOT pick it up
//   2  could not classify. NOT a pass.
//   3  bad arguments
//
// 2 rather than 0 is the whole lesson of #632: the runner's convention is that
// silence plus 0 is health, so a blind guard that exits 0 is byte-identical to
// a guard that looked and cleared the work. Saying "not measured" on stdout
// does not help when the exit code contradicts it.

function isMain() {
  if (!process.argv[1]) return false
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function cli(argv) {
  const json = argv.includes('--json')
  const nums = argv.filter((a) => /^#?\d+$/.test(a)).map((a) => Number(a.replace('#', '')))

  if (nums.length === 0) {
    if (json) console.log(JSON.stringify({ ok: false, reason: 'no issue numbers given', results: [] }))
    else {
      console.log('usage: node issue-shipped.mjs [--json] <issue-number> [issue-number...]')
      console.log('')
      console.log('Answers one question before a run commits to work: is this issue')
      console.log('already shipped and merely awaiting his review? (GH #635)')
    }
    return 3
  }

  const verdict = classifyIssues(nums)

  if (json) {
    console.log(JSON.stringify(verdict))
    return verdict.ok ? (verdict.results.some((r) => r.shipped) ? 1 : 0) : 2
  }

  if (!verdict.ok) {
    console.log(`could not classify -- ${verdict.reason}`)
    console.log('(this is not a pass: no issue was checked against source)')
    return 2
  }

  const shipped = verdict.results.filter((r) => r.shipped)
  const clear = verdict.results.filter((r) => !r.shipped)

  console.log(`ref: origin/main ${verdict.ref.slice(0, 12)}`)
  for (const r of verdict.results) {
    if (r.shipped) {
      const cited = r.impl.slice(0, 3).join(', ')
      console.log(`  #${r.n}  SHIPPED -- do NOT pick up`)
      console.log(`        cited in: ${cited}${r.impl.length > 3 ? ` (+${r.impl.length - 3})` : ''}`)
    } else if (r.files.length) {
      console.log(`  #${r.n}  unworked (cited only in [${r.kinds.join(',')}] -- not implementation)`)
    } else {
      console.log(`  #${r.n}  unworked -- safe to pick up`)
    }
  }
  console.log('')

  if (shipped.length === 0) {
    console.log(`OK: ${clear.length} candidate(s), none already shipped.`)
    return 0
  }
  console.log(`REFUSE: ${shipped.length} of ${verdict.results.length} candidate(s) already shipped.`)
  console.log('A shipped PR does not close its issue here, so OPEN does not mean unworked.')
  console.log('Verify by hand with:  git grep "#<N>" origin/main -- packages plugins')
  return 1
}

if (isMain()) process.exit(cli(process.argv.slice(2)))
