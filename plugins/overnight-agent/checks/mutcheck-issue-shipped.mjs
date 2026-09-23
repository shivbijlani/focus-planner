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

// ------------------------------------------------------- REFERENTIAL vs FIX (#639)
//
// The defect this section pins: the check used to ask only "does #N appear in
// implementation source", so a comment RECALLING a past incident read exactly
// like a comment FIXING the issue. Measured on the live backlog, 45 of the 102
// open issues it called shipped are cited only referentially -- #442, which has
// no implementation at all, among them. That is the dangerous direction: a false
// `shipped` hides real work permanently, because nothing re-raises it.
//
// Every arm below is a VERBATIM line from the live repo, so these are
// regression fixtures rather than invented strings. Each referential arm is
// paired against an implementing arm in the same shape, because a rule that
// called everything referential would pass the first half and be useless.
{
  const REFERENTIAL = [
    // from run-sweeps.ps1 -- the line that defeated the previous attempt. The
    // interposed date breaks "live ... on #442" adjacency, so any vocabulary
    // matcher reads it as a fix; ONE such line carried the whole issue back.
    ['# live 2026-08-30 on #442: 15,400 chars of agent prose inside a region', 442],
    ['// Measured live on #442: the region the reader called human-authored', 442],
    ['// Established 2026-08-30, after the gate was measured failing OPEN on live task #442.', 442],
    ['// exactly the agent-programme cluster (#425, #442, #443, #399, #395 ...)', 442],
    ['//   human marker above kept owning it -- to the end of the region. Measured on #442:', 442],
    ['// advisory #433 warns about, and this file own header argues against', 433],
    ['// This is distinct from the known *phrasing* bug (#433): here the marker exists,', 433],
    ['// prose is one you stop reading (#433), and this one has to survive 400 journals.', 433],
    ['// That is the failure this header warns about, quoting #433: an advisory that always', 433],
    // position zero, but a WRAPPED SENTENCE rather than an annotation. This is
    // why (b) insists on the trailing `:`/dash: without it, prose continuing
    // from the line above reads as a fix.
    ['// #433 warns about and the trap catchup-doc-sweep own header argues against.', 433]
  ]
  const IMPLEMENTING = [
    ['// #588: bound but not yet written. Routine on the run a task is bound', 588],
    ['// #588 \u2014 bound to a doc that no wake has written yet. Counted apart', 588],
    [' * #588 \u2014 HAS THE BOUND DOC ACTUALLY BEEN WRITTEN?', 588],
    ['// #620 \u2014 the notice now rides here rather than in a message of its own', 620],
    ['// #620 \u2014 RETIRING THE SEPARATE NOTICE.', 620],
    // trailing attribution closing a section header, and a divider tail
    ['  G14 -- A QUESTION TO SHIV, DECLARED AS NOT NEEDING HIM (#618)', 618],
    ['  # --- G14: the declared ask must not contradict its own question (#618) ----', 618],
    // word tags
    ['// Issue #549. On 2026-09-05 task #471 first catch-up doc was built by reading', 549],
    ['# doc-encoding-invariant (added 2026-09-07, issue #549) \u2014 the THIRD surface', 549],
    ['// issue-shipped.mjs -- GH #635', 635]
  ]

  let refBad = 0
  for (const [line, n] of REFERENTIAL) {
    const dir = makeRepo({ [IMPL]: `${line}\nexport const x = 1\n` })
    const r = run(dir, [String(n)])
    if (r.code !== 0) {
      refBad++
      console.log(`      line read as a FIX: ${line.slice(0, 72)}`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
  say(refBad === 0, 'REFERENTIAL', `all ${REFERENTIAL.length} past-incident mentions read as unworked, not shipped`)

  let implBad = 0
  for (const [line, n] of IMPLEMENTING) {
    const dir = makeRepo({ [IMPL]: `${line}\nexport const x = 1\n` })
    const r = run(dir, [String(n)])
    if (r.code !== 1) {
      implBad++
      console.log(`      attribution read as a mention: ${line.slice(0, 66)}`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
  say(
    implBad === 0,
    'IMPLEMENTING',
    `all ${IMPLEMENTING.length} attributions still read as shipped (the referential arm is not vacuous)`
  )

  // The two directions must be separable in ONE file, which is the realistic
  // case: a file fixing #620 while recalling #442 is ordinary here.
  {
    const dir = makeRepo({
      [IMPL]: '// #620 \u2014 the notice rides in the pointer\n// Measured live on #442: 15,473 chars\nexport const x = 1\n'
    })
    const shippedOne = run(dir, ['620'])
    const otherOne = run(dir, ['442'])
    say(
      shippedOne.code === 1 && otherOne.code === 0,
      'MIXED',
      'one file, two citations: the fixed issue is shipped and the recalled one is not'
    )
    rmSync(dir, { recursive: true, force: true })
  }

  // The verdict must be per-LINE, not per-file: a single implementing line
  // among referential ones still means shipped.
  {
    const dir = makeRepo({
      [IMPL]: '// Measured live on #777: an old incident\n// more prose about #777 here\n// #777 \u2014 and here is the fix\n'
    })
    const r = run(dir, ['777'])
    say(r.code === 1, 'PER-LINE', 'one implementing line among referential ones is enough to read shipped')
    rmSync(dir, { recursive: true, force: true })
  }

  // And the reported reason must distinguish the two ways of being unworked,
  // so a reader can tell "nobody mentioned it" from "mentioned, never fixed".
  {
    const dir = makeRepo({ [IMPL]: '// Measured live on #888: an old incident\n' })
    const r = run(dir, ['888'])
    say(
      r.code === 0 && /only as a reference/.test(r.out),
      'REASON',
      'a referential-only issue says so, rather than looking like it was never mentioned'
    )
    rmSync(dir, { recursive: true, force: true })
  }
}

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
