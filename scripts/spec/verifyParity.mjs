/**
 * verifyParity — keep the spec branch's verification honest, and identical to CI.
 *
 * WHY THIS EXISTS
 * ---------------
 * The rolling spec pull request (`spec/auto`, opened and force-updated by the
 * Spec wiki workflow every 6 hours) could never acquire a single check. It is
 * authored by `github-actions[bot]` using `GITHUB_TOKEN`, and GitHub refuses to
 * let a token-authored event cascade into a workflow run: the `pull_request`
 * run for `ci.yml` IS created, then parked at `conclusion: action_required` with
 * a 0s duration, so zero check-runs ever reach the head commit.
 *
 * That produced a permanent deadlock with the overnight agent's merge rule,
 * which refuses to merge a pull request whose check rollup is empty -- correctly,
 * because "no check has ever looked at this" is not "this is green". The PR
 * regenerated forever and could never be merged or closed.
 *
 * The fix is for the Spec wiki workflow -- which runs on `schedule`, so it is
 * NOT gated -- to verify the branch it just pushed and publish the result to
 * that commit via the statuses API. Commit statuses written with `GITHUB_TOKEN`
 * do land in a PR's rollup; the no-cascade rule governs triggering workflows,
 * not writing statuses.
 *
 * WHY A GUARD IS NEEDED
 * ---------------------
 * That fix only holds if the status means what it says. Two ways it silently
 * stops meaning anything:
 *
 *   1. DRIFT. The verify job re-runs CI's commands rather than reusing CI.
 *      (Reuse was considered and rejected: a `workflow_call` into `ci.yml` runs
 *      at the CALLER's ref and attaches its check-runs to the caller's SHA, so
 *      it would verify `main` and report nothing against `spec/auto` -- it does
 *      not remove the need for the statuses API, it only adds coupling.) So the
 *      commands are duplicated, and duplication drifts. A green badge produced
 *      by a subset of CI is a lie in the shape of a fact.
 *
 *   2. DECOUPLING. A status whose state is not derived from the outcome of the
 *      steps that ran is decoration. Hardcoding `success`, or swallowing a
 *      failure with `continue-on-error`, is strictly worse than the empty rollup
 *      it replaced: the empty rollup was at least honest about knowing nothing.
 *
 * This module checks both mechanically, from the workflow files themselves, so
 * the failure mode is a red check on the pull request that causes it.
 */

const BLOCK_SCALAR = /^[|>][+-]?\d*$/

/** Strip a trailing CR so CRLF checkouts parse the same as LF ones. */
function lines(text) {
  return text.split('\n').map((l) => l.replace(/\r$/, ''))
}

/**
 * The raw body of one top-level job, as an array of lines.
 *
 * Deliberately a line scanner rather than a YAML parse: the repo ships no YAML
 * dependency, and adding one to satisfy a guard would mean the guard's own
 * supply chain is bigger than the thing it guards.
 */
export function jobBlock(text, jobId) {
  const all = lines(text)
  const jobsAt = all.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsAt === -1) return null

  const header = new RegExp(`^ {2}${jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`)
  let start = -1
  for (let i = jobsAt + 1; i < all.length; i++) {
    if (header.test(all[i])) { start = i + 1; break }
    if (/^\S/.test(all[i])) break // left the jobs: mapping entirely
  }
  if (start === -1) return null

  const body = []
  for (let i = start; i < all.length; i++) {
    const l = all[i]
    if (l.trim() === '') { body.push(l); continue }
    // A non-blank line indented less than 4 spaces ends the job block: it is
    // either the next job id (2 spaces) or a new top-level key (0).
    if (!/^ {4}/.test(l)) break
    body.push(l)
  }
  return body
}

/**
 * Every shell line a job's `run:` steps execute, flattened.
 *
 * Handles both step forms in use here: inline (`- run: npm ci`) and block
 * scalar (`run: |` followed by an indented script).
 */
