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
import { citationsFor, classifyPath, resolveRepo } from './issue-shipped.mjs'

// WHY THE CLASSIFIER IS IMPORTED RATHER THAN DEFINED HERE (GH #635)
//
// This sweep is a CENSUS: it answers "how many open issues are already
// shipped" after the fact, into a suite log. `issue-shipped.mjs` is the same
// question asked of ONE issue, BEFORE a run commits to it, which is where the
// cost actually lands. Two copies of "what counts as shipped" would be two
// opinions that drift -- the writer/reader disagreement this codebase keeps
// recording -- and the drift would be invisible precisely because both sides
// would keep reporting confidently. So the gate owns the definition and the
// census consumes it.

// Where the git questions get asked. Resolved once, in main().
let CWD

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: CWD, ...opts })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
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
// `classifyPath` is imported from issue-shipped.mjs -- see the note at the top
// of this file for why it is not defined twice.

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
    // Word-boundary on #N lives in `citationsFor` -- a bare number collides:
    // `git grep 515` matches "$515-520", a price range in an unrelated fixture.
    const files = citationsFor(CWD, n)
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
