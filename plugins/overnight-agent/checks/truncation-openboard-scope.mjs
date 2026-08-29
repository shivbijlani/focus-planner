// truncation-openboard-scope.mjs -- which OPEN-board turns lose actionable content on the way out?
//
// WHY (2026-08-28 04:55 PT): the ask sweep answers "does the ASK arrive?" and is green when it
// does. But a turn can keep its ask line and still lose deliverable links, PR numbers and run-log
// results below it. On a CLOSED task that is moot; on an OPEN one Shiv is reading a message with
// content silently missing. So compute the population -- open board rows -- and report loss
// against it.
//
// REWRITTEN 2026-08-29 -- IT WAS MEASURING A DELETED CODE PATH, AND WAS GREEN FOR THE WRONG REASON
// ------------------------------------------------------------------------------------------------
// This file hand-copied the bridge's old truncate-a-prefix budget loop, which PR #211 deleted when
// it replaced truncation with splitting. Two consequences, and the quiet one is the serious one:
//
//   1. "Lost" was computed as `body.slice(kept.length)` -- everything past a prefix cut. With
//      splitting there IS no prefix cut, so that definition describes nothing that happens.
//   2. It read `ok`. Not because content was arriving, but because it never called the splitter at
//      all. It would have kept reading `ok` if the splitter regressed to truncation -- the exact
//      failure it exists to catch. A guard that grades the wrong artifact is not a weak guard, it
//      is a decoration.
//
// The header used to claim "Uses the SHIPPED parser + formatter, never a reimplementation". It also
// named PR #211 as the "durable fix" in its own remediation text -- while not using it. The fix is
// now structural: loss is TOKENS PRESENT IN THE TURN BUT ABSENT FROM WHAT THE BRIDGE ACTUALLY
// POSTS, compared against the real output of formatForTelegramParts.
//
// Comparing tokens rather than lengths matters. A split delivery is legitimately shorter than its
// source in characters (the header and part counters cost room) while losing nothing at all, so a
// length-based test would now report loss on every long turn.
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  loadShippedDelivery, deliveryFor, eachTurn, lostSignals,
} from './lib-telegram-delivery.mjs'

const SRC = process.env.BRIDGE_SRC
const PLANNER = process.env.PLANNER_PATH
if (!SRC) { console.error('BRIDGE_SRC is not set'); process.exit(2) }
if (!PLANNER) { console.error('PLANNER_PATH is not set'); process.exit(2) }

const JOURNALS = join(PLANNER, 'journal')
const { latestAgentTurn } = await import(`${SRC}/journal.js`)
const shipped = await loadShippedDelivery(SRC)

// --- population: ids with a row on the OPEN board (computed, never quoted) ---
const openIds = new Set()
for (const line of readFileSync(join(PLANNER, 'planner.md'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*\|/)
  if (m) openIds.add(m[1])
}

const rows = []
eachTurn(JOURNALS, latestAgentTurn, (id, turn) => {
  if (!openIds.has(id)) return                 // scope: open board only
  const delivery = deliveryFor(shipped, id, '', turn)
  const lost = lostSignals(turn, delivery)
  if (!lost.length && delivery.parts.length === 1) return
  rows.push({ id, chars: turn.length, parts: delivery.parts.length, lost })
})

const withSignal = rows.filter((r) => r.lost.length > 0)

console.log(`open-board rows                       : ${openIds.size}`)
console.log(`...whose turn the bridge SPLITS       : ${rows.filter((r) => r.parts > 1).length}`)
console.log(`...losing actionable content with it  : ${withSignal.length}`)
console.log('')

if (rows.length) {
  console.log('open + multi-part (task, turn chars, messages, actionable content lost):')
  for (const r of rows) {
    const sig = r.lost.length ? r.lost.map((l) => `${l.label}:${l.token}`).join(', ') : '(nothing lost)'
    console.log(`  #${r.id}\t${r.chars}\t${r.parts}\t${sig}`)
  }
  console.log('')
}

if (withSignal.length) {
  console.log('FIX: content is being dropped past the 3-message split cap. Either shorten the turn')
  console.log('     by moving depth into a linked deliverable file, or raise MAX_PARTS in bridge.js.')
  process.exit(1)
}
console.log('no findings: no open-board task is losing actionable content on delivery.')
