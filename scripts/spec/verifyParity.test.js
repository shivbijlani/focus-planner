import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { jobBlock, runLines, npmCommands, checkSpecVerifyParity, CI_VERIFICATION_JOBS, SPEC_VERIFY_JOB } from './verifyParity.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const CI = read('.github/workflows/ci.yml')
const SPEC = read('.github/workflows/spec-wiki.yml')

describe('workflow verification parity', () => {
  it('reads isolated jobs and ignores tool provisioning', () => {
    expect(jobBlock(CI, 'lint').join('\n')).not.toContain('npm run build')
    expect(jobBlock(CI, 'missing')).toBeNull()
    expect(runLines(CI, 'test')).toContain('npm ci')
    expect(npmCommands(SPEC, 'generate')).not.toContain('npm install -g @github/copilot')
  })
  it('runs the same full verification as CI', () => {
    expect(checkSpecVerifyParity(CI, SPEC)).toEqual({ ok: true, problems: [] })
    const expected = [...new Set(CI_VERIFICATION_JOBS.flatMap(j => npmCommands(CI, j)))].sort()
    expect(npmCommands(SPEC, SPEC_VERIFY_JOB)).toEqual(expected)
  })
  it.each([
    ['run: npm run lint', 'run: echo skipped', 'does not run'],
    ['run: npm run build', 'run: npm run build:fast', 'does not run'],
    ['id: test', 'id: test\n        continue-on-error: true', 'no-continue-on-error'],
    ['ref: ${{ github.sha }}', 'ref: spec/auto', 'trusted-checkout'],
    ['run: node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec', 'run: echo verified', 'checks-facts'],
    ['needs: [prepare, verify-spec-branch]', 'needs: prepare', 'stage-needs-verification'],
    ['  verify-spec-branch:', '  missing:', 'cannot be verified'],
  ])('catches removing guard %s', (from, to, problem) => {
    // Target the verifier for repeated checkout refs, not another job's ref.
    const at = from.startsWith('ref:') ? SPEC.indexOf('  verify-spec-branch:') : 0
    const changed = SPEC.slice(0, at) + SPEC.slice(at).replace(from, to)
    expect(changed).not.toBe(SPEC)
    expect(checkSpecVerifyParity(CI, changed).problems.join('\n')).toContain(problem)
  })
  it('detects additional checks in CI', () => {
    const changed = CI.replace('      - run: npm run lint', '      - run: npm run lint\n      - run: npm run typecheck')
    expect(checkSpecVerifyParity(changed, SPEC).problems.join('\n')).toContain('typecheck')
  })
})

describe('one protected wiki writer', () => {
  it('replaces six-hour generation with a daily proposal and approval-only ticks', () => {
    expect(SPEC).toContain("cron: '17 16 * * *'")
    expect(SPEC).toContain("cron: '17 0-15,17-23 * * *'")
    expect(SPEC).not.toContain('0 */6')
    expect(SPEC).toContain("github.event.schedule == '17 16 * * *' || inputs.propose")
    expect(SPEC).toContain('cancel-in-progress: false')
  })
  it('never gives the model document credentials or write access', () => {
    const job = jobBlock(SPEC, 'generate').join('\n')
    expect(job).toContain('contents: read')
    expect(job).not.toContain('contents: write')
    expect(job).not.toContain('WIKI_GOOGLE')
    expect(job).not.toContain('WIKI_TOKEN')
    expect(job).toContain('persist-credentials: false')
  })
  it('does not publish from a floating source or a second legacy writer', () => {
    const publish = runLines(SPEC, 'publish-wiki').join('\n')
    expect(publish).toBe('node scripts/spec/reviewCli.mjs publish')
    expect(SPEC).not.toContain('git push --force')
    expect(SPEC).not.toContain('git clone')
    expect(read('scripts/spec/publish-wiki.ps1')).toContain("throw 'Direct wiki publishing is disabled.")
  })
})
