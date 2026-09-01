// mutcheck-read-path-budget.mjs -- prove the guards in read-path-budget-sweep.mjs are
// load-bearing (GH #293).
//
// Every arm re-introduces a hole that would make the sweep report success while missing the
// thing it exists to catch. An arm that stops failing means its guard has become decorative,
// which is the failure mode this file detects: a safety check that quietly does nothing
// still reports clean.
//
//   m1  contract check disabled          -> an agent-written every-run file passes   (g1)
//   m2  budget comparison disabled       -> an oversized file passes                 (g2)
//   m3  a NEW breach treated as known    -> baseline swallows a new regression       (g3)
//   m4  growth tolerance ignored         -> a known file can grow forever            (g3)
//   m5  exception accepted with no issue -> an alarm can be silenced untracked       (g1)
//   m6  the sweep writes to disk         -> read-only is not actually enforced
//   m7  `optional` swallows any absence  -> a vanished required file passes          (g4)
//
// Each arm is verified in BOTH directions: the scenario must fail against the real script
// (proving the scenario is live) and pass against the mutant (proving the guard is what
// caught it). A scenario that never failed would otherwise "kill" its arm by doing nothing.
//
// Run:  node mutcheck-read-path-budget.mjs
// Exit: 0 all mutations killed; 1 a mutation SURVIVED.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'read-path-budget-sweep.mjs'), 'utf8')

const created = []
let n = 0

