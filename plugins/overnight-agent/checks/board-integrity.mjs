#!/usr/bin/env node
// board-integrity.mjs — audits the Focus Planner boards for structural defects.
//
// Complements board-gaps.mjs, which only walks board -> journal. This walks the
// other direction and across boards, catching the classes that guard cannot see:
//
//   DUPE-OPEN       same id listed twice inside planner.md
//   DUPE-COMPLETED  same id listed twice inside planner-completed.md
//   BOTH-BOARDS     id is open AND completed at the same time      (#280 resurrection)
//   ID-COLLISION    one id reused by two materially different tasks (#281 broken ids)
//   ZERO-CLOCK      sync-journal entry persisted with clock:0       (#280 root cause)
//   ORPHAN-JOURNAL  journal file with no row on either board        (#445)
//   NO-JOURNAL      board row with no journal file
//
// ZERO-CLOCK is the mechanism behind BOTH-BOARDS. The *.sync.json files are
// last-writer-wins CRDT journals keyed by task id: {clock, deleted, fp}. An
// entry written with clock:0 (epoch) can never win a merge against the opposing
// board's entry, so that board's stale row is resurrected on every sync and the
// task ends up listed twice. Measured 2026-08-24: the 8 BOTH-BOARDS ids were
// exactly the 8 live clock:0 entries in planner-completed.md.sync.json.
//
// Usage:
//   $env:PLANNER_PATH='C:\Users\shiv\OneDrive\Apps\Focus Planner'
//   node board-integrity.mjs [--json] [--quiet]
//
// Exit code 0 = clean, 1 = defects found, 2 = bad invocation. Dependency-free.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const planner = process.env.PLANNER_PATH
if (!planner) {
  console.error('PLANNER_PATH is required (folder containing planner.md)')
  process.exit(2)
}

const asJson = process.argv.includes('--json')
const quiet = process.argv.includes('--quiet')

const openPath = join(planner, 'planner.md')
const donePath = join(planner, 'planner-completed.md')
const journalDir = join(planner, 'journal')

for (const p of [openPath, donePath]) {
  if (!existsSync(p)) {
    console.error(`missing board file: ${p}`)
    process.exit(2)
  }
}

// A row id may carry an external ticket, e.g. `| 439,[170](https://...) |`.
// Only the leading digits are the planner id.
const ROW = /^\|\s*(\d+)(?:\s*,[^|]*)?\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/

function readRows(path) {
  const rows = []
  let section = null
  let lineNo = 0
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    lineNo++
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      section = h[1]
      continue
    }
    const m = ROW.exec(line)
    if (!m) continue
    if (m[1] === undefined) continue
    rows.push({ id: m[1], icon: m[2], title: m[3], line: lineNo, section })
  }
  return rows
}

// Normalise a title so cosmetic rewording doesn't read as a different task.
function norm(t) {
  return String(t)
    .toLowerCase()
    .replace(/·.*$/, '')          // drop trailing "· _Done by me_" style suffixes
    .replace(/—.*$/, '')          // drop trailing em-dash outcome notes
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
}

// Jaccard-ish overlap against the shorter title, so a long outcome note that
// still starts with the original wording is treated as the same task.
function similar(a, b) {
  const A = new Set(norm(a))
  const B = new Set(norm(b))
  if (!A.size || !B.size) return 1
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / Math.min(A.size, B.size)
}

const openRows = readRows(openPath)
const doneRows = readRows(donePath)

// Sync journals: { version, updatedAt, entries: { <id>: {clock, deleted, fp} } }.
// Absent or unreadable is not a defect — older planner folders may predate them.
function readSync(path) {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && parsed.entries ? parsed.entries : null
  } catch {
    return null
  }
}

const openSync = readSync(`${openPath}.sync.json`)
const doneSync = readSync(`${donePath}.sync.json`)

// clock:0 on a live entry — the entry can never win last-writer-wins.
function zeroClockIds(entries) {
  const out = new Set()
  if (!entries) return out
  for (const [id, e] of Object.entries(entries)) {
    if (id === '__frame__' || !e) continue
    if (!e.deleted && Number(e.clock) === 0) out.add(id)
  }
  return out
}

const openZero = zeroClockIds(openSync)
const doneZero = zeroClockIds(doneSync)

