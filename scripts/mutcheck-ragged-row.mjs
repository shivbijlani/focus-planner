#!/usr/bin/env node
/**
 * Mutation check for #426 — proves the ragged-row tests are load-bearing.
 *
 * Same shape as `mutcheck-wake-migration.mjs` (#307), extended to mutate more
 * than one file: #426 is precisely a defect that spanned files. The writer was
 * already correct and the reader was not, so a check that could only mutate
 * `focusPlanOps.js` would have reported everything green while the bug was live.
 *
 * Each arm reverts exactly one part of the fix, re-runs `src/raggedRow.test.js`,
 * and requires the arm to be KILLED. An arm that survives means the guarantee it
 * targets is decorative — which is the failure mode this repo keeps closing:
 * assertions that pass against behaviour nothing actually depends on.
 *
 *   node scripts/mutcheck-ragged-row.mjs
 *
 * Exit 0 = every arm killed. Exit 1 = an arm survived, or is stale.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const suite = 'src/raggedRow.test.js'
// #446's guarantees live in their own suite; arms may opt into it per-arm so the
// two issues stay independently falsifiable rather than sharing one fixture set.
const MISFILED_SUITE = 'src/misfiledLinkedId.test.js'

const file = (...p) => join(root, ...p)
const BOARD_ROW = file('src', 'boardRow.js')
const BOARD_TABLE = file('src', 'boardTable.js')
const SNOOZE = file('src', 'snooze.js')
const APP = file('src', 'App.jsx')

const ARMS = [
  {
    name: 'reader-unaligned',
    target: BOARD_TABLE,
    why: 'THE BUG: index Linked ID off the raw row again — cells[6] on a 6-field row is undefined, so #451 loses 191',
    from: '    const aligned = normalizeRowCells(cells, sourceHeaders)',
    to: '    const aligned = cells',
  },
  {
    name: 'align-pad-at-end',
    target: BOARD_ROW,
    why: 'pad short rows at the END instead of at the Wake seam, so a trailing 191 slides into Wake',
    from: '    return [...head, ...fill, ...tail]',
    to: '    return [...head, ...tail, ...fill]',
  },
  {
    name: 'align-identity',
    target: BOARD_ROW,
    why: 'make alignment a no-op — the reader/writer agreement audit must notice',
    from: '  const width = headers.length\n  if (cells.length === width) return [...cells]',
    to: '  const width = headers.length\n  return [...cells]\n  // eslint-disable-next-line no-unreachable\n  if (cells.length === width) return [...cells]',
  },
  {
    name: 'align-drop-overwide-guard',
    target: BOARD_ROW,
    why: 'truncate an over-wide row to its LEFT-most cells, shifting the tail so a stray cell is read as the Linked ID',
    from: '  const keepTail = tail.slice(Math.max(0, tail.length - (width - head.length)))\n  return [...head.slice(0, width - keepTail.length), ...keepTail]',
    to: '  return cells.slice(0, width)',
  },
  {
    name: 'snooze-read-unaligned',
    target: SNOOZE,
    why: 'read Wake off the raw row — a date-shaped Linked ID would silently snooze a live task',
    from: '  return Array.isArray(headers) && headers.length > 0\n    ? normalizeRowCells(cells, headers)\n    : cells',
    to: '  return cells',
  },
  // ---- #446: the full-width case the #426 aligner cannot detect ----
  {
    name: 'recover-misfiled-noop',
    target: BOARD_ROW,
    suite: MISFILED_SUITE,
    why: 'THE #446 BUG: stop recovering a parent id misfiled into Wake, so #452 renders with no link again',
    from: '  next[linkIndex] = wake\n  next[wakeIndex] = \'\'\n  return next',
    to: '  return next',
  },
  {
    name: 'recover-ignores-date-guard',
    target: BOARD_ROW,
    suite: MISFILED_SUITE,
    why: 'drop the is-a-date guard, so a genuine wake date is moved into Linked ID and the snooze is destroyed',
    from: '  if (!wake || link || isDateOnly(wake)) return next',
    to: '  if (!wake || link) return next',
  },
  {
    name: 'recover-clobbers-existing-link',
    target: BOARD_ROW,
    suite: MISFILED_SUITE,
    why: 'drop the empty-Linked-ID guard, so a row that already has a link has it overwritten from Wake',
    from: '  if (!wake || link || isDateOnly(wake)) return next',
    to: '  if (!wake || isDateOnly(wake)) return next',
  },
  {
    name: 'snooze-write-skips-recovery',
    target: SNOOZE,
    suite: MISFILED_SUITE,
    why: 'THE HAZARD: read Wake with #426 alignment only, so snoozing #452 overwrites 204 with the date — permanently, no tombstone',
    from: '  return Array.isArray(headers) && headers.length > 0\n    ? normalizeRowCells(cells, headers)\n    : cells',
    to: '  return Array.isArray(headers) && headers.length > 0\n    ? alignRowToHeaders(cells, headers)\n    : cells',
    also: [{ from: 'import { normalizeRowCells } from \'./boardRow.js\'', to: 'import { alignRowToHeaders, normalizeRowCells } from \'./boardRow.js\'' }],
  },
  {
    name: 'snooze-clear-unaligned',
    target: SNOOZE,
    why: 'clear Wake at the raw index — erases a ragged row\'s Linked ID, and the following write then lands a date where the link was',
    from: '  const cells = wakeCells(cleanLine, headers)\n  if (cells.length <= wakeIndex) return cleanLine',
    to: '  const cells = parseCells(cleanLine)\n  if (cells.length <= wakeIndex) return cleanLine',
  },
  {
    name: 'app-reimplements-linked-write',
    target: APP,
    why: 'restore App.jsx\'s own parts[6] linked-id writer — the #307 defect, still live in the single-source view',
    from: '    const next = ops.opChangeLinkedId(content, rawLine, newLinkedId)\n    if (next !== content) await onContentUpdate(next)',
    to: '    const lines = content.split(\'\\n\')\n    const lineIndex = lines.findIndex(line => line.trim() === rawLine.trim())\n    if (lineIndex !== -1) {\n      const parts = rawLine.split(\'|\')\n      if (parts.length >= 7) {\n        parts[6] = ` ${newLinkedId || \'\'} `\n        lines[lineIndex] = parts.join(\'|\')\n        await onContentUpdate(lines.join(\'\\n\'))\n      }\n    }',
  },
]

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const anchorRe = s => new RegExp(escapeRe(s).replace(/\\?\n/g, '\\r?\\n'))
const applyEdit = (source, from, to) => {
  const re = anchorRe(from)
  if (!re.test(source)) return null
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return source.replace(re, to.replace(/\n/g, eol))
}
const applyArm = (source, arm) => {
  let next = applyEdit(source, arm.from, arm.to)
  if (next === null) return null
  // Some reversions need a companion edit (e.g. restoring an import the
  // mutation reintroduces). A missing companion is stale, not "close enough".
  for (const extra of arm.also || []) {
    next = applyEdit(next, extra.from, extra.to)
    if (next === null) return null
  }
  return next
}

const runSuite = (which = suite) => {
  try {
    execFileSync('npx', ['vitest', 'run', which], { cwd: root, stdio: 'pipe', shell: true })
    return { passed: true }
  } catch (err) {
    return { passed: false, out: String(err.stdout || '') }
  }
}

console.log('# mutcheck: #426 ragged Deferred rows + #446 misfiled Linked ID\n')
for (const s of [suite, MISFILED_SUITE]) {
  const baseline = runSuite(s)
  if (!baseline.passed) {
    console.error(`BASELINE IS RED (${s}) — fix the suite before mutating.`)
    console.error(baseline.out)
    process.exit(1)
  }
  console.log(`baseline ${s}: GREEN`)
}
console.log('')

let survived = 0
for (const arm of ARMS) {
  const original = readFileSync(arm.target, 'utf8')
  const mutated = applyArm(original, arm)
  if (mutated === null) {
    console.log(`  ?? ${arm.name.padEnd(30)} anchor not found — arm is stale`)
    survived++
    continue
  }
  writeFileSync(arm.target, mutated, 'utf8')
  let result
  try {
    result = runSuite(arm.suite || suite)
  } finally {
    writeFileSync(arm.target, original, 'utf8')
  }
  if (result.passed) survived++
  console.log(`  ${result.passed ? '!!' : 'ok'} ${arm.name.padEnd(30)} ${result.passed ? 'SURVIVED (untested!)' : 'killed'}`)
  console.log(`     ${arm.why}`)
}

console.log(`\n${ARMS.length - survived}/${ARMS.length} arms killed.`)
process.exit(survived === 0 ? 0 : 1)
