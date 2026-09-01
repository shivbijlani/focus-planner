#!/usr/bin/env node
/**
 * Mutation check for #307 — proves the new tests are load-bearing.
 *
 * Same shape as PR #306's `mutcheck-meta-nodrop.mjs`. Each arm reverts exactly
 * one part of the fix in `src/focusPlanOps.js`, re-runs the #307 suite, and
 * requires that the arm is KILLED (some test fails). An arm that survives means
 * the corresponding guarantee is untested.
 *
 *   node scripts/mutcheck-wake-migration.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'src', 'focusPlanOps.js')
const suite = 'src/boardWakeMigration.test.js'

/**
 * Each arm reverts one behaviour to its pre-fix form.
 */
const ARMS = [
  {
    name: 'legacy-read',
    why: 'stop reading the legacy <!-- snooze:DATE --> trailer off the raw line — the original data loss',
    from: 'const legacyWake = parseLegacySnoozeComment(rawLine)\n    const nextCells',
    to: 'const legacyWake = null\n    const nextCells',
  },
  {
    name: 'skip-mismatched-rows',
    why: 'restore the `cells.length === headers.length` guard that skipped short rows',
    from: '    const nextCells = normalizeRowToHeaders(cells, headers, insertIndex)',
    to: '    if (cells.length !== table.headers.length) continue\n    const nextCells = normalizeRowToHeaders(cells, headers, insertIndex)',
  },
  {
    name: 'pad-at-end',
    why: 'pad short rows at the END instead of at the Wake seam, so a trailing 295 slides into Wake',
    from: '    return [...head, ...fill, ...tail]',
    to: '    return [...head, ...tail, ...fill]',
  },
  {
    name: 'no-conflict-diag',
    why: 'drop the wake-migration-conflict anomaly',
    from: "      reportWakeAnomaly('wake-migration-conflict', {",
    to: "      reportWakeAnomaly('wake-migration-conflict-DISABLED', {",
  },
  {
    name: 'no-section-move-diag',
    why: 'drop the wake-dropped-on-section-move anomaly',
    from: "    reportWakeAnomaly('wake-dropped-on-section-move', {",
    to: "    reportWakeAnomaly('wake-dropped-on-section-move-DISABLED', {",
  },
  {
    name: 'section-move-legacy-fallback',
    why: 'stop carrying the legacy date across a section move',
    from: '        || legacyWake\n        || \'\'',
    to: '        || \'\'',
  },
]

const original = readFileSync(target, 'utf8')

/**
 * Anchors are written with `\n`, but the working tree may be CRLF. Match on a
 * line-ending-agnostic regex so an arm is never silently "stale" just because
 * of checkout settings.
 */
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const anchorRe = s => new RegExp(escapeRe(s).replace(/\\?\n/g, '\\r?\\n'))
const applyArm = (source, arm) => {
  const re = anchorRe(arm.from)
  if (!re.test(source)) return null
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return source.replace(re, arm.to.replace(/\n/g, eol))
}

const runSuite = () => {
  try {
    execFileSync('npx', ['vitest', 'run', suite], { cwd: root, stdio: 'pipe', shell: true })
    return { passed: true }
  } catch (err) {
    return { passed: false, out: String(err.stdout || '') }
  }
}

console.log('# mutcheck: #307 wake migration\n')
const baseline = runSuite()
if (!baseline.passed) {
  console.error('BASELINE IS RED — fix the suite before mutating.')
  console.error(baseline.out)
  process.exit(1)
}
console.log('baseline: GREEN\n')

let survived = 0
for (const arm of ARMS) {
  const mutated = applyArm(original, arm)
  if (mutated === null) {
    console.log(`  ?? ${arm.name}: anchor not found — arm is stale`)
    survived++
    continue
  }
  writeFileSync(target, mutated, 'utf8')
  const result = runSuite()
  writeFileSync(target, original, 'utf8')
  const verdict = result.passed ? 'SURVIVED (untested!)' : 'killed'
  if (result.passed) survived++
  console.log(`  ${result.passed ? '!!' : 'ok'} ${arm.name.padEnd(30)} ${verdict}`)
  console.log(`     ${arm.why}`)
}

writeFileSync(target, original, 'utf8')
console.log(`\n${ARMS.length - survived}/${ARMS.length} arms killed.`)
process.exit(survived === 0 ? 0 : 1)
