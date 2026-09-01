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
function resolve(entry) {
  if (entry.path) {
    const p = expand(entry.path)
    return existsSync(p) ? [p] : [{ missing: p }]
  }
  const pattern = expand(entry.glob)
  const dir = dirname(pattern)
  const [pre, post] = basename(pattern).split('*')
  if (!existsSync(dir)) return [{ missing: dir }]
  return readdirSync(dir)
    .filter((f) => f.startsWith(pre) && f.endsWith(post))
    .map((f) => join(dir, f))
}

const findings = []
const acknowledged = []
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

console.log(
  findings.length
    ? `\nread-path-budget: ${findings.length} finding(s).`
    : `\nread-path-budget: clean (${Object.keys(observed).length} files measured, ` +
        `${acknowledged.length} acknowledged).`
)
process.exit(findings.length ? 1 : 0)
