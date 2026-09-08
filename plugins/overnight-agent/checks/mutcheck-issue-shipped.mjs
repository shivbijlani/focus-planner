#!/usr/bin/env node
// mutcheck-issue-shipped.mjs -- proves the preflight's EXIT CODE CONTRACT (GH #635).
//
// `mutcheck-shipped-but-open.mjs` already proves the classification is correct. This
// proves the thing a CALLER depends on, which is a different question and the one that
// actually failed in #632: what the process says on its way out.
//
// A run consults this before committing to work, and write-turn.ps1's G15 consults it on
// every journal turn. Both branch on the exit code, so these four values are the API:
//
//     0  every candidate unworked -- safe to pick up
//     1  at least one already shipped -- do NOT pick it up
//     2  could not classify. NOT a pass.
//     3  bad arguments
//
// 2 is the arm that matters most and the easiest to regress into 0, because 0 is what a
// tired reading of "nothing was found" suggests. The suite's convention is that silence
// plus 0 is health, so a blind gate exiting 0 is byte-identical to a gate that looked and
// cleared the work -- exactly how the sweep this file guards ran registered for ten
// minutes measuring nothing and reporting ok.
//
// Every arm is PAIRED against a fixture that must produce the OTHER answer. An arm that
// cannot fail proves nothing, and this suite has produced vacuous arms before.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'issue-shipped.mjs')

let failures = 0
const say = (ok, kind, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${kind}  ${msg}`)
  if (!ok) failures++
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

// A throwaway repo whose origin/main is written directly as a remote-tracking ref: no
// network, no real remote, and the fixture -- not this machine's checkout -- is the subject.
function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mut-pre-'))
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

// SHIPPED_SWEEP_REPO is forced on every arm. This file LIVES in the real repo, so without
// it the resolver's fallback would find the real checkout and every arm would silently
// measure the wrong subject -- passing, and meaning nothing.
function run(repo, args) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: tmpdir(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SHIPPED_SWEEP_REPO: repo }
  })
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() }
}

const IMPL = 'packages/telegram-bridge/src/bridge.js'
const CITED = { [IMPL]: '// carry the ask in the pointer (GH #111)\nexport const x = 1\n' }
const UNCITED = { [IMPL]: '// nothing named here\nexport const x = 1\n' }

// ------------------------------------------------------------------- EXIT 1 / EXIT 0
{
  const cited = makeRepo(CITED)
  const uncited = makeRepo(UNCITED)

  const shipped = run(cited, ['111'])
  say(shipped.code === 1 && /SHIPPED/.test(shipped.out), 'EXIT1', 'an already-shipped issue exits 1 and says so')
  say(/do NOT pick up/.test(shipped.out), 'EXIT1b', 'and tells the caller what to do, not just that something is wrong')

  // The pair. Same binary, same argument, one fixture apart.
  const clear = run(uncited, ['111'])
  say(clear.code === 0 && /safe to pick up/.test(clear.out), 'EXIT0', 'an uncited issue exits 0 (EXIT1 pairs)')

  // A count, not a boolean: one shipped among several must still refuse.
  const mixed = run(cited, ['111', '222'])
  say(mixed.code === 1 && /REFUSE: 1 of 2/.test(mixed.out), 'MIX', 'one shipped among two -> refuses, and reports 1 of 2')

  rmSync(cited, { recursive: true, force: true })
  rmSync(uncited, { recursive: true, force: true })
}

// ------------------------------------------------------------------------ EXIT 2
// The #632 lesson as an assertion. `origin/main` cannot be resolved in a directory that is
// not a checkout, so nothing was classified -- and that must NOT read as "all clear".
{
  const bare = mkdtempSync(join(tmpdir(), 'mut-pre-bare-'))
  const r = run(bare, ['111'])
  say(r.code === 2, 'EXIT2', 'unmeasurable exits 2 -- never 0, which the suite reads as health')
  say(/this is not a pass/.test(r.out), 'EXIT2b', 'and states it in words as well as in the exit code')
  rmSync(bare, { recursive: true, force: true })
}

// ------------------------------------------------------------------------ EXIT 3
{
  const cited = makeRepo(CITED)
  const r = run(cited, [])
  say(r.code === 3 && /usage:/.test(r.out), 'EXIT3', 'no arguments exits 3 with usage, distinct from both 0 and 2')
  rmSync(cited, { recursive: true, force: true })
}

// -------------------------------------------------------------------------- JSON
// G15 parses this. A shape change here silently disarms the guard, because a parse
// failure there is treated as "could not measure" -- which fails OPEN by design.
{
  const cited = makeRepo(CITED)
  const r = run(cited, ['--json', '111'])
  let parsed = null
  try { parsed = JSON.parse(r.out) } catch { /* stays null */ }
  say(parsed !== null, 'JSON', '--json emits parseable JSON on stdout and nothing else')
  say(parsed?.ok === true && Array.isArray(parsed?.results), 'JSONb', 'with the ok/results shape write-turn.ps1 G15 reads')
  say(parsed?.results?.[0]?.shipped === true && parsed?.results?.[0]?.n === 111, 'JSONc', 'and per-issue {n, shipped} that names which one')
  say(r.code === 1, 'JSONd', '--json keeps the same exit-code contract as the human output')
  rmSync(cited, { recursive: true, force: true })
}

// --------------------------------------------------------------------- BOUNDARY
// A bare number collides, and so does a longer one: #1111 must not answer for #111.
{
  const dir = makeRepo({ [IMPL]: '// GH #1111\nexport const x = 1\n' })
  say(run(dir, ['111']).code === 0, 'BOUNDARY', '#1111 does not satisfy a query for #111')
  say(run(dir, ['1111']).code === 1, 'BOUNDARYb', 'but #1111 itself still matches (the arm is not vacuous)')
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------------ KIND WEIGHTING
// A test or a doc naming an issue is not the issue being fixed. The dangerous direction
// is a false SHIPPED, which would block real work, so only implementation counts.
{
  const dir = makeRepo({ 'packages/telegram-bridge/src/bridge.test.js': "it('GH #111', () => {})\n" })
  const r = run(dir, ['111'])
  say(r.code === 0 && /not implementation/.test(r.out), 'KIND', 'cited only in a test -> unworked, and it shows its reasoning')
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failures) {
  console.log(`FAILED: ${failures} arm(s) disagreed. The preflight's contract is not what its callers assume.`)
  process.exit(1)
}
console.log('OK: every arm agreed, and each answer pairs against a fixture producing the other.')
process.exit(0)
