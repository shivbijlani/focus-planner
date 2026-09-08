#!/usr/bin/env node
// shipped-but-open-sweep.mjs -- GH #630
//
// WHY THIS EXISTS
//
// In this repo a shipped PR does not close its issue. Shiv closes it after
// reading the catch-up doc. So `OPEN` legitimately spans two states:
//
//     filed-and-unworked          <- pick this up
//     shipped-awaiting-his-review <- do NOT pick this up
//
// `gh issue list --state open` renders both identically. That is not a broken
// signal; it is a correct signal with a lossy reading at the point of
// consumption -- the #346 family, sitting in the first tool a triaging run
// reaches for.
//
// Measured cost before this existed: three separate run sessions recommended
// already-shipped work to the #468 sub-session across 2026-09-07/08 (#620 and
// #588 twice each, plus #515, #594, #598). Twelve instances. Each burned the
// opening of a wake on re-verification. The correction was written into
// agent-lore.md, which #454 records as write-only with zero readers, and the
// very next run session repeated it -- because a run session writes its brief
// fresh and never read the note. A rule nothing enforces is prose.
//
// WHAT IT MEASURES
//
// For each open issue, whether its number appears in shipped source on
// origin/main. An issue whose fix cites it in implementation code is shipped
// and awaiting review; one cited nowhere is unworked.
//
// WHY `git grep`, NOT `git log --grep`
//
// A commit subject names the PR, not the issue -- #588's fix landed under
// "(#592)". Measured contrast: `git log --grep "#588"` returns 0 while
// `git grep "#588"` returns 14. The log is assertively wrong, not merely
// incomplete, so it is the more dangerous of the two.
//
// DELIBERATE LIMITS, STATED RATHER THAN DISCOVERED
//
// This reads citations, not behaviour. A fix that shipped without naming its
// issue reads here as unworked (a false SHIPPED is the dangerous direction, so
// it errs toward the safe one). It cannot prove an issue is *finished* -- only
// that implementation code claims it. Both are stated in the output rather
// than left for a reader to assume, because a sweep that overstates its own
// authority is the defect it is guarding against.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

const REPO_PATHS = ['packages', 'plugins']

// Where the git questions get asked. Resolved once, in main().
let CWD

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: CWD, ...opts })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// Returns the repository ROOT for a path inside a checkout, or null.
//
// Returning "some directory inside the work tree" is not good enough, and the
// difference is not cosmetic (GH #632, second instance). `git grep <rev> --
// packages plugins` resolves its pathspecs RELATIVE TO CWD, so run from
// plugins/overnight-agent/checks the pathspecs match nothing, every issue comes
// back uncited, and the sweep prints "no open issue is already shipped" -- a
// confident, exit-0, wrong clean pass. `rev-parse --is-inside-work-tree` is true
// in that directory, so the obvious check passes while the answer is garbage.
function repoRoot(p) {
  if (!p || !existsSync(p)) return null
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: p })
  if (r.status !== 0) return null
  const top = (r.stdout || '').trim()
  return top || null
}

/**
 * WHY THIS EXISTS AND IS NOT `process.cwd()` (measured 2026-09-08, GH #632)
 * ------------------------------------------------------------------------
 * This sweep shipped registered in run-sweeps.ps1 and, in that home, measured
 * NOTHING. The suite runs with cwd set to the planner data folder, which is not
 * a checkout, so the first thing this file did was print "nothing to measure"
 * and exit 0. Same binary, same commit, one `cwd` apart:
 *
 *   via run-sweeps.ps1        -> ok, exit 0, "nothing to measure"
 *   in V:\repos\focus-planner -> 169 open / 98 SHIPPED / 71 unworked
 *
 * A guard that cannot see, reporting ok, is byte-identical to a guard that
 * looked and found nothing -- which is the exact defect class this sweep was
 * written to attack (#520), arriving in the sweep itself, ten minutes after it
 * merged. The `resolveRepo()` shape is borrowed from version-bump-sweep.mjs,
 * which learned the same lesson about the same suite.
 *
 * Order matters. cwd is tried FIRST so an ad-hoc run in some other checkout
 * measures that checkout, and so the mutation check's hermetic fixture repos
 * are still the subject rather than this machine's real one.
 */
function resolveRepo() {
  const forced = process.env.SHIPPED_SWEEP_REPO
  if (forced) return repoRoot(forced)
  const here = repoRoot(process.cwd())
  if (here) return here
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
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

// A "could not measure" outcome is reported as a finding, not as a pass. Exiting
// 0 here is what made this sweep invisible in the suite: the runner's convention
// is that a non-zero exit WITH stdout is FINDINGS, and silence plus 0 is health.
// Saying "this is not a pass" on stdout does not help when nothing reads stdout.
function notMeasured(lines) {
  for (const l of lines) console.log(l)
  console.log('(this is not a pass: no classification was performed)')
  process.exit(1)
}

// gh infers the repository from cwd exactly as git does, so it needs the same
// treatment. Fixing only the git half left the sweep still cwd-bound, just
// failing one line later -- which is why the fix is verified from the suite's
// actual cwd rather than from a checkout (GH #632).
function gh(args) {
  const r = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: CWD
  })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// A test fixture or a doc mentioning an issue is not the issue being fixed.
