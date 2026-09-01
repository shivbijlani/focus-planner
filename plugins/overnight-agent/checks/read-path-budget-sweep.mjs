// read-path-budget-sweep.mjs -- enforce the file-layout contract (GH #292) and the
// read-path size budgets (GH #293). READ-ONLY: this sweep never opens a file for writing.
//
// WHY THIS EXISTS
// ---------------
// GH #262: `user-settings.md` grew to ~947,000 chars because the agent appended its own
// notes to a file SKILL.md reads at the start of every run. At ~97% of the context window
// per call, one run made 49 round-trips, sat in `running` for ~9 hours, never finished,
// and froze the */30 schedule.
//
// That was fixed by a script that REWRITES the file every run. This is the alternative the
// issue itself proposed and nobody built: "enforce a hard size cap on whatever is read at
// run start; fail loudly if exceeded."
//
// Loud failure beats silent repair here. Most of the rewriter's 492 lines are guards that
// exist BECAUSE it writes -- back up first, UTF-8 both directions, byte-exact reassembly,
// idempotency, preserve the row shape the web app splices by offset, re-read and roll back
// on mojibake. A read-only assertion needs none of them, and it cannot corrupt the file it
// is protecting or generate a OneDrive sync event every 30 minutes.
//
// WHAT IT CHECKS
//   g1 CONTRACT.  writer 'agent' + readPath 'every-run' is invalid. That combination is
//                 the defect class itself (#262 settings, #291 journals), so size cannot
//                 excuse it. A row may carry a `contractException` ONLY if it names a
//                 tracking issue -- an exception with no issue is a silenced alarm and is
//                 itself a finding.
//   g2 BUDGET.    A read-path file over its declared budget is reported.
//   g3 BASELINE.  Known breaches recorded in read-path-baseline.json are acknowledged and
//                 do NOT fail the run -- but GROWTH beyond tolerance does. The suite has
//                 already learned this twice (workflow-health-sweep, shadow-journal-sweep):
//                 a detector that is permanently red teaches every future run to skim it.
//                 13 journals are over budget today; failing on all 13 every night would
//                 make this check invisible within a week. Growth is the live signal.
//   g4 COVERAGE.  A declared file that is missing, or a manifest entry with no budget and
//                 no explicit exemption, is a finding -- a stale contract is not a passing
//                 one. A row marked `optional` may be absent (the agent gate is scaffolded
//                 by the app on first use) and reports as acknowledged instead.
//   g6 OFF-PATH.  A file that matches a glob but not that glob's declared `idPattern` is
//                 NOT on the read path, so it is not budget-checked -- it is reported as
//                 its own finding class. See below.
//
// WHY g6 EXISTS -- A BUDGET FINDING NAMES ITS OWN REMEDY, SO MISFILING ONE IS NOT COSMETIC
// ----------------------------------------------------------------------------------------
// The journals row globs `task-*.md`. OneDrive names a sync-conflict copy
// `task-463-DESKTOP-P9116M3.md`, which matches that glob, so the sweep measured a file the
// agent never reads and reported:
//
//     OVER  task-463-DESKTOP-P9116M3.md: 82.9 KB exceeds the 64 KB budget for 'journals'
//
// Every word of that is true and the conclusion is wrong. `OVER` means "this file is on the
// read path and too big", so its remedy is "make it smaller". The real remedy is "delete
// this stale duplicate" -- a different action, on a file no run ever opens. Measured
// 2026-09-01: `oa-state.ps1 scan` returned 239 rows, none of them the conflict copy.
//
// It was also unfixable by the agent and permanently red: deleting a file is gated by the
// `agent-gate.md` floor rule "Outcome can result in permanent data loss", so no run could
// ever clear it. This file already warns twice that a permanently-red detector teaches
// every future run to skim it -- a MISCLASSIFIED finding is worse than a red one, because
// the remedy it prints is work nobody should do.
//
// Fixed by DECLARING the read-path shape rather than inferring the conflict shape.
// Guessing at vendor naming (`-DESKTOP-*`, `(1)`, `conflicted copy`) fails on the next
// vendor and on a custom machine name. `idPattern` says positively what a real read-path
// file looks like, so anything else is off-path by construction -- the same reasoning that
// made `optional` a declared field: "a declared, reviewable field rather than an inferred
// one, so it cannot quietly spread". A glob with no `idPattern` behaves exactly as before.
//
// THE NEAR-MISS THAT SHAPED THIS -- WHY THERE ARE THREE CLASSES AND NOT TWO
// -------------------------------------------------------------------------
// The first version of this fix had one bucket: on-path, or "stray, remove it". Run against
// the real planner folder it printed "Remedy is to remove it" against 150 files -- because
// SKILL.md instructs the agent to write larger deliverables next to the journal as
// `task-<id>-<slug>.md`, and a sync-conflict copy (`task-463-DESKTOP-P9116M3.md`) has the
// SAME SHAPE as a deliverable (`task-370-healthy-living.md`). Measured: 239 journals, 153
// companions, 3 conflict copies.
//
// That is the identical defect this guard exists to fix -- a finding whose printed remedy
// is the wrong action -- except pointed at the user's own work, and it was invisible in the
// unit fixtures because they contained no companions. It was caught only by running the
// real script against the real folder. So: `idPattern` decides what is MEASURED, a separate
// `strayPattern` decides what is ACCUSED, and the gap between them is counted in silence.
// Getting `strayPattern` too narrow means a conflict copy goes uncounted; getting it too
// wide means accusing a deliverable. Those costs are not symmetric, so it is narrow.
//
// Exit 1 on findings, 0 when clean, matching every other sweep in run-sweeps.ps1.

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, 'read-path-manifest.json')
const BASELINE = join(HERE, 'read-path-baseline.json')

