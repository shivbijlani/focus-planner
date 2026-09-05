import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  jobBlock,
  runLines,
  npmCommands,
  checkSpecVerifyParity,
  CI_VERIFICATION_JOBS,
  SPEC_VERIFY_JOB,
} from './verifyParity.mjs'

const root = path.resolve(import.meta.dirname, '../..')
// Normalised to LF so the mutation arms below match byte-for-byte on a CRLF
// checkout as well as on the Linux runner.
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const CI = read('.github/workflows/ci.yml')
const SPEC = read('.github/workflows/spec-wiki.yml')

describe('workflow reader', () => {
  it('finds a job and stops at the next one', () => {
    const body = jobBlock(CI, 'lint').join('\n')
    expect(body).toContain('npm run lint')
    // `test` is the job immediately above `lint`; bleeding across the boundary
    // would make every parity comparison meaningless.
    expect(body).not.toContain('npm run build')
  })

  it('returns null for a job that does not exist', () => {
    expect(jobBlock(CI, 'no-such-job')).toBeNull()
    expect(npmCommands(CI, 'no-such-job')).toBeNull()
  })

  it('reads both the inline and block-scalar run forms', () => {
    // Inline: `- run: npm ci`
    expect(runLines(CI, 'test')).toContain('npm ci')
    // Block scalar: the rolling-PR step is a multi-line script.
    expect(runLines(SPEC, 'generate').some((l) => l.startsWith('git push --force'))).toBe(true)
  })

  it('ignores runner provisioning, which is not verification of the tree', () => {
    expect(runLines(SPEC, 'generate')).toContain('npm install -g @github/copilot')
    expect(npmCommands(SPEC, 'generate')).not.toContain('npm install -g @github/copilot')
  })
})

describe('the spec branch is verified with exactly what CI runs', () => {
  it('passes against the workflows as committed', () => {
    const { ok, problems } = checkSpecVerifyParity(CI, SPEC)
    expect(problems).toEqual([])
    expect(ok).toBe(true)
  })

  it('covers every npm command CI uses to decide a pull request', () => {
    const expected = new Set(CI_VERIFICATION_JOBS.flatMap((j) => npmCommands(CI, j)))
    expect([...expected].sort()).toEqual(['npm ci', 'npm run build', 'npm run lint', 'npm test'])
    expect(npmCommands(SPEC, SPEC_VERIFY_JOB).sort()).toEqual([...expected].sort())
  })
})

// The guard is only worth having if each arm actually fires. Every mutation
// below is a way the spec PR's green badge could stop meaning "verified" while
// still looking identical in the UI.
describe('mutation check (each way the status could decay is caught)', () => {
  const mutate = (find, replace) => {
    expect(SPEC).toContain(find)
    return SPEC.replace(find, replace)
  }

  const fires = (text, fragment) => {
    const { ok, problems } = checkSpecVerifyParity(CI, text)
    expect(ok).toBe(false)
    expect(problems.join('\n')).toContain(fragment)
  }

  it('catches a verification step dropped from the spec job', () => {
    fires(mutate('        run: npm run lint\n', '        run: echo skipped\n'), 'does not run "npm run lint"')
  })

  it('catches CI gaining a check the spec job does not run', () => {
    const ci = CI.replace('      - run: npm run lint\n', '      - run: npm run lint\n      - run: npm run typecheck\n')
    expect(ci).not.toBe(CI)
    const { ok, problems } = checkSpecVerifyParity(ci, SPEC)
    expect(ok).toBe(false)
    expect(problems.join('\n')).toContain('does not run "npm run typecheck"')
  })

  it('catches the spec job running something CI does not', () => {
    fires(
      mutate('        run: npm run build\n', '        run: npm run build:fast\n'),
      'runs "npm run build:fast", which CI does not',
    )
  })

  it('catches a status hardcoded to success', () => {
    fires(mutate('-f state="$1"', '-f state=success'), 'no-hardcoded-success')
  })

  it('catches a status decoupled from the step that produced it', () => {
    fires(mutate('${{ steps.lint.outcome }}', 'success'), 'derives-lint-outcome')
  })

  it('catches a failure absorbed by continue-on-error', () => {
    fires(mutate('        id: test\n', '        id: test\n        continue-on-error: true\n'), 'no-continue-on-error')
  })

  it('catches checkout floating to the branch name instead of the verified SHA', () => {
    fires(
      mutate('          ref: ${{ needs.generate.outputs.sha }}', '          ref: spec/auto'),
      'pins-the-verified-sha',
    )
  })

  it('catches the whole job being deleted', () => {
    fires(mutate(`  ${SPEC_VERIFY_JOB}:`, '  disabled-verify-spec-branch:'), 'cannot be verified')
  })
})