// Weight implementation hits above everything else, and say which kind was
// found, so a reader can disagree with the classification rather than having
// to trust it.
function classifyPath(p) {
  const f = p.replace(/^origin\/main:/, '')
  if (/\.test\.(m?js|ts)$/.test(f)) return 'test'
  if (/\/mutcheck-/.test(f)) return 'mutcheck'
  if (/\/(README|AGENTS|SKILL)\.md$/i.test(f) || f.endsWith('.md')) return 'doc'
  return 'impl'
}

function main() {
  CWD = resolveRepo()
  if (!CWD) {
    notMeasured([
      'no focus-planner checkout resolved -- nothing to measure',
      '(cwd is not a checkout, and no fallback matched; set SHIPPED_SWEEP_REPO)'
    ])
  }

  git(['fetch', 'origin', '--quiet'])
  const ref = git(['rev-parse', '--verify', '--quiet', 'origin/main'])
  if (ref.code !== 0 || !ref.out) {
    notMeasured(['origin/main not resolvable -- nothing to measure'])
  }

  // Test seam. The mutation check supplies the issue list directly so the
  // sweep can be exercised against a constructed repo without a network or a
  // GitHub login -- the same shape as TELEGRAM_BRIDGE_STATE_DIR elsewhere.
  const injected = process.env.SHIPPED_SWEEP_ISSUES_JSON
  const list = injected ? { code: 0, out: injected, err: '' } : gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title'])
  if (list.code !== 0) {
    notMeasured([
      'could not list open issues -- nothing to measure',
      `(gh said: ${(list.err || 'no detail').slice(0, 160)})`
    ])
  }

  let issues
  try {
    issues = JSON.parse(list.out)
  } catch {
    notMeasured(['could not parse the issue list -- nothing to measure'])
  }

  if (!Array.isArray(issues) || issues.length === 0) {
    console.log('no open issues -- nothing to measure')
    process.exit(0)
  }

  const shipped = []
  const unworked = []

  for (const issue of issues) {
    const n = issue.number
    // Word-boundary on #N. A bare number collides: `git grep 515` matches
    // "$515-520", a price range in an unrelated fixture.
    const g = git(['grep', '-l', '-E', `#${n}([^0-9]|$)`, 'origin/main', '--', ...REPO_PATHS])
    const files = g.code === 0 && g.out ? g.out.split('\n').filter(Boolean) : []
    const kinds = new Set(files.map(classifyPath))

    if (kinds.has('impl')) {
      shipped.push({ n, title: issue.title, files, kinds: [...kinds] })
    } else {
      unworked.push({ n, title: issue.title, weak: files.length > 0 ? [...kinds] : null })
    }
  }

  console.log(`open issues      : ${issues.length}`)
  console.log(`SHIPPED (awaiting his review, do NOT pick up): ${shipped.length}`)
  console.log(`unworked (safe to pick up)                   : ${unworked.length}`)
  console.log(`ref              : origin/main ${ref.out.slice(0, 12)}`)
  console.log('')

  if (shipped.length) {
    console.log('These are OPEN but their fix is cited in implementation source.')
    console.log('Recommending one of these to a sub-session wastes the opening of a wake:')
    for (const s of shipped.sort((a, b) => b.n - a.n)) {
      const impl = s.files.filter((f) => classifyPath(f) === 'impl').map((f) => f.replace(/^origin\/main:/, ''))
      console.log(`  #${s.n}  ${s.title.slice(0, 74)}`)
      console.log(`         cited in: ${impl.slice(0, 3).join(', ')}${impl.length > 3 ? ` (+${impl.length - 3})` : ''}`)
    }
    console.log('')
  }

  const weak = unworked.filter((u) => u.weak)
  if (weak.length) {
    console.log('Cited only in tests/mutchecks/docs -- NOT counted as shipped, listed so')
    console.log('the judgement is visible rather than silent:')
    for (const w of weak.sort((a, b) => b.n - a.n)) {
      console.log(`  #${w.n}  [${w.weak.join(',')}]  ${w.title.slice(0, 66)}`)
    }
    console.log('')
  }

  if (shipped.length === 0) {
    console.log('OK: no open issue is already shipped. The tracker and the source agree.')
    process.exit(0)
  }

  console.log(`FINDINGS: ${shipped.length} open issue(s) are already shipped.`)
  console.log('Verify against source before starting work, never `git log --grep`:')
  console.log('  git grep "#<N>" origin/main -- packages plugins')
  process.exit(1)
}

main()
