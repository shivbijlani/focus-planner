// mutcheck-meta-nodrop.mjs
//
// Mutation check for the #190 fix in merge.js: a live meta entry whose parsed
// record is missing on BOTH sides must never be dropped with no tombstone. That
// silent void is what made task #228's row vanish from the board — "no sidecar
// entry at all, in either board's sidecar" — while its journal stayed live and
// unreachable.
//
// WHY THIS FILE EXISTS (the house rule, docs/spec/Rebuilding.md and every
// mutcheck-*.mjs here): "a detector that goes to zero right after you edit it has
// not necessarily been fixed" and "mutation-check the GUARDS, not just the
// matcher." The fix in merge.js is four moving parts inside one branch — preserve
// the entry, keep it ALIVE (not a tombstone), stamp the HIGHEST known clock, emit
// NO record (so the #46 fingerprint crash guard still holds) — plus a logged
// anomaly. A guard that is only prose has repeatedly been broken in this repo, so
// each part below is broken by exactly one arm and caught by exactly one test.
//
// STRICTLY 1:1 / NO MISAIMED ARMS: the harness fails unless the arm→test kill
// matrix is a bijection — every arm is killed by exactly one test, and no test
// kills two arms. An arm caught by a second test is "misaimed" (it proves less
// than it claims); a test that catches two arms is not pinning a single guard.
//
// Everything runs in-process against the REAL merge.js and mutated copies written
// into this same directory (so their relative `../../diagnostics` import still
// resolves), exactly like mutcheck-reversible-gate.mjs. No planner state, live or
// otherwise, is read or written.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import * as baseline from './merge.js'
import {
  clearDiagnostics,
  dumpDiagnostics,
  enableDiagnostics,
  resetDiagnosticsForTests,
} from '../../diagnostics/src/index.js'

const DIR = import.meta.dirname
const MERGE = path.join(DIR, 'merge.js')
const SRC = fs.readFileSync(MERGE, 'utf8')

// ── fixtures (fresh objects per call: mergeCollections reads its inputs) ──────
const bothPhantom = () => [
  { records: {}, meta: { 228: { clock: 1000, deleted: false } } },
  { records: {}, meta: { 228: { clock: 1000, deleted: false } } },
  { now: 5000 },
]
const singleSided = () => [
  { records: {}, meta: { 228: { clock: 7, deleted: false } } },
  { records: {}, meta: {} },
  { now: 5000 },
]
const asym = (a, b) => [
  { records: {}, meta: { r: { clock: a, deleted: false } } },
  { records: {}, meta: { r: { clock: b, deleted: false } } },
  { now: 5000 },
]

// ── the tests. Each returns true when the property HOLDS (i.e. the test PASSES).
// A test "kills" a module when it returns false for it. ──────────────────────
const TESTS = {
  // Both sides mark 228 alive but neither has the record → the entry must be
  // preserved ALIVE, not turned into (or left as) a tombstone-less void.
  'stays-alive': (M) => {
    const m = M.mergeCollections(...bothPhantom())
    return !!m.meta['228'] && m.meta['228'].deleted === false
  },
  // The exact #228 two-replica shape: only ONE side still marks 228 alive, the
  // other never had it, neither has the record. The entry must still survive.
  'single-sided': (M) => {
    const m = M.mergeCollections(...singleSided())
    return Object.prototype.hasOwnProperty.call(m.meta, '228')
  },
  // The preserved clock must be the highest known alive clock, symmetrically —
  // a lower clock would be primed to lose every future merge (#280).
  'max-clock': (M) => {
    const f = M.mergeCollections(...asym(7, 3))
    const r = M.mergeCollections(...asym(3, 7))
    return f.meta.r?.clock === 7 && r.meta.r?.clock === 7
  },
  // Preserving the META must never emit a RECORD: a content-less winner is the
  // undefined-content row that crashed fingerprint() in #46.
  'no-record': (M) => {
    const m = M.mergeCollections(...bothPhantom())
    return !Object.prototype.hasOwnProperty.call(m.records, '228')
  },
  // The preservation must be a LOGGED anomaly, never a silent no-op.
  'diag': (M) => {
    resetDiagnosticsForTests()
    clearDiagnostics()
    enableDiagnostics({ persist: false })
    M.mergeCollections(...bothPhantom())
    const hit = dumpDiagnostics().some((e) => e.event === 'phantom-meta-preserved')
    resetDiagnosticsForTests()
    return hit
  },
}

// ── the arms. Each is a surgical one-line break of the fix, paired with the ONE
// test that must catch it. ───────────────────────────────────────────────────
const ARMS = {
  // Keep it, but as a tombstone: a row still alive on another replica would be
  // wrongly killed. (First occurrence of this line in the file is the #190 fix,
  // which sits before the ordinary alive-winner branch — a single-line anchor so
  // it is robust to CRLF/LF.)
  'alive-flag': {
    kills: 'stays-alive',
    mutate: (s) => s.replace(
      'mergedMeta[id] = { clock, deleted: false }',
      'mergedMeta[id] = { clock, deleted: true }',
    ),
  },
  // Only preserve when BOTH sides are alive → the single-sided #228 shape voids.
  'require-both': {
    kills: 'single-sided',
    mutate: (s) => s.replace(
      'if (localAliveClock !== null || remoteAliveClock !== null) {',
      'if (localAliveClock !== null && remoteAliveClock !== null) {',
    ),
  },
  // Stamp the LOWEST clock → the row is primed to lose every future merge.
  'clock-min': {
    kills: 'max-clock',
    mutate: (s) => s.replace(
      'const clock = Math.max(localAliveClock ?? 0, remoteAliveClock ?? 0)',
      'const clock = Math.min(localAliveClock ?? 0, remoteAliveClock ?? 0)',
    ),
  },
  // "Fix" the void by naively emitting the record too → reintroduces the #46
  // undefined-content crash shape. (Same first-occurrence anchor as alive-flag;
  // each arm mutates a fresh copy, so they never interfere.)
  'emit-record': {
    kills: 'no-record',
    mutate: (s) => s.replace(
      'mergedMeta[id] = { clock, deleted: false }',
      'mergedMeta[id] = { clock, deleted: false }; mergedRecords[id] = winner.content',
    ),
  },
  // Log under the wrong event → the anomaly is no longer discoverable.
  'diag-event': {
    kills: 'diag',
    mutate: (s) => s.replace(
      "diag('folder-sync.merge', 'phantom-meta-preserved', {",
      "diag('folder-sync.merge', 'phantom-meta-WRONG-EVENT', {",
    ),
  },
}

