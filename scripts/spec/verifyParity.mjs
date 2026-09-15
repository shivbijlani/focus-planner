// A frozen candidate must pass the same checks as ordinary code, using trusted
// scripts, before the credentialed job presents it for approval.

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

/** Jobs in ci.yml whose commands the candidate must be held to. */
export const CI_VERIFICATION_JOBS = ['test', 'lint']

/** Stable job ID retained from the former rolling-PR workflow. */
export const SPEC_VERIFY_JOB = 'verify-spec-branch'

/**
 * Structural requirements prevent a green check for unverified artifacts.
 */
const STRUCTURAL = [
  {
    id: 'checks-facts',
    why: 'candidate facts and readability must be checked before presenting a review',
    holds: (body) => body.includes('node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec'),
  },
  {
    id: 'trusted-checkout',
    why: 'verification scripts come from the workflow revision, not model output',
    holds: (body) => body.includes('ref: ${{ github.sha }}'),
  },
  {
    id: 'frozen-candidate',
    why: 'verification must consume the same candidate artifact that is staged',
    holds: (body) => body.includes('name: wiki-candidate-pages'),
  },
  {
    id: 'no-continue-on-error',
    why: 'a failure must fail the job, not be absorbed into a green status',
    holds: (body) => !body.includes('continue-on-error'),
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
      problems.push(`ci.yml has no "${job}" job -- the candidate is measured against it`)
      continue
    }
    for (const c of cmds) expected.add(c)
  }

  const actual = npmCommands(specText, SPEC_VERIFY_JOB)
  if (!actual) {
    problems.push(`spec-wiki.yml has no "${SPEC_VERIFY_JOB}" job -- the candidate cannot be verified`)
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
  const stage = (jobBlock(specText, 'stage-review') ?? []).join('\n')
  if (!stage.includes('needs: [prepare, verify-spec-branch]') || /\bif:/.test(stage)) {
    problems.push('stage-needs-verification: presenting a review must require successful verification')
  }

  return { ok: problems.length === 0, problems }
}
