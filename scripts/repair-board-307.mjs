#!/usr/bin/env node
/**
 * #307 board repair — DRY RUN BY DEFAULT.
 *
 * Prints the exact changes it would make to a planner board and exits. It
 * writes nothing unless you pass `--write`, and it refuses to write if its own
 * post-repair verification fails.
 *
 * This gate is deliberate. The bug this repairs was caused by an unattended
 * rewrite of the user's primary board, so the repair must never be able to
 * repeat that by accident. Merging this script changes no user data.
 *
 *   node scripts/repair-board-307.mjs "C:\\path\\to\\planner.md"           # preview
 *   node scripts/repair-board-307.mjs "C:\\path\\to\\planner.md" --write   # apply
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

import { planBoardRepair, verifyBoardRepair, RECOVERED_WAKES } from '../src/boardRepair.js'

const args = process.argv.slice(2)
const write = args.includes('--write')
const file = args.find(a => !a.startsWith('--'))

if (!file) {
  console.error('usage: node scripts/repair-board-307.mjs <planner.md> [--write]')
  process.exit(2)
}

const original = readFileSync(file, 'utf8')
const { content, changes } = planBoardRepair(original)

console.log(`# board repair (#307) — ${write ? 'APPLY' : 'DRY RUN'}`)
console.log(`file: ${file}`)
console.log(`recovered wake dates available: ${Object.entries(RECOVERED_WAKES)
  .map(([id, v]) => `#${id}=${v.wake} (${v.source})`).join(', ')}`)
console.log(`\n${changes.length} change(s):\n`)
for (const c of changes) {
  console.log(c.kind === 'wake'
    ? `  [wake] #${c.id} -> ${c.wake}   (recovered from ${c.source})`
    : `  [pad ] #${c.id} ${c.from} cells -> ${c.to} cells`)
  console.log(`         - ${c.before}`)
  console.log(`         + ${c.after}`)
}

const verdict = verifyBoardRepair(content)
console.log(`\nverification: ${verdict.ok ? 'OK' : 'FAILED'}`)
if (!verdict.ok) {
  console.log('  malformed rows remaining:', verdict.malformed)
  console.log('  wake dates not restored :', verdict.missing)
}

if (!write) {
  console.log('\nDry run — nothing written. Re-run with --write to apply.')
  process.exit(0)
}
if (!verdict.ok) {
  console.error('\nRefusing to write: post-repair verification failed.')
  process.exit(1)
}
if (content === original) {
  console.log('\nNo changes needed; nothing written.')
  process.exit(0)
}

const backup = `${file}.307-backup`
copyFileSync(file, backup)
writeFileSync(file, content, 'utf8')
console.log(`\nWrote ${file} (backup at ${backup}).`)