const TEST_NAMES = Object.keys(TESTS)
let mutSeq = 0
const strays = []

function runTests(M) {
  const killed = []
  for (const name of TEST_NAMES) {
    let pass = false
    try { pass = TESTS[name](M) === true } catch { pass = false }
    if (!pass) killed.push(name)
  }
  return killed
}

async function importMutant(src) {
  const p = path.join(DIR, `_mut-meta-${process.pid}-${mutSeq++}.mjs`)
  fs.writeFileSync(p, src, 'utf8')
  strays.push(p)
  try {
    return await import(`${pathToFileURL(p).href}?v=${mutSeq}`)
  } finally {
    // Keep the file until the run ends so the module URL stays resolvable; a
    // final sweep + a hygiene assertion guarantee nothing is left behind.
  }
}

const failures = []
function check(cond, msg) { if (!cond) failures.push(msg) }

const matrix = {} // arm -> [killer test names]

async function main() {
  // 0. Baseline: the REAL merge.js must pass every test. A test that is red on
  //    the fixed code proves nothing when it later goes red on a mutant.
  const baseKilled = runTests(baseline)
  check(baseKilled.length === 0, `baseline (unmutated merge.js) failed tests: ${baseKilled.join(', ') || '(none)'}`)

  // 1. Each arm: mutate, import, run the whole test set, record the kill set.
  for (const [arm, def] of Object.entries(ARMS)) {
    const mutatedSrc = def.mutate(SRC)
    if (mutatedSrc === SRC) { check(false, `arm '${arm}': mutation was a no-op — the anchor text moved`); matrix[arm] = []; continue }
    const M = await importMutant(mutatedSrc)
    matrix[arm] = runTests(M)
  }

  // 2. Each arm must be killed by EXACTLY its paired test.
  for (const [arm, def] of Object.entries(ARMS)) {
    const killed = matrix[arm] ?? []
    check(killed.length === 1, `arm '${arm}': expected to be killed by exactly 1 test, got [${killed.join(', ')}]`)
    check(killed.length === 1 && killed[0] === def.kills,
      `arm '${arm}': expected killer '${def.kills}', got [${killed.join(', ')}]`)
  }

  // 3. STRICT 1:1 the other way — no single test may kill two arms (no misaimed
  //    arms). Build the reverse map and assert every killer test kills one arm.
  const byTest = {}
  for (const [arm, killed] of Object.entries(matrix)) {
    for (const t of killed) (byTest[t] ??= []).push(arm)
  }
  for (const [t, arms] of Object.entries(byTest)) {
    check(arms.length === 1, `test '${t}' killed ${arms.length} arms [${arms.join(', ')}] — a misaimed arm breaks strict 1:1`)
  }
  // And every test must be load-bearing for exactly one arm (a test that kills
  // nothing is decoration; a guarantee with no arm is unproven).
  for (const name of TEST_NAMES) {
    check((byTest[name] ?? []).length === 1, `test '${name}' is the killer for ${(byTest[name] ?? []).length} arms — expected exactly 1`)
  }

  // 4. Hygiene: no mutant files left behind (a stray _mut-*.mjs would be linted).
  for (const p of strays) { try { fs.rmSync(p, { force: true }) } catch { /* ignore */ } }
  const leftovers = fs.readdirSync(DIR).filter((f) => f.startsWith('_mut-meta-'))
  check(leftovers.length === 0, `hygiene: mutant files left behind: ${leftovers.join(', ')}`)

  // ── report ────────────────────────────────────────────────────────────────
  const arms = Object.keys(ARMS)
  console.log('mutcheck-meta-nodrop — arm → killer test (strict 1:1):')
  for (const arm of arms) console.log(`  ${arm.padEnd(14)} -> [${(matrix[arm] ?? []).join(', ')}]`)
  console.log('')
  if (failures.length) {
    console.log(`FAILED: ${failures.length} problem(s)`) 
    for (const f of failures) console.log(`  - ${f}`)
    console.log(`\n${arms.length} arms, ${TEST_NAMES.length} tests`)
    process.exit(1)
  }
  console.log(`OK: ${arms.length} arms each killed by exactly 1 of ${TEST_NAMES.length} tests; baseline green; matrix is a bijection.`)
  process.exit(0)
}

main().catch((e) => {
  // Best-effort cleanup even on an unexpected throw.
  for (const p of strays) { try { fs.rmSync(p, { force: true }) } catch { /* ignore */ } }
  console.error('mutcheck-meta-nodrop crashed:', e)
  process.exit(1)
})
