/**
 * merge-queue — execute the empirically verified PR merge order.
 *
 * WHY THIS EXISTS
 * ---------------
 * GitHub's `MERGEABLE` badge is computed per-PR against `main`. It is blind to
 * PR-versus-PR collisions, so a stack of PRs can every one of them read
 * "mergeable" and still stop dead halfway through a real merge run.
 *
 * The order encoded below is not a guess. It was produced by actually merging
 * each PR into a scratch worktree and running the full vitest suite on the
 * result (see journal/task-407-verified-merge-queue.md). Merging in the
 * "obvious" order lands 8 of 18; this order lands 15 and ends green.
 *
 * That ordering is expensive knowledge and easy to lose. This script is where
 * it lives so it can be replayed as one command instead of 15 careful clicks.
 *
 * SAFETY
 * ------
 * Merging is irreversible, so this script is **dry-run by default**. It prints
 * the plan and changes nothing unless you pass `--execute`. Even then it:
 *   - re-checks each PR's live state before touching it,
 *   - runs the test suite after every merge and STOPS on the first failure,
 *   - skips PRs that are already merged, so a stopped run is resumable,
 *   - leaves branches alone unless you ask for `--delete-branches`.
 *
 * USAGE
 *   node scripts/merge-queue.mjs                 # dry run: show the plan
 *   node scripts/merge-queue.mjs --execute       # actually merge, test-gated
 *   node scripts/merge-queue.mjs --from 149      # resume partway through
 *   node scripts/merge-queue.mjs --execute --skip-tests
 *
 * Requires the GitHub CLI (`gh`) to be installed and authenticated.
 */

import { execFileSync } from 'node:child_process'

/**
 * The verified order. `tests` is the passing test count observed after that
 * step during verification — used as a sanity signal, not a hard assertion,
 * because unrelated merges to main can legitimately move the number.
 */
export const VERIFIED_QUEUE = [
  { pr: 150, label: 'add missing fake-indexeddb devDependency (unblocks the suite)', tests: 459 },
  { pr: 151, label: 'reap stale MCP servers before PHASE 0', tests: 459 },
  { pr: 149, label: 'route batched Telegram replies outside a task topic', tests: 478 },
  { pr: 154, label: 'approval digest, stacked on #149 (supersedes #152)', tests: 507 },
  { pr: 148, label: 'make check-google-token.ps1 usable out of the box', tests: 507 },
  { pr: 153, label: 'add CI test + build workflow', tests: 507 },
  { pr: 134, label: 'keep PHASE 3 O(1) as Telegram toggles grow', tests: 507 },
  { pr: 131, label: 'time-triggered polling in oa-state', tests: 507 },
  { pr: 117, label: 'collect Google Tasks during PHASE 2', tests: 507 },
  { pr: 103, label: 'redesign Settings modal for desktop/mobile', tests: 507 },
  { pr: 109, label: 'refresh file tree on tab focus/visibility', tests: 512 },
  { pr: 111, label: 'Diagnostics section — copyable storage/sync snapshot', tests: 517 },
  { pr: 121, label: 'fix linked-id nav opening completed.md for a live task', tests: 533 },
  { pr: 126, label: 'snooze: visible Wake column + event-driven promoter', tests: 536 },
  { pr: 99, label: 'first-run tutorial prototype', tests: 554 },
]

/**
 * PRs deliberately left out of the queue, and why. Surfaced in the plan so a
 * missing PR reads as a decision rather than an oversight.
 */
export const EXCLUDED = [
  { pr: 152, reason: 'superseded by #154, which resolves the #149/#152 collision — close or retarget it' },
  { pr: 120, reason: 'collides with #131 on oa-state.ps1; land #131 first, then rebase #120' },
  { pr: 122, reason: 'collides with #125 on agentSettingsVisibility.js' },
  { pr: 125, reason: 'large App.jsx surface; rebase after the queue drains' },
  { pr: 147, reason: 'collides with #111 on storage.js; rebase after #111' },
]

/** Decide what to do with one queue entry, given its live PR state. */
export function planStep(entry, pr) {
  if (!pr) {
    return { pr: entry.pr, action: 'stop', reason: 'PR not found (wrong repo, or deleted?)' }
  }
  if (pr.state === 'MERGED') {
    return { pr: entry.pr, action: 'skip', reason: 'already merged' }
  }
  if (pr.state === 'CLOSED') {
    return { pr: entry.pr, action: 'skip', reason: 'closed without merging' }
  }
  if (pr.mergeable === 'CONFLICTING') {
    return { pr: entry.pr, action: 'stop', reason: 'conflicts with main — rebase it before continuing' }
  }
  return {
    pr: entry.pr,
    action: 'merge',
    needsReady: pr.isDraft === true,
    reason: pr.mergeable === 'UNKNOWN' ? 'mergeability still computing; will re-check at merge time' : null,
  }
}

/**
 * Build the full plan. `lookup` maps a PR number to its live state object.
 * Stops planning at the first blocking step, because everything after a
 * blocked merge is unverifiable anyway.
 */
