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
//   m8  growth ignored while under budget-> a runaway is only seen after it arrives  (g3)
//   m9  idPattern classification disabled-> a stray file is measured as a journal    (g6)
//   m10 a NEW stray treated as known     -> the offPath baseline swallows a new one  (g6)
//   m11 a companion accused as a stray   -> the sweep tells you to delete your work  (g6)
//   m12 collapse detection disabled      -> a journal loses 97% and passes           (g7)
//   m13 collapse read from `sizes` only  -> a KNOWN file's collapse is invisible     (g7)
//   m14 a NEW collapse treated as known  -> the shrank baseline swallows a new one   (g7)
//   m15 collapse reported as OVER/GROWING-> the finding prints the wrong remedy      (g7)
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
      id: 'journals', glob: '{planner}/journal/task-*.md',
      idPattern: '^task-\\d+\\.md$', strayPattern: '-(DESKTOP|LAPTOP)-[A-Z0-9]+\\.md$',
      owner: 'shared', writer: 'agent+user',
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
  // Under budget (40 KB vs 64 KB) but doubled against its recorded size. Before g5 this
  // was invisible: the budget test passed, so growth was never evaluated.
  grownUnderBudget: () => newFixture({
    manifest: okManifest(),
    journals: { 'task-8.md': 40 },
    baseline: { known: {}, sizes: { 'task-8.md': 20 } },
  }),
  stableUnderBudget: () => newFixture({
    manifest: okManifest(),
    journals: { 'task-8.md': 21 },
    baseline: { known: {}, sizes: { 'task-8.md': 20 } },
  }),
  // g6. The stray is deliberately UNDER budget (10 KB vs 64 KB). That is what makes the arm
  // discriminating: with classification disabled it is just a small journal and the sweep
  // goes clean, so only the idPattern guard can produce a finding here. Every g6 fixture
  // also carries a COMPANION deliverable, because the fixtures originally had none and that
  // is precisely why the one-bucket version passed its tests while accusing 150 real files.
  offPathStray: () => newFixture({
    manifest: okManifest(),
    journals: {
      'task-1.md': 10,
      'task-1-healthy-living.md': 10,
      'task-1-DESKTOP-P9116M3.md': 10,
    },
  }),
  offPathKnown: () => newFixture({
    manifest: okManifest(),
    journals: {
      'task-1.md': 10,
      'task-1-healthy-living.md': 10,
      'task-1-DESKTOP-P9116M3.md': 10,
    },
    baseline: { known: {}, offPath: { 'task-1-DESKTOP-P9116M3.md': 'sync-conflict copy, verified redundant' } },
  }),
  // Companions alone must be entirely silent -- no finding, no accusation, exit 0.
  companionsOnly: () => newFixture({
    manifest: okManifest(),
    journals: { 'task-1.md': 10, 'task-1-healthy-living.md': 10, 'task-1-backlog.md': 200 },
  }),
  // g7. THE #382 SHAPE, and the reason the guard reads `known` as well as `sizes`: the file
  // was an ACKNOWLEDGED BREACH (200 KB against a 64 KB budget) that collapsed to 6 KB. That
  // lands it under its budget and not growing, so every other test in the sweep passes it.
  collapsedKnown: () => newFixture({
    manifest: okManifest(),
    journals: { 'task-1.md': 6 },
    baseline: { known: { 'task-1.md': 200 } },
  }),
  // The within-budget half, via the `sizes` map.
  collapsedUnderBudget: () => newFixture({
    manifest: okManifest(),
    journals: { 'task-8.md': 2 },
    baseline: { known: {}, sizes: { 'task-8.md': 40 } },
  }),
  // Acknowledged in the baseline with a reason: recorded, printed, and NOT a finding.
  collapsedAck: () => newFixture({
    manifest: okManifest(),
    journals: { 'task-1.md': 6 },
    baseline: {
      known: { 'task-1.md': 200 },
      shrank: { 'task-1.md': 'app overwrote it 2026-09-01; history recovered to task-1.history.md' },
    },
  }),
  // THE FALSE-POSITIVE DIRECTION. 200 -> 150 KB is a real edit, not a data-loss event, and
  // it must stay silent. A collapse alarm that fires on ordinary editing is the permanently
  // red line this suite has twice been burned by.
  mildShrink: () => newFixture({
    manifest: okManifest(),
    journals: { 'task-1.md': 150 },
    baseline: { known: { 'task-1.md': 200 } },
  }),
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

  // g5: growth applies to files that are still within budget. Both directions, because a
  // guard that fires on everything is as useless as one that fires on nothing.
  const r10 = run(S.grownUnderBudget())
  check('under-budget growth exits 1', r10.code === 1)
  check('under-budget growth reported as GROWING', /GROWING\s+task-8\.md/.test(r10.out))
  check('under-budget growth says it is still within budget', /still under its/i.test(r10.out))

  const r11 = run(S.stableUnderBudget())
  check('under-budget file within tolerance exits 0', r11.code === 0)
  check('under-budget file within tolerance is not reported', !/GROWING/.test(r11.out))

  // g6: a file matching the glob but not the idPattern is off-path, not over-budget. The
  // class matters more than the count here -- OVER prints "shrink this", which is the wrong
  // action on a file nothing reads, so asserting it is NOT called OVER is the real check.
  const r12 = run(S.offPathStray())
  check('off-path stray exits 1', r12.code === 1)
  check('off-path stray reported as OFFPATH', /OFFPATH\s+task-1-DESKTOP-P9116M3\.md/.test(r12.out))
  check('off-path stray is NOT called a budget breach', !/OVER\s+task-1-DESKTOP/.test(r12.out))
  check('off-path stray names the real remedy', /not to shrink it/.test(r12.out))
  // The negative half: the genuine journal alongside it must still be measured normally.
  check('a real journal is unaffected by the idPattern', !/OFFPATH\s+task-1\.md/.test(r12.out))
  // THE DANGEROUS DIRECTION. A companion deliverable must never be accused, in any fixture
  // that also contains a real stray. This is the assertion the one-bucket version failed
  // against the live folder while passing every unit test it had.
  check('a companion deliverable is never accused', !/OFFPATH\s+task-1-healthy-living\.md/.test(r12.out))
  check('a companion deliverable is not told to be removed', !/healthy-living\.md.*remove/s.test(r12.out))

  const r13 = run(S.offPathKnown())
  check('known off-path stray exits 0', r13.code === 0)
  check('known off-path stray still prints in its own section', /known off-path file/.test(r13.out))
  check('known off-path stray is not silently dropped', /task-1-DESKTOP-P9116M3\.md/.test(r13.out))

  // Companions on their own are silent: not measured, not accused, and not a finding even
  // when one of them is far over what the budget would have been (200 KB vs 64 KB).
  const r13b = run(S.companionsOnly())
  check('companions alone exit 0', r13b.code === 0)
  check('companions alone produce no OFFPATH', !/OFFPATH/.test(r13b.out))
  check('an oversized companion is not a budget breach', !/OVER\s+task-1-backlog/.test(r13b.out))
  check('companions are counted in the summary', /companion/.test(r13b.out))

  // Backwards compatibility: a glob row with no idPattern behaves exactly as before, so
  // adding this field cannot change any other manifest row by accident.
  const r14 = run(newFixture({
    manifest: okManifest({ idPattern: undefined, strayPattern: undefined }),
    journals: { 'task-1.md': 10, 'task-1-DESKTOP-P9116M3.md': 10 },
  }))
  check('glob with no idPattern exits 0', r14.code === 0)
  check('glob with no idPattern classifies nothing', !/OFFPATH/.test(r14.out))

  // A typo in either pattern must not silently disable the guard it configures.
  const r15 = run(newFixture({
    manifest: okManifest({ idPattern: '^task-(\\d+\\.md$' }),
    journals: { 'task-1.md': 10 },
  }))
  check('unparseable idPattern exits 1', r15.code === 1)
  check('unparseable idPattern says so', /not a valid regex/.test(r15.out))

  const r16 = run(newFixture({
    manifest: okManifest({ strayPattern: '-(DESKTOP\\.md$' }),
    journals: { 'task-1.md': 10 },
  }))
  check('unparseable strayPattern exits 1', r16.code === 1)
  check('unparseable strayPattern names the field', /strayPattern/.test(r16.out))

  // g7: collapse. The #382 shape -- an acknowledged breach that lost 97% of itself, which
  // lands it under budget and not growing, so nothing else in this sweep can see it.
  const r17 = run(S.collapsedKnown())
  check('collapsed known file exits 1', r17.code === 1)
  check('collapsed known file reported as SHRANK', /SHRANK\s+task-1\.md/.test(r17.out))
  check('collapse names the size it fell from', /down from 200 KB/.test(r17.out))
  // The class matters more than the count, exactly as with g6: OVER means "shrink this" and
  // GROWING means "it is still getting bigger". Printing either against a file that just
  // lost its history sends a human to do the wrong thing.
  check('a collapse is NOT reported as a budget breach', !/OVER\s+task-1\.md/.test(r17.out))
  check('a collapse is NOT reported as growth', !/GROWING\s+task-1\.md/.test(r17.out))
  check('collapse names the real remedy', /whether history\s+was lost/.test(r17.out))

  const r18 = run(S.collapsedUnderBudget())
  check('collapsed within-budget file exits 1', r18.code === 1)
  check('collapsed within-budget file reported as SHRANK', /SHRANK\s+task-8\.md/.test(r18.out))

  const r19 = run(S.collapsedAck())
  check('acknowledged collapse exits 0', r19.code === 0)
  check('acknowledged collapse prints in its own section', /acknowledged collapse/.test(r19.out))
  check('acknowledged collapse still names the file', /task-1\.md/.test(r19.out))
  check('acknowledged collapse carries its reason', /history recovered/.test(r19.out))

  // The negative direction. An ordinary edit must be silent, or the guard becomes noise.
  const r20 = run(S.mildShrink())
  check('a routine shrink exits 0', r20.code === 0)
  check('a routine shrink is not reported', !/SHRANK/.test(r20.out))

  // A file with no recorded baseline size cannot have collapsed -- there is nothing to
  // compare against, and inventing one would accuse every newly-created file.
  const r21 = run(newFixture({ manifest: okManifest(), journals: { 'task-99.md': 1 } }))
  check('an unbaselined small file is not a collapse', r21.code === 0 && !/SHRANK/.test(r21.out))
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
  // Restores the pre-2026-09-01 hole: growth gated on already being over budget, so the
  // only file class that can still be caught early is the one already too big.
  { name: 'm8 growth ignored while a file is under budget', scenario: S.grownUnderBudget,
    mutate: (s) => s.replace('const grownUnderBudget =', 'const grownUnderBudget = false &&') },
  // Restores the exact 2026-09-01 misclassification: a OneDrive sync-conflict copy measured
  // as though it were a journal on the read path. The stray is under budget, so with this
  // guard disabled the sweep reports clean and the stray is invisible rather than merely
  // mislabelled.
  { name: 'm9 idPattern classification disabled', scenario: S.offPathStray,
    mutate: (s) => s.replace('if (!idRe || idRe.test(f)) return full', 'if (true) return full') },
  // The offPath baseline must acknowledge only what it names. Without this, one entry in
  // the list would swallow every future stray -- the g3 hole, in the new class.
  { name: 'm10 a new stray treated as known off-path', scenario: S.offPathStray,
    mutate: (s) => s.replace('if (wasKnown) {', 'if (true) {') },
  // g7. Restores the pre-#382 state exactly: two one-sided size tests and no `<` anywhere,
  // so a journal can lose 97% of itself and land in "stable within tolerance".
  { name: 'm12 collapse detection disabled', scenario: S.collapsedKnown,
    mutate: (s) => s.replace('if (recorded > 0 && sizeKB < recorded * shrinkFactor) {', 'if (false) {') },
  // The half that is easy to get wrong while looking correct. Reading only `sizes` catches
  // a within-budget file and misses the ACKNOWLEDGED BREACH -- which is the one class #382
  // actually happened to, and the one that goes quiet under budget afterwards.
  { name: 'm13 collapse read from `sizes` only', scenario: S.collapsedKnown,
    mutate: (s) => s.replace(
      'baseline.sizes?.[name] ?? baseline.known?.[name]', 'baseline.sizes?.[name]') },
  // The acknowledgement must cover only what it names, or the first recorded collapse
  // silently absorbs every later one -- "the app ate it" becoming the new normal, which is
  // the specific outcome the issue asks this guard to prevent.
  { name: 'm14 a new collapse treated as acknowledged', scenario: S.collapsedKnown,
    mutate: (s) => s.replace('if (why) {', 'if (true) {') },
]

