#!/usr/bin/env node
// mutcheck-shipped-but-open.mjs -- proves shipped-but-open-sweep.mjs is load-bearing.
//
// Every arm is paired against a baseline that must FAIL on the identical
// fixture. That pairing is not ceremony. Twice on 2026-09-08 an arm was
// written that could never fail -- once because the guard under test sat
// inside a conditional it never entered -- and every negative passed
// meaninglessly. A guard against silent staleness that is itself silently not
// running is the bug wearing the guard's clothes.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SWEEP = join(HERE, 'shipped-but-open-sweep.mjs')

let failures = 0
const say = (ok, kind, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${kind}  ${msg}`)
  if (!ok) failures++
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

// Build a throwaway repo whose origin/main contains `files`, then point the
// sweep at it. origin/main is written directly as a remote-tracking ref, so no
// network and no real remote are involved.
function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mut-sbo-'))
  git(dir, ['init', '--quiet', '-b', 'work'])
  git(dir, ['config', 'user.email', 'a@b.c'])
  git(dir, ['config', 'user.name', 'mutcheck'])
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'fixture'])
  const sha = git(dir, ['rev-parse', 'HEAD']).stdout.trim()
  git(dir, ['update-ref', 'refs/remotes/origin/main', sha])
  return dir
}

function run(dir, issues, extraEnv = {}) {
  const r = spawnSync('node', [SWEEP], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SHIPPED_SWEEP_ISSUES_JSON: JSON.stringify(issues), ...extraEnv }
  })
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() }
}

const IMPL = 'packages/telegram-bridge/src/bridge.js'
const TEST = 'packages/telegram-bridge/src/bridge.test.js'
const ISSUES = [{ number: 111, title: 'a fix that shipped' }]

// ---------------------------------------------------------------- BASELINE
{
  const dir = makeRepo({ [IMPL]: '// carry the ask in the pointer (GH #111)\nexport const x = 1\n' })
  const r = run(dir, ISSUES)
  say(r.code === 1 && /FINDINGS: 1 open issue/.test(r.out), 'BASELINE', 'an open issue cited in impl source is reported SHIPPED')
  say(/SHIPPED \(awaiting his review, do NOT pick up\): 1/.test(r.out), 'BASELINE', 'and the count is exactly 1, not merely non-zero')
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------- NEG 1
{
  const dir = makeRepo({ [IMPL]: 'export const x = 1\n' })
  const r = run(dir, ISSUES)
  say(r.code === 0 && /unworked \(safe to pick up\)\s+: 1/.test(r.out), 'NEG', 'an issue cited nowhere is unworked, and the sweep is silent')
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------- NEG 2
// A test naming an issue is not the issue being fixed.
{
  const dir = makeRepo({ [TEST]: "it('regression for GH #111', () => {})\n" })
  const r = run(dir, ISSUES)
  const ok = r.code === 0 && /unworked/.test(r.out) && /#111/.test(r.out) && /Cited only in tests/.test(r.out)
  say(ok, 'NEG', 'cited only in a test -> not shipped, but listed so the judgement is visible')
  rmSync(dir, { recursive: true, force: true })
}

// --------------------------------------------------------------------- MUT
// Remove the citation from the impl file. The finding must vanish. If it does
// not, the sweep is reporting something other than what it claims to read.
{
  const dir = makeRepo({ [IMPL]: '// no issue named here\nexport const x = 1\n' })
  const before = run(dir, [{ number: 111, title: 't' }])
  say(before.code === 0 && !/FINDINGS/.test(before.out), 'MUT', 'strip the citation -> finding vanishes')
  rmSync(dir, { recursive: true, force: true })

  const dir2 = makeRepo({ [IMPL]: '// GH #111\nexport const x = 1\n' })
  const after = run(dir2, [{ number: 111, title: 't' }])
  say(after.code === 1 && /FINDINGS/.test(after.out), 'MUT', 'restore it on the identical fixture -> finding returns (baseline pairs)')
  rmSync(dir2, { recursive: true, force: true })
}

// ------------------------------------------------------------- WORD BOUNDARY
// A bare number collides: `git grep 515` matches "$515-520" in an unrelated
// fixture. #1111 must not satisfy a query for #111.
{
  const dir = makeRepo({ [IMPL]: '// GH #1111\nexport const x = 1\n' })
  const r = run(dir, [{ number: 111, title: 't' }])
  say(r.code === 0 && !/FINDINGS/.test(r.out), 'BOUNDARY', '#1111 does not satisfy a query for #111')

  const r2 = run(dir, [{ number: 1111, title: 't' }])
  say(r2.code === 1 && /FINDINGS/.test(r2.out), 'BOUNDARY', 'but #1111 itself still matches (the arm is not vacuous)')
  rmSync(dir, { recursive: true, force: true })
}

// --------------------------------------------------------------------- MIX
// The count must be a count, not a boolean.
{
  const dir = makeRepo({
    [IMPL]: '// GH #111 and GH #222\nexport const x = 1\n',
    [TEST]: "it('GH #333', () => {})\n"
  })
  const r = run(dir, [
    { number: 111, title: 'shipped one' },
    { number: 222, title: 'shipped two' },
    { number: 333, title: 'test only' },
    { number: 444, title: 'nowhere' }
  ])
  const ok =
    r.code === 1 &&
    /SHIPPED \(awaiting his review, do NOT pick up\): 2/.test(r.out) &&
    /unworked \(safe to pick up\)\s+: 2/.test(r.out)
  say(ok, 'MIX', 'two shipped, two not -> reports 2 and 2, not "some"')
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ NO REPO
// Absent inputs must be reported as a FINDING, not as a pass. The original
// version of this arm asserted exit 0, and that was wrong in the way that
// mattered: the suite reads a zero as health, so the sweep ran registered for
// ten minutes measuring nothing and reporting ok (GH #632). "Says nothing was
// measured" on stdout is not a signal if the exit code contradicts it.
//
// SHIPPED_SWEEP_REPO is forced at a non-checkout because this file LIVES in the
// real repo, so the fallback would otherwise resolve it and the arm would
// silently measure the wrong subject -- a vacuous arm, which is the trap this
// suite exists to avoid.
{
  const dir = mkdtempSync(join(tmpdir(), 'mut-sbo-bare-'))
  const r = run(dir, ISSUES, { SHIPPED_SWEEP_REPO: dir })
  const ok = r.code !== 0 && /nothing to measure/.test(r.out) && /this is not a pass/.test(r.out)
  say(ok, 'NOREPO', 'no checkout -> reported as a finding, not a silent pass')
  rmSync(dir, { recursive: true, force: true })
}

// -------------------------------------------------------- CWD INDEPENDENCE
// The #632 regression, pinned. The suite runs sweeps from the planner data
// folder, which is not a checkout. Before the fix the sweep read process.cwd()
// and gave up there, so the registered sweep and the hand-run sweep -- same
// binary, same commit, one cwd apart -- disagreed completely.
//
// Paired, so it cannot pass vacuously: the same fixture must classify from
// INSIDE the repo and from a directory that is not a repo at all.
{
  const dir = makeRepo({ [IMPL]: '// fixes GH #111\nexport const x = 1\n' })
  const outside = mkdtempSync(join(tmpdir(), 'mut-sbo-outside-'))
  const inside = run(dir, ISSUES)
  const elsewhere = run(outside, ISSUES, { SHIPPED_SWEEP_REPO: dir })

  say(/SHIPPED[^:]*: 1/.test(inside.out), 'BASELINE', 'from inside the checkout it classifies (pairs with the next arm)')
  say(
    /SHIPPED[^:]*: 1/.test(elsewhere.out) && elsewhere.code === inside.code,
    'CWD',
    'run from a non-checkout it still classifies -- cwd is not the subject (#632)'
  )

  // The second #632 instance, and the more dangerous one. `git grep <rev> --
  // packages plugins` resolves pathspecs relative to cwd, so resolving to any
  // directory inside the work tree rather than its ROOT finds nothing and
  // reports "no open issue is already shipped" with exit 0. That is not a
  // failure a reader can see: it is the healthy answer, arrived at wrongly.
  const sub = join(dir, 'packages', 'telegram-bridge', 'src')
  const fromSub = run(sub, ISSUES)
  say(
    /SHIPPED[^:]*: 1/.test(fromSub.out),
    'SUBDIR',
    'from a subdirectory it resolves the repo ROOT, not a confident empty answer'
  )
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

// ------------------------------------------------------------- EMPTY TRACKER
{
  const dir = makeRepo({ [IMPL]: '// GH #111\nexport const x = 1\n' })
  const r = run(dir, [])
  say(r.code === 0 && /no open issues/.test(r.out), 'EMPTY', 'no open issues -> clean, and it says why')
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failures) {
  console.log(`FAILED: ${failures} arm(s) disagreed. The sweep is not doing what it claims.`)
  process.exit(1)
}
console.log('OK: every arm agreed, and each baseline fires on the identical fixture')
console.log('    its paired negative clears. The sweep is load-bearing.')
process.exit(0)
