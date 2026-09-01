// Verify the split result against the WEB APP's own parser, using the shipped module rather than
// a reimplementation. Two properties matter:
//   1. every settings row still parses (the form can still show/edit them)
//   2. the identity round-trip holds: serialize(md, parse(md).values) === md
//      -- this is what proves a trimmed cell did not break the byte-offset splicing the editor
//      uses to save, i.e. that the next user save will not corrupt the file.
import { readFileSync } from 'node:fs'
import { parseSettingsForm, serializeSettingsForm } from '../../../src/config/userSettingsForm.js'

const before = process.argv[2]
const after = process.argv[3]

function report(label, path) {
  const md = readFileSync(path, 'utf8')
  const rows = parseSettingsForm(md)
  const identity = serializeSettingsForm(md, rows.map((r) => r.value)) === md
  const sections = [...new Set(rows.map((r) => r.section))]
  return { label, path, bytes: md.length, rows: rows.length, identity, sections, labels: rows.map((r) => r.label) }
}

const b = report('before', before)
const a = report('after', after)

for (const r of [b, a]) {
  console.log(`\n=== ${r.label} ===`)
  console.log(`  bytes:            ${r.bytes}`)
  console.log(`  parsed rows:      ${r.rows}`)
  console.log(`  identity holds:   ${r.identity}`)
  console.log(`  sections:         ${r.sections.join(' | ')}`)
}

const lost = b.labels.filter((l) => !a.labels.includes(l))
const gained = a.labels.filter((l) => !b.labels.includes(l))
console.log(`\n=== row preservation ===`)
console.log(`  rows before: ${b.rows}  after: ${a.rows}`)
console.log(`  rows LOST:   ${lost.length}${lost.length ? ' -> ' + lost.map((s) => s.slice(0, 60)).join(' ; ') : ''}`)
console.log(`  rows GAINED: ${gained.length}${gained.length ? ' -> ' + gained.map((s) => s.slice(0, 60)).join(' ; ') : ''}`)

const ok = a.identity && lost.length === 0
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