const survived = []

// A mutation anchor is plain source text, so it can match PROSE as easily as code -- and
// this file is mostly prose. Found the hard way while adding g7: a new comment quoted the
// m4 anchor verbatim, `String.replace` hit that first occurrence, and the mutant differed
// from the original by one word inside a comment. The guard it was meant to disable was
// still fully armed.
//
// That direction was safe (the arm reported SURVIVED). The other direction is not: if an
// inert mutant happens to exit 0 for any unrelated reason, the arm prints `killed` and has
// proven nothing -- a check that quietly does nothing while reporting clean, which is the
// exact failure mode this file exists to detect, reproduced inside the detector itself.
//
// So a mutation must change CODE, not commentary. Comparing comment-stripped source is
// enough here (the sweep uses only line comments) and needs no change to how arms are
// written, which matters because the anchors live inside closures.
const codeOnly = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
const inert = (mutated) => codeOnly(mutated) === codeOnly(SRC)

for (const arm of arms) {
  const mutated = arm.mutate(SRC)
  if (mutated === SRC) { survived.push(`${arm.name} (anchor did not match)`); continue }
  if (inert(mutated)) { survived.push(`${arm.name} (anchor matched only a comment; mutation is inert)`); continue }
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
  else if (inert(mutated)) survived.push(`${name} (anchor matched only a comment; mutation is inert)`)
  else {
    const fx = newFixture({ manifest: okManifest(), journals: { 'task-9.md': 10 } })
    const before = snapshot(fx.planner)
    run(fx, mutated)
    if (snapshot(fx.planner) === before) survived.push(`${name} (a write went undetected)`)
    else console.log(`[mutcheck] killed:   ${name}`)
  }
}