const planner = process.env.PLANNER_PATH
if (!planner) {
  // Exit 1 having measured nothing, and say so on stderr. run-sweeps.ps1 classifies a
  // sweep with stderr and no stdout as CRASH rather than FINDINGS, which is the whole
  // reason it exists: six sweeps once measured nothing and reported clean.
  console.error('read-path-budget: PLANNER_PATH is unset; measured nothing.')
  process.exit(1)
}
// Where SKILL.md actually lives, which depends on WHERE THIS COPY OF THE SWEEP IS.
// `../skills/overnight-agent` is only true in the repo. The copy that actually runs every
// night sits in the FLAT OA home, where `..` is %LOCALAPPDATA% and that path does not
// exist -- so the entry resolved to a phantom, the sweep reported it MISSING, and
// SKILL.md, the single largest every-run read after the settings file, was never measured
// at all. Same flat-home layout assumption that stranded this sweep's own manifest; a
// budget guard that silently measures nothing is the failure mode this file exists to
// prevent. Ordered candidates, first one that exists wins.
const skillDir = (() => {
  const candidates = [
    process.env.OA_SKILL_DIR,
    join(HERE, '..', 'skills', 'overnight-agent'),
    join(homedir(), '.copilot', 'installed-plugins', 'focus-planner',
         'overnight-agent', 'skills', 'overnight-agent')
  ].filter(Boolean)
  return candidates.find((c) => existsSync(join(c, 'SKILL.md'))) || candidates[1]
})()

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { known: {} }
const tolerance = (manifest.tolerancePct ?? 15) / 100

const expand = (p) => p.replace('{planner}', planner).replace('{skill}', skillDir)
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10

