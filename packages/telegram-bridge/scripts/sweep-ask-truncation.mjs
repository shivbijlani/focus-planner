#!/usr/bin/env node
// How many task turns reach Telegram with their ASK removed?
//
// GH #210: the bridge used to TRUNCATE a turn to fit Telegram's 4,096-char cap.
// An agent turn puts its ask (`Needs from you:` / `Your call:`) at the END, so
// truncation deleted exactly the part the reader is supposed to act on. This
// sweep measures the live damage against the real journals.
//
// It drives the SHIPPED parser and the SHIPPED formatter — not a reimplementation
// — so it cannot drift from what the bridge actually sends. That mattered: the
// previous copy of this script inlined its own version of the formatter and had
// to be hand-edited every time the real one changed.
//
// Sends nothing. Read-only. Exits 1 if any ask is dropped, so it can be used as
// a check.
//
//   node packages/telegram-bridge/scripts/sweep-ask-truncation.mjs \
//     --journals "C:\\Users\\me\\OneDrive\\Apps\\Focus Planner\\journal"
//
// or set JOURNAL_DIR.

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { latestAgentTurn, parseTitle } from '../src/journal.js'
import { formatForTelegramParts } from '../src/bridge.js'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const JOURNALS = flag('journals') || process.env.JOURNAL_DIR
if (!JOURNALS) {
  console.error('usage: sweep-ask-truncation.mjs --journals <dir>   (or set JOURNAL_DIR)')
  process.exit(2)
}

// The same markers the bridge treats as an ask.
//
// NB: the delivered message is HTML, so `**Needs from you:**` arrives as
// `<b>Needs from you:</b>`. Strip tags before matching, or the check silently
// reports every delivered turn as ask-less — which is exactly what a first cut
// of this script did, turning a real 33 into a fictional 166.
const ASK_RE = /(?:^|\n)\s*\**\s*(?:Needs from you|Your call)\b/i

const stripTags = (s) => String(s).replace(/<[^>]*>/g, '')
const hasAsk = (s) => ASK_RE.test(stripTags(s))

const files = readdirSync(JOURNALS)
  .filter((f) => /^task-\d+\.md$/.test(f))
  .sort()

let total = 0
let split = 0
let noAskAnyway = 0
let askLost = 0
const multi = []
const victims = []

for (const f of files) {
  const id = f.match(/^task-(\d+)\.md$/)[1]
  let text
  try {
    text = readFileSync(join(JOURNALS, f), 'utf8')
  } catch {
    continue
  }

  let turn
  try {
    turn = latestAgentTurn(text)
  } catch {
    continue
  }
  if (!turn || typeof turn !== 'string' || !turn.trim()) continue
  total++

  const parts = formatForTelegramParts(id, parseTitle(text) || '', turn)
  const delivered = parts.join('\n')

  if (parts.length > 1) {
    split++
    multi.push({ id, chars: turn.length, parts: parts.length })
  }

  // Every part must be independently sendable.
  for (const [i, p] of parts.entries()) {
    if (p.length > 4096) {
      console.error(`FAIL #${id} part ${i + 1} is ${p.length} chars (> 4096)`)
      process.exitCode = 1
    }
  }

  if (!hasAsk(turn)) {
    noAskAnyway++
    continue
  }
  if (!hasAsk(delivered)) {
    askLost++
    victims.push({ id, chars: turn.length, parts: parts.length })
  }
}

console.log(`journals with a parseable agent turn : ${total}`)
console.log(`turns that need SPLITTING            : ${split}`)
console.log(`turns with no ask anyway             : ${noAskAnyway}`)
console.log(`turns whose ASK IS DROPPED           : ${askLost}`)

if (multi.length) {
  console.log('\nmulti-part turns (task, turn chars, parts):')
  multi
    .sort((a, b) => b.chars - a.chars)
    .forEach((m) => console.log(`  #${m.id}\t${m.chars}\t${m.parts}`))
}

if (victims.length) {
  console.log('\nASK-LOSING turns (task, turn chars, parts):')
  victims.forEach((v) => console.log(`  #${v.id}\t${v.chars}\t${v.parts}`))
  process.exitCode = 1
} else {
  console.log('\nOK — no task turn reaches Telegram without its ask.')
}