// m11's kill signal is an accusation appearing against an innocent file, so its directions
// are inverted relative to the arms above: the real script must be SILENT and the mutant
// must speak. This is the one-bucket bug that shipped in the first draft of g6 and was
// caught only by running against the live folder -- so it gets an arm rather than a comment.
{
  const name = 'm11 a companion deliverable is accused as a stray'
  const mutated = SRC.replace('return { companion: full }', 'return { offPath: full }')
  if (mutated === SRC) survived.push(`${name} (anchor did not match)`)
  else if (inert(mutated)) survived.push(`${name} (anchor matched only a comment; mutation is inert)`)
  else {
    const real = run(S.companionsOnly())
    const mutant = run(S.companionsOnly(), mutated)
    if (real.code !== 0 || /OFFPATH/.test(real.out)) {
      survived.push(`${name} (the real script already accuses a companion)`)
    } else if (!/OFFPATH\s+task-1-healthy-living\.md/.test(mutant.out)) {
      survived.push(`${name} (the mutant's accusation went undetected)`)
    } else console.log(`[mutcheck] killed:   ${name}`)
  }
}

// m15 is inverted for the same reason as m11: its kill signal is a finding appearing against
// an innocent file. The threshold is deliberately LOOSE and deliberately SEPARATE from
// `tolerancePct` (see the g7 note in the sweep). Binding the two together is the natural
// tidy-up a future reader would make -- and it converts a data-loss alarm into one that
// fires on ordinary editing, which is precisely how this suite's other detectors went red
// permanently and stopped being read.
{
  const name = 'm15 collapse threshold tuned into tolerancePct'
  const mutated = SRC.replace('manifest.shrinkFactor ?? 0.5', '1 - tolerance')
  if (mutated === SRC) survived.push(`${name} (anchor did not match)`)
  else if (inert(mutated)) survived.push(`${name} (anchor matched only a comment; mutation is inert)`)
  else {
    const real = run(S.mildShrink())
    const mutant = run(S.mildShrink(), mutated)
    if (real.code !== 0 || /SHRANK/.test(real.out)) {
      survived.push(`${name} (the real script already fires on a routine shrink)`)
    } else if (!/SHRANK\s+task-1\.md/.test(mutant.out)) {
      survived.push(`${name} (the mutant's false positive went undetected)`)
    } else console.log(`[mutcheck] killed:   ${name}`)
  }
}

cleanup()
if (survived.length) {
  console.log(`[mutcheck] FAIL - ${survived.length} mutation(s) survived:`)
  for (const s of survived) console.log(`  ${s}`)
  process.exit(1)
}
console.log(`[mutcheck] PASS - all ${arms.length + 3} mutations killed; every guard is load-bearing.`)
process.exit(0)