export function runLines(text, jobId) {
  const body = jobBlock(text, jobId)
  if (!body) return null

  const out = []
  for (let i = 0; i < body.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(body[i])
    if (!m) continue
    const [, indent, rest] = m
    const value = rest.trim()

    if (!BLOCK_SCALAR.test(value)) {
      if (value !== '') out.push(value.replace(/^["']|["']$/g, ''))
      continue
    }

    // Block scalar: consume the more-indented lines that follow.
    const floor = indent.length
    for (let j = i + 1; j < body.length; j++) {
      if (body[j].trim() === '') { i = j; continue }
      const lead = body[j].length - body[j].trimStart().length
      if (lead <= floor) break
      out.push(body[j].trim())
      i = j
    }
  }
  return out
}

/**
 * The npm commands a job runs, deduplicated and sorted.
 *
 * This is the comparable surface between CI and the spec verification: the
 * things that actually decide whether the tree is good.
 */
export function npmCommands(text, jobId) {
  const runs = runLines(text, jobId)
  if (!runs) return null
  const found = runs
    .filter((l) => /^npm\s/.test(l))
    // `npm install -g <tool>` provisions the runner; it is not a verification
    // of the tree, and CI has no counterpart for it.
    .filter((l) => !/^npm\s+install\s+-g\b/.test(l))
  return [...new Set(found)].sort()
}

/** Jobs in ci.yml whose commands the spec branch must be held to. */
export const CI_VERIFICATION_JOBS = ['test', 'lint']

/** The job in spec-wiki.yml that verifies the pushed spec branch. */
export const SPEC_VERIFY_JOB = 'verify-spec-branch'

/**
 * Structural requirements on the verify job, each tied to a way the status
 * could stop meaning "verified" without anyone noticing.
 */
const STRUCTURAL = [
  {
    id: 'derives-test-outcome',
    why: 'the published status must be derived from the unit-test step outcome',
    holds: (body) => body.includes('steps.test.outcome'),
  },
  {
    id: 'derives-build-outcome',
    why: 'the published status must be derived from the build step outcome',
    holds: (body) => body.includes('steps.build.outcome'),
  },
  {
    id: 'derives-lint-outcome',
    why: 'the published status must be derived from the lint step outcome',
    holds: (body) => body.includes('steps.lint.outcome'),
  },
  {
    id: 'no-continue-on-error',
    why: 'a failure must fail the job, not be absorbed into a green status',
    holds: (body) => !body.includes('continue-on-error'),
  },
  {
    id: 'no-hardcoded-success',
    why: 'no status state may be the literal success; it must come from a step outcome',
    holds: (body) => !/state=["']?success/.test(body),
  },
  {
    id: 'writes-statuses',
    why: 'the job must publish to the commit statuses API, which is what reaches the PR rollup',
    holds: (body) => /statuses\/\$?\{?/.test(body) && body.includes('statuses: write'),
  },
  {
    id: 'pins-the-verified-sha',
    why:
      'checkout must pin the exact SHA the status is attached to; checking out the branch by ' +
      'name lets a concurrent force-push verify one tree and vouch for another',
    holds: (body) => body.includes('needs.generate.outputs.sha') && !/ref:\s*spec\/auto/.test(body),
  },
]

/**
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkSpecVerifyParity(ciText, specText) {
  const problems = []

  const expected = new Set()
  for (const job of CI_VERIFICATION_JOBS) {
    const cmds = npmCommands(ciText, job)
    if (!cmds) {
      problems.push(`ci.yml has no "${job}" job -- the spec branch is measured against it`)
      continue
    }
    for (const c of cmds) expected.add(c)
  }

  const actual = npmCommands(specText, SPEC_VERIFY_JOB)
  if (!actual) {
    problems.push(`spec-wiki.yml has no "${SPEC_VERIFY_JOB}" job -- the spec PR cannot be verified`)
    return { ok: false, problems }
  }

  const actualSet = new Set(actual)
  for (const c of [...expected].sort()) {
    if (!actualSet.has(c)) {
      problems.push(`${SPEC_VERIFY_JOB} does not run "${c}", which CI runs on every pull request`)
    }
  }
  for (const c of actual) {
    if (!expected.has(c)) {
      problems.push(`${SPEC_VERIFY_JOB} runs "${c}", which CI does not -- the two have diverged`)
    }
  }

  // Comments are stripped before the structural checks: this workflow explains
  // its own invariants in prose right next to them, so a comment saying the
  // steps are not `continue-on-error` would otherwise trip the check looking
  // for `continue-on-error`.
  const body = (jobBlock(specText, SPEC_VERIFY_JOB) ?? [])
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
  for (const rule of STRUCTURAL) {
    if (!rule.holds(body)) problems.push(`${rule.id}: ${rule.why}`)
  }

  return { ok: problems.length === 0, problems }
}
