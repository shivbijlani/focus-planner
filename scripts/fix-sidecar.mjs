// One-off: regenerate a planner sidecar from the (already cleaned) markdown so
// that removed task IDs are properly TOMBSTONED — otherwise other sync replicas
// resurrect them. Mirrors exactly what the app does on a local edit:
//   parse(md) -> records -> stampLocalChanges(records, meta) -> serializeSidecar
//
// Usage: node scripts/fix-sidecar.mjs "<folder>" <mdFile> [--apply]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, FRAME_ID } from '../packages/folder-sync/src/codecs/mdTable.js'
import { parseSidecar, stampLocalChanges, serializeSidecar } from '../packages/folder-sync/src/merge.js'

const dir = process.argv[2]
const mdFile = process.argv[3] || 'planner.md'
const apply = process.argv.includes('--apply')
const mdPath = join(dir, mdFile)
const scPath = mdPath + '.sync.json'

const md = readFileSync(mdPath, 'utf8')
const { records, frame } = parse(md)
const all = { ...records }
all[FRAME_ID] = { frame }

const meta = parseSidecar(readFileSync(scPath, 'utf8'))
const aliveBefore = Object.entries(meta).filter(([, v]) => !v.deleted).map(([k]) => k)

const now = Date.now()
stampLocalChanges(all, meta, now)

const aliveAfter = Object.entries(meta).filter(([, v]) => !v.deleted).map(([k]) => k)
const tomb = Object.entries(meta).filter(([, v]) => v.deleted).map(([k]) => k)
const newlyTomb = aliveBefore.filter(k => meta[k]?.deleted)

const isId = (k) => /^\d+$/.test(k)
console.log('md records (alive):', Object.keys(records).sort((a, b) => a - b).join(','))
console.log('newly tombstoned   :', newlyTomb.filter(isId).sort((a, b) => a - b).join(','))
console.log('total tombstones   :', tomb.filter(isId).length)
console.log('alive after        :', aliveAfter.filter(isId).sort((a, b) => a - b).join(','))

if (apply) {
  writeFileSync(scPath, serializeSidecar(meta, now))
  console.log('APPLIED ->', scPath)
} else {
  console.log('(dry run — pass --apply to write)')
}