// Resolve one manifest entry to the concrete files it covers.
//
// A glob row may declare two optional patterns, and the split between them is the whole
// point (see the g6 note above):
//   `idPattern`    what a REAL read-path file looks like. Only these are budget-checked.
//   `strayPattern` what a known-bad ARTIFACT looks like. Only these are accused.
// Anything matching the glob but neither pattern is a legitimate companion file that is
// simply off the every-run read path -- counted, never accused.
function resolve(entry) {
  if (entry.path) {
    const p = expand(entry.path)
    return existsSync(p) ? [p] : [{ missing: p }]
  }
  const pattern = expand(entry.glob)
  const dir = dirname(pattern)
  const [pre, post] = basename(pattern).split('*')
  if (!existsSync(dir)) return [{ missing: dir }]
  // An unparseable pattern must not silently disable the check it configures, so it is
  // reported as a finding and the row falls back to its pre-configuration behaviour.
  const compile = (src, field) => {
    if (!src) return null
    try {
      return new RegExp(src)
    } catch {
      findings.push(
        `COVERAGE  ${entry.id}: ${field} '${src}' is not a valid regex; ` +
          `off-path classification is disabled for this row.`
      )
      return null
    }
  }
  const idRe = compile(entry.idPattern, 'idPattern')
  const strayRe = compile(entry.strayPattern, 'strayPattern')
  return readdirSync(dir)
    .filter((f) => f.startsWith(pre) && f.endsWith(post))
    .map((f) => {
      const full = join(dir, f)
      if (!idRe || idRe.test(f)) return full
      if (strayRe && strayRe.test(f)) return { offPath: full }
      return { companion: full }
    })
}

const findings = []
const acknowledged = []
const offPathAck = []
let companions = 0
const observed = {}