function newFixture({ manifest, baseline, journals }) {
  const root = join(tmpdir(), `oa293-${process.pid}-${n++}`)
  const planner = join(root, 'planner')
  const checks = join(root, 'checks')
  mkdirSync(join(planner, 'journal'), { recursive: true })
  mkdirSync(checks, { recursive: true })
  created.push(root)

  // Every default manifest row points at a real file, so a scenario only varies what it means to.
  writeFileSync(join(planner, 'user-settings.md'), 'x'.repeat(1024))
  writeFileSync(join(planner, 'agent-lore.md'), 'x'.repeat(400 * 1024))
  for (const [name, kb] of Object.entries(journals ?? {})) {
    writeFileSync(join(planner, 'journal', name), 'x'.repeat(Math.round(kb * 1024)))
  }
  writeFileSync(join(checks, 'read-path-manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(checks, 'read-path-baseline.json'), JSON.stringify(baseline ?? { known: {} }, null, 2))
  return { root, planner, checks }
}

// Compliant by construction; each scenario bends exactly one field.
const okManifest = (over = {}) => ({
  tolerancePct: 15,
  files: [
    { id: 'user-settings', path: '{planner}/user-settings.md', owner: 'user', writer: 'app', readPath: 'every-run', budgetKB: 120 },
    { id: 'agent-lore', path: '{planner}/agent-lore.md', owner: 'agent', writer: 'agent', readPath: 'on-demand', budgetKB: null },
    {
      id: 'journals', glob: '{planner}/journal/task-*.md', owner: 'shared', writer: 'agent+user',
      readPath: 'every-run', budgetKB: 64, contractException: { issue: 291, reason: 'tracked' }, ...over,
    },
  ],
})

function run(fx, scriptText = SRC, env = {}) {
  const script = join(fx.checks, 'read-path-budget-sweep.mjs')
  writeFileSync(script, scriptText)
  try {
    const out = execFileSync(process.execPath, [script], {
      env: { ...process.env, PLANNER_PATH: fx.planner, OA_SKILL_DIR: fx.checks, ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

function snapshot(dir) {
  const seen = {}
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue
    seen[join(f.parentPath ?? f.path, f.name)] = statSync(join(f.parentPath ?? f.path, f.name)).size
  }
  return JSON.stringify(seen)
}

const cleanup = () => { for (const d of created) { try { rmSync(d, { recursive: true, force: true }) } catch {} } }

// ------------------------------------------------------------------- scenarios --
// Shared by the baseline and the mutation arms, so both exercise the identical shape.
const S = {
  contractUnexcepted: () => newFixture({ manifest: okManifest({ contractException: undefined }), journals: { 'task-1.md': 10 } }),
  newBreach: () => newFixture({ manifest: okManifest(), journals: { 'task-2.md': 200 } }),
  grown: () => newFixture({ manifest: okManifest(), journals: { 'task-4.md': 300 }, baseline: { known: { 'task-4.md': 200 } } }),
  exceptionNoIssue: () => newFixture({ manifest: okManifest({ contractException: { reason: 'no issue' } }), journals: { 'task-6.md': 10 } }),
  requiredMissing: () => {
    const m = okManifest()
    m.files[0].path = '{planner}/does-not-exist.md'
    return newFixture({ manifest: m, journals: {} })
  },
}

// -------------------------------------------------------------------- baseline --
const fails = []
let asserts = 0
const check = (name, cond) => { asserts++; if (!cond) fails.push(name) }

{
  const r1 = run(newFixture({ manifest: okManifest(), journals: { 'task-1.md': 10 } }))
  check('clean tree exits 0', r1.code === 0)
  check('clean tree says clean', /clean/.test(r1.out))

  const r2 = run(S.newBreach())
  check('new breach exits 1', r2.code === 1)
  check('new breach names the file', /OVER\s+task-2\.md/.test(r2.out))

  const r3 = run(newFixture({ manifest: okManifest(), journals: { 'task-3.md': 200 }, baseline: { known: { 'task-3.md': 200 } } }))
  check('known stable breach exits 0', r3.code === 0)
  check('known stable breach is acknowledged', /known: task-3\.md/.test(r3.out))

  const r4 = run(S.grown())
  check('grown breach exits 1', r4.code === 1)
  check('grown breach reported as GROWING', /GROWING\s+task-4\.md/.test(r4.out))

  const r5 = run(S.contractUnexcepted())
  check('unexcepted contract violation exits 1', r5.code === 1)
  check('unexcepted contract violation says CONTRACT', /CONTRACT\s+journals/.test(r5.out))

  check('exception without an issue exits 1', run(S.exceptionNoIssue()).code === 1)

  const mMissing = okManifest()
  mMissing.files[0].path = '{planner}/does-not-exist.md'
  const rMiss = run(newFixture({ manifest: mMissing, journals: {} }))
  check('missing declared path exits 1', rMiss.code === 1 && /MISSING/.test(rMiss.out))

  // `optional` exists for files the app scaffolds on first use (the agent gate, #288).
  // Absent-and-optional is acknowledged; absent-and-required is still a finding above.
  const mOpt = okManifest()
  mOpt.files[0].path = '{planner}/does-not-exist.md'
  mOpt.files[0].optional = true
  const rOpt = run(newFixture({ manifest: mOpt, journals: {} }))
  check('missing OPTIONAL path exits 0', rOpt.code === 0)
  check('missing optional path is reported anyway', /optional: user-settings/.test(rOpt.out))

  const mNoBudget = okManifest()
  mNoBudget.files[0].budgetKB = null
  const rNb = run(newFixture({ manifest: mNoBudget, journals: {} }))
  check('every-run row with no budget exits 1', rNb.code === 1 && /COVERAGE/.test(rNb.out))

  // The agent-lore case: agent-written is legitimate precisely BECAUSE it is off the read
  // path, so an unbudgeted on-demand row must not be a finding.
  check('on-demand row with no budget is fine', run(newFixture({ manifest: okManifest(), journals: { 'task-7.md': 1 } })).code === 0)

  // run-sweeps.ps1 classifies stderr-with-no-stdout as CRASH rather than a clean pass,
  // which is the whole reason that wrapper exists. Honour the contract.
  const r8 = run(newFixture({ manifest: okManifest(), journals: {} }), SRC, { PLANNER_PATH: '' })
  check('unset PLANNER_PATH exits 1', r8.code === 1)
  check('unset PLANNER_PATH explains itself', /measured nothing/.test(r8.out))

  // The property that makes this safer than the rewriting alternative, asserted not assumed.
  const fx9 = newFixture({ manifest: okManifest(), journals: { 'task-9.md': 200 } })
  const before9 = snapshot(fx9.planner)
  run(fx9)
  check('sweep writes nothing to the planner folder', snapshot(fx9.planner) === before9)
}

if (fails.length) {
  console.log(`[mutcheck] BASELINE FAILED: ${fails.join('; ')}`)
  cleanup()
  process.exit(1)
}
console.log(`[mutcheck] baseline OK (${asserts} assertions).`)

// ------------------------------------------------------------------- mutations --
const arms = [
  { name: 'm1 contract check disabled', scenario: S.contractUnexcepted,
    mutate: (s) => s.replace("entry.writer?.includes('agent') && entry.readPath === 'every-run'", 'false') },
  { name: 'm2 budget comparison disabled', scenario: S.newBreach,
    mutate: (s) => s.replace('if (sizeKB <= entry.budgetKB) continue', 'if (true) continue') },
  { name: 'm3 new breach treated as known', scenario: S.newBreach,
    mutate: (s) => s.replace('if (was == null) {', 'if (false) {') },
  { name: 'm4 growth tolerance ignored', scenario: S.grown,
    mutate: (s) => s.replace('sizeKB > was * (1 + tolerance)', 'false') },
  { name: 'm5 exception accepted with no issue', scenario: S.exceptionNoIssue,
    mutate: (s) => s.replace('if (ex?.issue) {', 'if (ex) {') },
  // Without this, `optional` becomes a blanket escape hatch: every missing file passes,
  // including a settings file that has genuinely vanished.
  { name: 'm7 optional swallows a required missing file', scenario: S.requiredMissing,
    mutate: (s) => s.replace('if (entry.optional) {', 'if (true) {') },
]

const survived = []
for (const arm of arms) {
  const mutated = arm.mutate(SRC)
  if (mutated === SRC) { survived.push(`${arm.name} (anchor did not match)`); continue }
  const real = run(arm.scenario())
  const mutant = run(arm.scenario(), mutated)
  if (real.code !== 1) survived.push(`${arm.name} (scenario did not fail on the real script)`)
  else if (mutant.code !== 0) survived.push(arm.name)
  else console.log(`[mutcheck] killed:   ${arm.name}`)
}

// m6's kill signal is a file appearing on disk, not an exit code.
{
  const name = 'm6 the sweep writes to disk'
  const mutated = SRC.replace(
    'const findings = []',
    "const findings = []\n;(await import('node:fs')).writeFileSync(join(planner, 'mutant-write.txt'), 'x')"
  )
  if (mutated === SRC) survived.push(`${name} (anchor did not match)`)
  else {
    const fx = newFixture({ manifest: okManifest(), journals: { 'task-9.md': 10 } })
    const before = snapshot(fx.planner)
    run(fx, mutated)
    if (snapshot(fx.planner) === before) survived.push(`${name} (a write went undetected)`)
    else console.log(`[mutcheck] killed:   ${name}`)
  }
}

cleanup()
if (survived.length) {
  console.log(`[mutcheck] FAIL - ${survived.length} mutation(s) survived:`)
  for (const s of survived) console.log(`  ${s}`)
  process.exit(1)
}
console.log(`[mutcheck] PASS - all ${arms.length + 1} mutations killed; every guard is load-bearing.`)
process.exit(0)
