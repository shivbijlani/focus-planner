// truncation-openboard-scope.mjs -- WHICH truncated turns are on the OPEN board?
//
// WHY (2026-08-28 04:55 PT): telegram-ask-truncation-sweep answers "does the ASK survive?" and is
// green when it does. But a turn can keep its ask line and still lose deliverable links, PR numbers,
// options tables and run-log results below it. On a CLOSED task that is moot; on an OPEN one Shiv is
// reading a message with content silently missing.
//
// This is the scope half of tonight's learning: the metric was right, its population came from prose.
// So compute the population -- open board rows -- and report loss against it.
//
// Uses the SHIPPED parser + formatter (same imports as the ask sweep), never a reimplementation.
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const SRC = process.env.BRIDGE_SRC
const PLANNER = process.env.PLANNER_PATH
if (!SRC) { console.error('BRIDGE_SRC is not set'); process.exit(2) }
if (!PLANNER) { console.error('PLANNER_PATH is not set'); process.exit(2) }

const JOURNALS = join(PLANNER, 'journal')
const { latestAgentTurn } = await import(`${SRC}/journal.js`)
const { mdToTelegramHtml, escapeHtml } = await import(`${SRC}/telegramFormat.js`)

const TELEGRAM_MAX = 4096

function truncateMarkdown(md, budget) {
  if (md.length <= budget) return md
  const cut = md.slice(0, budget)
  const nl = cut.lastIndexOf('\n')
  return nl > 0 ? cut.slice(0, nl) : cut
}

function keptMarkdown(taskId, title, turn) {
  const header = title ? `\u{1F4CB} Task #${taskId} \u2014 ${title}` : `\u{1F4CB} Task #${taskId}`
  const headerHtml = `<b>${escapeHtml(header)}</b>`
  const room = Math.max(0, TELEGRAM_MAX - headerHtml.length - 2)
  let budget = Math.max(0, room - 400)
  let bodyHtml = mdToTelegramHtml(truncateMarkdown(turn, budget))
  while (bodyHtml.length > room && budget > 0) {
    const scaled = Math.floor((budget * room) / bodyHtml.length)
    budget = Math.max(0, Math.min(budget - 128, scaled))
    bodyHtml = mdToTelegramHtml(truncateMarkdown(turn, budget))
  }
  return truncateMarkdown(turn, budget)
}

// --- population: ids with a row on the OPEN board (computed, never quoted) ---
const openIds = new Set()
for (const line of readFileSync(join(PLANNER, 'planner.md'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*\|/)
  if (m) openIds.add(m[1])
}

// Markers that indicate real, actionable content rather than prose.
const SIGNALS = [
  [/\bmerge\s+\d+/gi, 'merge <n>'],
  [/\bPR\s*#\d+/gi, 'PR #<n>'],
  [/\bissue\s*#\d+/gi, 'issue #<n>'],
  [/\]\(\.\/[^)]+\)/g, 'deliverable link'],
  [/https?:\/\/\S+/g, 'url'],
  [/^\s*[-*]\s*\[\s\]/gm, 'checklist item'],
]

const rows = []
for (const f of readdirSync(JOURNALS)) {
  const m = f.match(/^task-(\d+)\.md$/)
  if (!m) continue
  const id = m[1]
  if (!openIds.has(id)) continue            // scope: open board only
  const content = readFileSync(join(JOURNALS, f), 'utf8')
  let turn
  try { turn = latestAgentTurn(content) } catch { continue }
  if (!turn) continue
  const body = typeof turn === 'string' ? turn : turn.text || turn.body || ''
  if (!body) continue
  const kept = keptMarkdown(id, '', body)
  if (kept.length >= body.length) continue  // not truncated
  const lost = body.slice(kept.length)

  const lostSignals = []
  for (const [re, label] of SIGNALS) {
    const inLost = (lost.match(re) || []).length
    const inKept = (kept.match(re) || []).length
    // only count a signal as lost if it does NOT also appear in the delivered part
    if (inLost > 0 && inKept === 0) lostSignals.push(`${label}x${inLost}`)
  }
  rows.push({
    id,
    total: body.length,
    kept: kept.length,
    pct: Math.round(((body.length - kept.length) / body.length) * 100),
    lostSignals,
  })
}

rows.sort((a, b) => b.pct - a.pct)
const withSignal = rows.filter(r => r.lostSignals.length > 0)

console.log(`open-board rows                       : ${openIds.size}`)
console.log(`...whose newest turn is TRUNCATED     : ${rows.length}`)
console.log(`...losing actionable content with it  : ${withSignal.length}`)
console.log('')
if (rows.length) {
  console.log('open + truncated (task, turn chars, delivered, % lost, actionable content lost):')
  for (const r of rows) {
    const sig = r.lostSignals.length ? r.lostSignals.join(', ') : '(prose only)'
    console.log(`  #${r.id}\t${r.total}\t${r.kept}\t${r.pct}%\t${sig}`)
  }
}
console.log('')
if (withSignal.length) {
  console.log('FIX: shorten these turns ask-first to <~3,400 chars, moving depth into a linked')
  console.log('     deliverable file. Durable fix is PR #211 / issue #210 (split, do not truncate).')
  process.exit(1)
}
console.log('no findings: no open-board task is losing actionable content to the cap.')
