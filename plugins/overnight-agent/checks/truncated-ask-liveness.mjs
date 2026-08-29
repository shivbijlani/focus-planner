// truncated-ask-liveness.mjs -- of the asks that DON'T reach the phone, which name a real choice?
//
// WHY THIS EXISTS (added 2026-08-28 04:30 PT)
// ------------------------------------------
// telegram-ask-truncation-sweep flags every undelivered ask. Triage then has to decide which of
// those matter, and two runs in a row got that decision wrong, in opposite directions, by eye:
//
//   2026-08-27 23:15 -- called all 15 victims "moot, closed/orphaned". 10 were live.
//   2026-08-28 03:23 -- called the last 5 benign because their ask "starts with nothing".
//                       #232 read "one word on Kiley's copy" and #431 read "nothing to read the
//                       doc. One word only if you want the POC or the child task" -- BOTH carried
//                       real one-word decisions Shiv had never been shown.
//
// The discriminator that works is not the first word of the ask and not board membership. It is:
// does the ask name a CHOICE? A choice is named by a backticked token (`forward it`, `merge 214`)
// or by explicit "one word" phrasing.
//
// This is deliberately a CLASSIFIER, not a filter: it never suppresses a finding from the sweep
// above. It only says which victims to look at FIRST, and prints the ask so the call is made on
// content rather than heuristic.
//
// REWRITTEN 2026-08-29 -- ITS POPULATION CAME FROM A DELETED CODE PATH
// -------------------------------------------------------------------
// The classifier was sound; the set it classified was not. It hand-copied the bridge's old
// truncate-a-prefix budget loop to decide "which asks were lost", and PR #211 replaced that
// truncation with splitting. So this file was triaging victims of a mechanism that no longer
// exists.
//
// Like truncation-openboard-scope, it read `ok` -- and for the same wrong reason: it never called
// the splitter, so it could not have noticed either a regression or a repair. Victimhood is now
// decided by the SHIPPED formatter via checks/lib/telegram-delivery.mjs. Today that population is
// empty, and an empty population is the honest answer rather than a suppressed one -- so the
// counts are still printed when there is nothing to triage.
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  loadShippedDelivery, deliveryFor, eachTurn, turnHasAsk, askDelivered,
} from './lib-telegram-delivery.mjs'

const SRC = process.env.BRIDGE_SRC
const PLANNER = process.env.PLANNER_PATH
const JOURNALS = process.env.JOURNAL_DIR || (PLANNER ? join(PLANNER, 'journal') : null)
if (!SRC || !JOURNALS) { console.error('BRIDGE_SRC and PLANNER_PATH/JOURNAL_DIR required'); process.exit(2) }

const { latestAgentTurn } = await import(`${SRC}/journal.js`)
const shipped = await loadShippedDelivery(SRC)

// The ask block = the "Needs from you" line plus everything after it in the turn.
function askText(turn) {
  const m = turn.match(/^\s*\*{0,2}Needs from you\b[\s\S]*$/im)
  return m ? m[0] : ''
}

// A choice is named by a backticked token, or by explicit "one word"/"reply with" phrasing.
function classifyAsk(ask) {
  const backticked = (ask.match(/`[^`\n]+`/g) || [])
    // drop things that are obviously not choices: paths, code, urls
    .filter((t) => !/[\/\\]|\(\)|\.(js|ts|md|json|ps1|mjs)\b/i.test(t))
  const saysOneWord = /\bone word\b|\bsay\s+\*{0,2}`|\breply with\b/i.test(ask)
  const saysNothing = /Needs from you:?\*{0,2}\s*(nothing|none)\b/i.test(ask)
  if (backticked.length || saysOneWord) {
    return { actionable: true, tokens: backticked, note: saysNothing ? 'opens with "nothing" but names a choice' : '' }
  }
  return { actionable: false, tokens: [], note: saysNothing ? 'explicitly asks for nothing' : 'no choice named' }
}

// board membership (context only -- liveness is NOT board membership alone)
const boardPath = join(PLANNER || '', 'planner.md')
const boardText = PLANNER && existsSync(boardPath) ? readFileSync(boardPath, 'utf8') : null
const onBoard = (id) => (boardText === null ? null : new RegExp(`^\\|\\s*${id}\\s*\\|`, 'm').test(boardText))

const actionable = [], benign = []

eachTurn(JOURNALS, latestAgentTurn, (id, turn) => {
  if (!turnHasAsk(turn)) return
  const delivery = deliveryFor(shipped, id, '', turn)
  if (askDelivered(shipped, turn, delivery)) return            // the reader got it -- nothing to triage
  const ask = askText(turn)
  const c = classifyAsk(ask)
  const row = { id, onBoard: onBoard(id), ...c, ask: ask.replace(/\s+/g, ' ').slice(0, 220) }
  ;(c.actionable ? actionable : benign).push(row)
})

console.log(`undelivered asks classified: ${actionable.length + benign.length}`)
console.log(`  ACTIONABLE (a real choice Shiv has never seen) : ${actionable.length}`)
console.log(`  benign (ask genuinely requires nothing)        : ${benign.length}`)

if (actionable.length) {
  console.log('\nACTIONABLE -- these name a decision that never reached the phone:')
  for (const r of actionable) {
    console.log(`  #${r.id}  onBoard=${r.onBoard}  choices: ${r.tokens.join(', ') || '(phrasing)'}`)
    if (r.note) console.log(`      note: ${r.note}`)
    console.log(`      ask: ${r.ask}`)
  }
}
if (benign.length) {
  console.log('\nbenign (shown so the call is auditable, never suppressed):')
  for (const r of benign) console.log(`  #${r.id}  onBoard=${r.onBoard}  -- ${r.note}`)
}
if (actionable.length) {
  console.log('\nFIX: the splitter is meant to make this set empty. A non-zero count means the ask')
  console.log('     guarantee in formatForTelegramParts has regressed -- fix the bridge, not the turn.')
  process.exit(1)
}