export function planQueue(queue, lookup, { from = null } = {}) {
  const steps = []
  let started = from == null
  for (const entry of queue) {
    if (!started) {
      if (entry.pr !== from) continue
      started = true
    }
    const step = planStep(entry, lookup(entry.pr))
    steps.push({ ...entry, ...step })
    if (step.action === 'stop') break
  }
  return steps
}

/** Parse `Tests  12 passed (12)` out of vitest output. */
export function parseTestCount(output) {
  const m = /Tests\s+(\d+)\s+passed/.exec(output ?? '')
  return m ? Number(m[1]) : null
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function sh(cmd, args, { capture = true } = {}) {
  // Windows ships `gh` and `npm` as .cmd shims, which execFile cannot launch
  // directly. Route those through cmd.exe explicitly rather than using
  // `shell: true`, which is deprecated because it concatenates arguments
  // unescaped instead of passing them as a vector.
  const isWin = process.platform === 'win32'
  const file = isWin ? process.env.ComSpec || 'cmd.exe' : cmd
  const argv = isWin ? ['/d', '/s', '/c', cmd, ...args] : args
  return execFileSync(file, argv, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
}

function fetchPrStates(numbers) {
  const map = new Map()
  for (const n of numbers) {
    try {
      const raw = sh('gh', ['pr', 'view', String(n), '--json', 'number,state,mergeable,isDraft,title'])
      map.set(n, JSON.parse(raw))
    } catch {
      map.set(n, null)
    }
  }
  return map
}

function runTests() {
  try {
    const out = sh('npm', ['test', '--silent'])
    return { ok: true, passed: parseTestCount(out) }
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    return { ok: false, passed: parseTestCount(out), output: out.slice(-4000) }
  }
}

function parseArgs(argv) {
  const opts = { execute: false, deleteBranches: false, skipTests: false, from: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--execute') opts.execute = true
    else if (a === '--delete-branches') opts.deleteBranches = true
    else if (a === '--skip-tests') opts.skipTests = true
    else if (a === '--from') opts.from = Number(argv[++i])
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('usage: node scripts/merge-queue.mjs [--execute] [--from <pr>] [--skip-tests] [--delete-branches]')
    return
  }

  console.log('Verified merge queue — focus-planner')
  console.log(opts.execute ? 'MODE: EXECUTE (merges are real)\n' : 'MODE: dry run (nothing will be merged)\n')

  const states = fetchPrStates(VERIFIED_QUEUE.map((e) => e.pr))
  const plan = planQueue(VERIFIED_QUEUE, (n) => states.get(n) ?? null, { from: opts.from })

  for (const [i, step] of plan.entries()) {
    const tag = step.action === 'merge' ? 'MERGE' : step.action === 'skip' ? 'skip ' : 'STOP '
    const note = step.reason ? ` — ${step.reason}` : ''
    console.log(`${String(i + 1).padStart(2)}. [${tag}] #${step.pr} ${step.label}${note}`)
  }

  if (EXCLUDED.length) {
    console.log('\nDeliberately not in the queue:')
    for (const x of EXCLUDED) console.log(`   #${x.pr} — ${x.reason}`)
  }

  const toMerge = plan.filter((s) => s.action === 'merge')
  const blocked = plan.find((s) => s.action === 'stop')

  if (!opts.execute) {
    console.log(`\n${toMerge.length} PR(s) would be merged.`)
    if (blocked) console.log(`Queue stops at #${blocked.pr}: ${blocked.reason}`)
    console.log('Re-run with --execute to perform the merges.')
    return
  }

  if (blocked && toMerge.length === 0) {
    console.error(`\nNothing to do: queue is blocked at #${blocked.pr} (${blocked.reason}).`)
    process.exitCode = 1
    return
  }

  let merged = 0
  for (const step of plan) {
    if (step.action !== 'merge') continue
    console.log(`\n--- #${step.pr}: ${step.label}`)
    try {
      if (step.needsReady) {
        console.log('    marking ready for review…')
        sh('gh', ['pr', 'ready', String(step.pr)])
      }
      const mergeArgs = ['pr', 'merge', String(step.pr), '--squash']
      if (opts.deleteBranches) mergeArgs.push('--delete-branch')
      sh('gh', mergeArgs)
      console.log('    merged.')
      merged++
    } catch (err) {
      console.error(`    MERGE FAILED: ${err.message}`)
      console.error('    Stopping. Re-run with --from to resume once resolved.')
      process.exitCode = 1
      return
    }

    try {
      sh('git', ['pull', '--ff-only'])
    } catch (err) {
      console.error(`    git pull failed: ${err.message}`)
      process.exitCode = 1
      return
    }

    if (opts.skipTests) continue
    console.log('    running tests…')
    const res = runTests()
    if (!res.ok) {
      console.error(`    TESTS FAILED after #${step.pr}. Stopping so the break is easy to attribute.`)
      if (res.output) console.error(res.output)
      process.exitCode = 1
      return
    }
    const expected = step.tests
    const drift = res.passed != null && expected != null && res.passed !== expected
    console.log(`    tests green: ${res.passed ?? '?'} passed${drift ? ` (verification saw ${expected})` : ''}`)
  }

  console.log(`\nDone. ${merged} PR(s) merged.`)
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/merge-queue.mjs')
if (invokedDirectly) main()