const journalIds = existsSync(journalDir)
  ? readdirSync(journalDir)
      .map((f) => /^task-(\d+)\.md$/.exec(f))
      .filter(Boolean)
      .map((m) => m[1])
  : []

const findings = []
const add = (kind, id, detail, rows) => findings.push({ kind, id, detail, rows })

function dupesWithin(rows, kind, label) {
  const by = new Map()
  for (const r of rows) {
    if (!by.has(r.id)) by.set(r.id, [])
    by.get(r.id).push(r)
  }
  for (const [id, group] of by) {
    if (group.length < 2) continue
    const collision = similar(group[0].title, group[1].title) < 0.5
    add(
      collision ? 'ID-COLLISION' : kind,
      id,
      collision
        ? `id reused by ${group.length} materially different tasks on ${label}`
        : `listed ${group.length}x on ${label}`,
      group.map((r) => `L${r.line}: ${r.title}`)
    )
  }
}

dupesWithin(openRows, 'DUPE-OPEN', 'planner.md')
dupesWithin(doneRows, 'DUPE-COMPLETED', 'planner-completed.md')

const openById = new Map(openRows.map((r) => [r.id, r]))
const doneById = new Map(doneRows.map((r) => [r.id, r]))

for (const [id, o] of openById) {
  const d = doneById.get(id)
  if (!d) continue
  const zeroSide = [openZero.has(id) ? 'planner.md' : null, doneZero.has(id) ? 'planner-completed.md' : null]
    .filter(Boolean)
    .join(' + ')
  add(
    'BOTH-BOARDS',
    id,
    zeroSide
      ? `open and completed simultaneously — clock:0 on ${zeroSide} (see ZERO-CLOCK)`
      : 'open and completed simultaneously',
    [`planner.md L${o.line} [${o.section}]: ${o.title}`, `planner-completed.md L${d.line}: ${d.title}`]
  )
}

// Report clock:0 entries that still have a real row on their own board. Those are
// the ones that actively lose merges; a clock:0 entry with no row is inert.
for (const [label, zeros, byId] of [
  ['planner.md', openZero, openById],
  ['planner-completed.md', doneZero, doneById],
]) {
  for (const id of zeros) {
    if (!byId.has(id)) continue
    const twin = label === 'planner.md' ? doneById.has(id) : openById.has(id)
    add(
      'ZERO-CLOCK',
      id,
      twin
        ? `clock:0 in ${label}.sync.json — already losing to its twin row (BOTH-BOARDS)`
        : `clock:0 in ${label}.sync.json — will lose any future merge; primed to double-list`,
      [`${label} L${byId.get(id).line}: ${byId.get(id).title}`]
    )
  }
}

const boardIds = new Set([...openById.keys(), ...doneById.keys()])
for (const id of journalIds) {
  if (!boardIds.has(id)) add('ORPHAN-JOURNAL', id, 'journal exists with no board row', [`journal/task-${id}.md`])
}
const journalSet = new Set(journalIds)
for (const id of boardIds) {
  if (!journalSet.has(id)) add('NO-JOURNAL', id, 'board row has no journal file', [])
}

const order = ['ID-COLLISION', 'BOTH-BOARDS', 'ZERO-CLOCK', 'DUPE-OPEN', 'DUPE-COMPLETED', 'NO-JOURNAL', 'ORPHAN-JOURNAL']
findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Number(a.id) - Number(b.id))

const counts = {}
for (const k of order) counts[k] = findings.filter((f) => f.kind === k).length

if (asJson) {
  console.log(JSON.stringify({ counts, totals: { open: openRows.length, completed: doneRows.length, journals: journalIds.length }, findings }, null, 2))
} else {
  console.log(`boards: ${openRows.length} open rows, ${doneRows.length} completed rows, ${journalIds.length} journals`)
  console.log(order.map((k) => `${k}=${counts[k]}`).join('  '))
  if (!quiet) {
    let last = null
    for (const f of findings) {
      if (f.kind !== last) {
        console.log(`\n== ${f.kind} ==`)
        last = f.kind
      }
      if (f.kind === 'ORPHAN-JOURNAL' || f.kind === 'NO-JOURNAL') {
        console.log(`  #${f.id} — ${f.detail}`)
      } else {
        console.log(`  #${f.id} — ${f.detail}`)
        for (const r of f.rows) console.log(`      ${r}`)
      }
    }
  }
}

process.exit(findings.length ? 1 : 0)