for (const entry of manifest.files) {
  // --- g1: the contract invariant. No size defence -- this is not a size question. ------
  if (entry.writer?.includes('agent') && entry.readPath === 'every-run') {
    const ex = entry.contractException
    if (ex?.issue) {
      // Acknowledged, and only because it names a tracking issue. An exception without an
      // issue number is a silenced alarm, so it is refused below. Growth still fails, so
      // an acknowledged row cannot quietly get worse.
      acknowledged.push(`  contract: ${entry.id} violates the contract, tracked in #${ex.issue}`)
    } else if (ex) {
      findings.push(
        `CONTRACT  ${entry.id}: has a contractException with no tracking issue. ` +
          `An exception that names no issue is a silenced alarm, not an accepted risk.`
      )
    } else {
      findings.push(
        `CONTRACT  ${entry.id}: writer='${entry.writer}' on the every-run read path. ` +
          `An agent-appended file that is read every run grows without bound and is paid for ` +
          `on every model call (GH #292)${entry.issue ? ` -- see #${entry.issue}` : ''}.`
      )
    }
  }

  // --- g4: a manifest entry must declare a budget or exempt itself explicitly. ---------
  const exempt = entry.readPath !== 'every-run'
  if (entry.budgetKB == null && !exempt) {
    findings.push(`COVERAGE  ${entry.id}: on the every-run read path with no declared budget.`)
    continue
  }

  for (const target of resolve(entry)) {
    // --- g6: matched the glob, but is not a read-path file. ------------------------------
    // Two outcomes, deliberately unequal. A COMPANION is a legitimate deliverable that
    // SKILL.md tells the agent to write next to the journal (`task-<id>-<slug>.md`); it is
    // merely off the every-run read path, so it is counted and nothing is claimed about it.
    // An OFFPATH file matched the declared stray shape and is accused by name.
    //
    // Measured 2026-09-01, and this is why the two are separate: the journal folder holds
    // 239 real journals, 153 companion deliverables, and 3 sync-conflict copies. A single
    // "not a journal" bucket would have printed "remedy is to remove it" against 150 of
    // Shiv's own deliverables -- a worse misclassification than the one g6 exists to fix,
    // and in the dangerous direction.
    if (typeof target === 'object' && target.companion) {
      companions++
      continue
    }
    if (typeof target === 'object' && target.offPath) {
      const name = basename(target.offPath)
      const wasKnown = baseline.offPath?.[name]
      const sizeKB = kb(statSync(target.offPath).size)
      if (wasKnown) {
        offPathAck.push(`  ${name} ${sizeKB} KB -- ${wasKnown}`)
      } else {
        findings.push(
          `OFFPATH   ${name}: ${sizeKB} KB matches the '${entry.id}' stray pattern ` +
            `(${entry.strayPattern}), so nothing reads it. This is not a budget breach -- ` +
            `it is a leftover artifact, typically a OneDrive sync-conflict copy. ` +
            `Remedy is to remove it, not to shrink it.`
        )
      }
      continue
    }
    if (typeof target === 'object' && target.missing) {
      // An `optional` row is one the app scaffolds on first use (the agent gate, #288). It
      // is legitimately absent until the user opens that page, so its absence is reported
      // but does not fail the run. Optionality is a declared, reviewable field rather than
      // an inferred one, so it cannot quietly spread.
      if (entry.optional) {
        acknowledged.push(`  optional: ${entry.id} not present yet -> ${target.missing}`)
      } else {
        findings.push(`MISSING   ${entry.id}: declared path does not exist -> ${target.missing}`)
      }
      continue
    }
    if (entry.budgetKB == null) continue

    const sizeKB = kb(statSync(target).size)
    const name = basename(target)
    observed[name] = sizeKB
    // --- g5: growth must not be gated on already being over budget. ---------------------
    // The budget answers "is this too big?". Only growth answers "is this doubling?", and
    // this file's own baseline calls growth "the live signal, because growth is the actual
    // defect". Yet growth was only ever evaluated after the budget test below, so a file
    // UNDER its budget fell through the `continue` and was never growth-checked at all.
    // Measured 2026-09-01: SKILL.md went 43 KB -> 78.5 KB in seven days (+16% in the final
    // day alone) against a 96 KB budget, and this sweep reported clean every single night.
    // A guard that can only see a runaway after it has already arrived is the failure mode
    // this file exists to prevent, so growth is now checked independently of the budget.
    const wasSize = baseline.sizes?.[name]
    const grownUnderBudget =
      wasSize != null && sizeKB <= entry.budgetKB && sizeKB > wasSize * (1 + tolerance)
    if (grownUnderBudget) {
      findings.push(
        `GROWING   ${name}: ${sizeKB} KB, up from ${wasSize} KB at baseline ` +
          `(+${Math.round(((sizeKB - wasSize) / wasSize) * 100)}%, tolerance ${manifest.tolerancePct}%). ` +
          `Still under its ${entry.budgetKB} KB budget, but growing faster than tolerance.`
      )
      continue
    }

    if (sizeKB <= entry.budgetKB) continue

    // --- g2 + g3: over budget. New or worsened is a finding; known and stable is not. ---
    const was = baseline.known?.[name]
    if (was == null) {
      findings.push(
        `OVER      ${name}: ${sizeKB} KB exceeds the ${entry.budgetKB} KB budget for ` +
          `'${entry.id}' (~${Math.round((sizeKB * 1024) / 4 / 1000)}K tokens to read).`
      )
    } else if (sizeKB > was * (1 + tolerance)) {
      findings.push(
        `GROWING   ${name}: ${sizeKB} KB, up from ${was} KB at baseline ` +
          `(+${Math.round(((sizeKB - was) / was) * 100)}%, tolerance ${manifest.tolerancePct}%). ` +
          `Known breach, but still growing.`
      )
    } else {
      acknowledged.push(`  known: ${name} ${sizeKB} KB (baseline ${was} KB, budget ${entry.budgetKB} KB)`)
    }
  }
}

for (const f of findings) console.log(f)

if (acknowledged.length) {
  console.log(`\n${acknowledged.length} acknowledged breach(es), stable within tolerance:`)
  for (const a of acknowledged.slice(0, 5)) console.log(a)
  if (acknowledged.length > 5) console.log(`  ... and ${acknowledged.length - 5} more`)
}

// Printed in full and in its own section rather than folded into the list above, which is
// truncated at 5. These are the only acknowledged entries the USER must clear -- the agent
// cannot, since removing a file is floor-blocked -- so burying them in a "... and N more"
// tail would hide the one class that needs a human.
if (offPathAck.length) {
  console.log(`\n${offPathAck.length} known off-path file(s) -- not read by any run; remove when convenient:`)
  for (const a of offPathAck) console.log(a)
}

console.log(
  findings.length
    ? `\nread-path-budget: ${findings.length} finding(s).`
    : `\nread-path-budget: clean (${Object.keys(observed).length} files measured, ` +
        `${acknowledged.length} acknowledged` +
        `${companions ? `, ${companions} companion` : ''}` +
        `${offPathAck.length ? `, ${offPathAck.length} off-path` : ''}).`
)
process.exit(findings.length ? 1 : 0)
