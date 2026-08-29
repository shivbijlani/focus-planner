// telegram-ask-truncation-sweep -- does an agent turn's ASK actually reach the phone?
//
// WHY THIS IS IN THE SUITE (added 2026-08-28 03:xx PT)
// ---------------------------------------------------
// The approval digest is OFF (user-settings.md "Approval digest" row, per task #441). The digest
// was the ONLY surface that showed an ask outside a task's own topic. With it off, the per-task
// topic message is the ONLY place Shiv can see an ask -- so a turn whose ask never arrives has its
// ask visible NOWHERE, and the agent waits on an answer to a question that was never delivered.
//
// REWRITTEN 2026-08-29 -- IT WAS GRADING A CODE PATH THAT NO LONGER EXISTS
// -----------------------------------------------------------------------
// This file used to hand-copy the bridge's truncate-a-prefix logic and ask "does the ask survive
// the cut?". PR #211 (merged 2026-08-28) DELETED that logic: `formatForTelegramParts` now SPLITS a
// long turn across up to 3 messages and, past that, trims the body while carrying the ask onto the
// final part.
//
// So the copy went stale, and on 2026-08-29 this sweep reported:
//
//     ...of those, ASK SILENTLY DROPPED  : 1
//       #435  5379  3617  33%
//
// Measured against the SHIPPED formatter the same night: #435 is delivered as 2 messages and its
// ask arrives intact. The finding was false -- and its FIX line said "shorten the turn to ~3,400
// chars", which would have made the agent write worse journals to satisfy a solved problem. A
// detector that is wrong in the direction of "do less work" is worse than one that is silent.
//
// The header of the old version claimed it used "the SHIPPED journal parser and formatter, never a
// reimplementation". That was true of `mdToTelegramHtml` and false of the truncation model. The
// claim is now structural rather than aspirational: the cap, the budget and the split live ONLY in
// bridge.js, imported through checks/lib/telegram-delivery.mjs. There is no local model left to
// drift.
import { join } from 'path'
import {
  loadShippedDelivery, deliveryFor, eachTurn, turnHasAsk, askDelivered,
} from './lib-telegram-delivery.mjs'

const SRC = process.env.BRIDGE_SRC
// JOURNAL_DIR is optional: run-sweeps.ps1 exports PLANNER_PATH for every sweep, so derive from it
// rather than requiring yet another variable nobody remembers to set.
const JOURNALS =
  process.env.JOURNAL_DIR ||
  (process.env.PLANNER_PATH ? join(process.env.PLANNER_PATH, 'journal') : null)

if (!SRC) { console.error('BRIDGE_SRC is not set'); process.exit(2) }
if (!JOURNALS) { console.error('neither JOURNAL_DIR nor PLANNER_PATH is set'); process.exit(2) }

const { latestAgentTurn } = await import(`${SRC}/journal.js`)
const shipped = await loadShippedDelivery(SRC)

let total = 0, withAsk = 0, multipart = 0, askLost = 0
const victims = []

eachTurn(JOURNALS, latestAgentTurn, (id, turn) => {
  total++
  const delivery = deliveryFor(shipped, id, '', turn)
  if (delivery.parts.length > 1) multipart++
  if (!turnHasAsk(turn)) return
  withAsk++
  if (askDelivered(shipped, turn, delivery)) return
  askLost++
  victims.push({ id, chars: turn.length, parts: delivery.parts.length })
})

console.log(`journals with a parseable agent turn : ${total}`)
console.log(`  ...whose turn carries an ask       : ${withAsk}`)
console.log(`  ...the bridge SPLITS into >1 msg   : ${multipart}`)
console.log(`  ...whose ASK IS NEVER DELIVERED    : ${askLost}`)

if (askLost) {
  console.log('\nasks that never reach the phone (task, turn chars, messages sent):')
  for (const v of victims) console.log(`  #${v.id}\t${v.chars}\t${v.parts}`)
  console.log(
    '\nFIX: this should be impossible -- formatForTelegramParts carries the ask onto the final' +
    '\npart by construction (bridge.js, "SPLIT instead of truncate"). A finding here means that' +
    '\nguarantee has REGRESSED, not that the turn is too long. Fix the splitter, not the journal.')
  process.exit(1)
}
