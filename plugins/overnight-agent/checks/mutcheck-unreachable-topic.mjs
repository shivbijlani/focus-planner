// mutcheck-unreachable-topic.mjs
//
// Proves `unreachable-topic-sweep.mjs` is load-bearing rather than decorative.
//
// WHY THIS IS NOT OPTIONAL HERE
// -----------------------------
// The sweep it checks exists because a fix that shipped, passed its tests and moved nothing
// was indistinguishable from one that worked. A guard against that failure which was itself
// silently not running would be the same bug wearing the guard's clothes -- and that is not
// hypothetical: twice on 2026-09-08 an arm was written that could never fail, once because
// the guard under test sat inside a conditional block it never entered. Every negative case
// passed, meaninglessly, and only a BASELINE paired on the identical fixture exposed it.
//
// So each arm below is paired: a fixture that MUST produce a finding, and the same fixture
// mutated so it MUST NOT. If either half disagrees, the sweep is not deciding on the thing
// it claims to decide on, and this exits non-zero.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SUT = path.join(import.meta.dirname, 'unreachable-topic-sweep.mjs')
if (!fs.existsSync(SUT)) {
  console.error(`FAIL: cannot find the sweep under test at ${SUT}`)
  process.exit(2)
}
console.log(`SUT: ${SUT}\n`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unreach-'))

function run(tasks) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'))
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, tasks }), 'utf8')
  const r = spawnSync(process.execPath, [SUT], {
    encoding: 'utf8',
    env: { ...process.env, TELEGRAM_BRIDGE_STATE_DIR: dir },
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// A topic the bridge posted to and can still edit.
const REACHABLE = { topicId: 1, name: '#1 x', lastPostedHash: 'h', lastPostedMessageIds: [10] }
// A topic the bridge posted to and cannot find: hash present, ids absent. The real defect.
const UNREACHABLE = { topicId: 2, name: '#2 y', lastPostedHash: 'h' }

let failures = 0
function arm(name, tasks, mustFind, why) {
  const { code, out } = run(tasks)
  const found = code !== 0
  const ok = found === mustFind
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    console.log(`      expected ${mustFind ? 'a finding' : 'no finding'}; got exit ${code}`)
    console.log(`      ${why}`)
    console.log(out.split('\n').map((l) => '      | ' + l).join('\n'))
  }
  return out
}

// --- BASELINE: the defect must be detected -----------------------------------------------
const base = arm('BASELINE  unreachable topic is reported', { 2: UNREACHABLE }, true,
  'a posted-but-unlocatable topic is the entire subject of the sweep')

// The baseline must also COUNT it, not merely exit non-zero for some unrelated reason.
if (!/UNREACHABLE\s*:\s*1\b/.test(base)) {
  failures++
  console.log('FAIL  BASELINE does not report exactly 1 unreachable topic')
  console.log('      exiting non-zero for the wrong reason still reads as a pass')
}

// --- NEGATIVES: each must NOT fire, so the baseline above means something -----------------
arm('NEG  a topic it can still edit is not a finding', { 1: REACHABLE }, false,
  'ids present means the collapse path can reach it; flagging it would be noise')

arm('NEG  a topic never posted to is not a finding', { 3: { topicId: 3, name: '#3 z' } }, false,
  'no hash means no turn was ever posted there -- nothing is stacked')

arm('NEG  no bound topics at all', {}, false,
  'an empty board is clean, not broken')

// --- MUTATION: remove the evidence and the finding must disappear -------------------------
// If this still reports a finding, the sweep is keying off something other than the missing
// ids -- i.e. it would report 208 topics for a reason unrelated to reachability.
arm('MUT  give the unreachable topic its ids back -> finding must vanish',
  { 2: { ...UNREACHABLE, lastPostedMessageIds: [11] } }, false,
  'writing down the location is precisely the fix; the sweep must notice it')

// If this stops reporting, the sweep is keying off the hash alone rather than the pairing.
arm('MUT  strip the hash from an unreachable topic -> finding must vanish',
  { 2: { topicId: 2, name: '#2 y' } }, false,
  'without a hash there is no evidence a turn was ever posted, so nothing is unreachable')

// --- MIXED: the count must be a count, not a boolean --------------------------------------
const mixed = arm('MIX  two unreachable among reachable ones', {
  1: REACHABLE, 2: UNREACHABLE, 4: { topicId: 4, name: '#4 w', lastPostedHash: 'h' },
}, true, 'the number is the deliverable; a boolean cannot show a fix moving it')
if (!/UNREACHABLE\s*:\s*2\b/.test(mixed) || !/reachable\s*:\s*1\b/.test(mixed)) {
  failures++
  console.log('FAIL  MIX did not report 2 unreachable / 1 reachable')
  console.log('      a sweep whose count is wrong cannot show a fix moving it')
}

// --- ABSENT STATE: must be OK, and must SAY it measured nothing ---------------------------
const emptyDir = fs.mkdtempSync(path.join(tmp, 'nostate-'))
const r = spawnSync(process.execPath, [SUT], {
  encoding: 'utf8',
  env: { ...process.env, TELEGRAM_BRIDGE_STATE_DIR: emptyDir },
})
const quiet = r.status === 0 && /nothing to measure/.test(r.stdout || '')
if (!quiet) failures++
console.log(`${quiet ? 'PASS' : 'FAIL'}  NOSTATE  absent state exits OK and says it measured nothing`)
if (!quiet) console.log('      silently reporting 0 unreachable would be a false clean')

fs.rmSync(tmp, { recursive: true, force: true })

console.log()
if (failures) {
  console.log(`FAIL: ${failures} arm(s) disagreed -- the sweep is not deciding on reachability.`)
  process.exit(2)
}
console.log('OK: every arm agreed, and the baseline fires on the identical fixture the')
console.log('    negatives clear. The sweep is load-bearing.')
process.exit(0)
