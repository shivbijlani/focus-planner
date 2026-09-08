// unreachable-topic-sweep.mjs
//
// GUARDS: the observable outcome, not the code that produces it. "How many Telegram
// topics can the collapse fix never reach, no matter how correct it is?"
//
// WHY THIS EXISTS
// ---------------
// On 2026-09-08 Shiv wrote, of the work this whole cluster exists to do:
//
//     "The things I'm excited to see most about getting fixed are catch up document
//      related fixes and stacked messages in Telegram related fixes. It's been a while
//      and I still haven't seen any improvement there. ... Every time I look at the app,
//      I expect to see a single telegram message per task. Instead there's multiple
//      stacked messages in telegram."
//
// Every fix he is waiting on was already shipped and deployed when he wrote that. #424
// made the topic silent between turns; #620 folded the ask into the pointer so a bound
// topic settles at one message; #588 stopped the link pointing at an unwritten doc. Each
// merged, each with tests, each verified running. And the outcome he measures did not move.
//
// The reason is not in any of those fixes. It is one line in bridge.js:
//
//     const supersedes = canCollapse ? task.lastPostedMessageIds : []
//
// Collapsing, editing, superseding -- every mechanism that keeps a topic at one message --
// operates on the ids of the messages the bridge previously posted. A Telegram bot cannot
// list a channel's history, so those ids are recoverable from exactly one place: the bridge
// having written them down at the time it posted. If they were never written down, the
// message is unreachable FOREVER. Not stale, not slow to converge -- unreachable, because
// the id cannot be re-derived by any API call available to a bot.
//
// Measured against the live state.json on 2026-09-08:
//
//     229 topics bound
//     208 of them carry `lastPostedHash` (proof a turn WAS posted there)
//       and have no `lastPostedMessageIds` field at all (no record of WHERE)
//
// So 91% of bound topics hold at least one message that no present or future fix can edit,
// collapse or supersede. The fixes are correct. They are simply operating on 21 topics
// while Shiv is looking at 229.
//
// WHY NOTHING CAUGHT IT
// ---------------------
// This is the #346 / #520 family -- a success-shaped failure -- at the level of the whole
// verification apparatus rather than one function. There are ~69 sweeps. Every one of them
// reads code, journals, board rows or doc bodies. NOT ONE reads how many messages are at
// rest in a live topic, which is the only thing Shiv actually looks at. So "all sweeps
// green" and "I still see stacked messages" were never in contradiction; they were
// measuring different universes, and only one of them was his.
//
// A fix whose effect is invisible to every check is indistinguishable from a fix that does
// nothing. That is the gap this sweep closes: it measures the outcome, so the next time a
// collapse fix ships, the number it is supposed to move is on the record before and after.
//
// WHAT IT DOES *NOT* CLAIM
// ------------------------
// It does not count messages in Telegram. A bot cannot enumerate topic history, and a sweep
// that pretended to would be inventing its own evidence. It counts the topics where the
// bridge has DEMONSTRABLY posted (a hash) and DEMONSTRABLY cannot find what it posted (no
// ids). That is a lower bound on the stacking, derived only from facts the bridge wrote
// down itself, and it is exact for the question "can the fix reach this topic".
//
// It is also NOT a request to rewrite history. Shiv was explicit: "I'm not asking you to go
// back and fix prior mistakes. I want you to fix the build so you don't make more stacking."
// The forward-looking half is the FIRST-POST column below: each unreachable topic will gain
// one further permanent message the next time it is woken, because the bridge has nothing to
// supersede. After that post it records ids and behaves. So the remaining damage is bounded
// and countable in advance -- which is the difference between a known cost and a surprise.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE = process.env.TELEGRAM_BRIDGE_STATE_DIR
  ? path.join(process.env.TELEGRAM_BRIDGE_STATE_DIR, 'state.json')
  : path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
      'overnight-agent',
      'telegram-bridge',
      'state.json',
    )

if (!fs.existsSync(STATE)) {
  // Absent state is not a finding. It is a machine that has never run the bridge, and
  // reporting 0 unreachable topics there would be a false clean -- the exact shape this
  // sweep exists to catch. Say why it measured nothing, and exit OK.
  console.log(`no bridge state at ${STATE} -- nothing to measure on this machine`)
  process.exit(0)
}

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
const tasks = state.tasks && typeof state.tasks === 'object' ? state.tasks : {}

const bound = []
const unreachable = []
const reachable = []

for (const [id, t] of Object.entries(tasks)) {
  if (!t || typeof t !== 'object' || !t.topicId) continue
  bound.push(id)
  const ids = Array.isArray(t.lastPostedMessageIds) ? t.lastPostedMessageIds : null
  const posted = typeof t.lastPostedHash === 'string' && t.lastPostedHash.length > 0
  if (posted && (!ids || ids.length === 0)) {
    unreachable.push({ id, name: t.name || '', archived: !!t.archived })
  } else if (ids && ids.length) {
    reachable.push({ id, n: ids.length })
  }
}

// Archived topics are counted but reported apart. Shiv is not looking at them, so they are
// not part of what he sees -- but they are still unreachable, and quietly dropping them
// would understate the total in exactly the direction that flatters the report.
const live = unreachable.filter((u) => !u.archived)
const archived = unreachable.filter((u) => u.archived)

const pct = bound.length ? Math.round((unreachable.length / bound.length) * 100) : 0

console.log(`state       : ${STATE}`)
console.log(`bound topics: ${bound.length}`)
console.log(`reachable   : ${reachable.length}  (bridge knows which message is its own)`)
console.log(`UNREACHABLE : ${unreachable.length}  (${pct}% -- posted, location never recorded)`)
console.log(`  live      : ${live.length}`)
console.log(`  archived  : ${archived.length}`)

// The multi-message reachable topics are the ones a collapse SHOULD be folding and is not.
const stacked = reachable.filter((r) => r.n > 1)
if (stacked.length) {
  console.log(
    `\nreachable but resting on >1 message: ${stacked.length}` +
      ` -- ${stacked.map((s) => `#${s.id}(${s.n})`).join(' ')}`,
  )
}

if (!unreachable.length) {
  console.log('\nOK: every topic the bridge has posted to, it can still edit.')
  process.exit(0)
}

console.log(
  `\nFINDINGS: ${unreachable.length} topic(s) hold a message no fix can reach.` +
    `\nEach will gain ONE further permanent message when next woken, because there is` +
    `\nnothing for the new turn to supersede. That is ${live.length} more stacked messages` +
    `\nstill to come on live topics -- bounded, countable, and not recoverable by editing,` +
    `\nbecause a bot cannot re-derive a message id it never wrote down.`,
)

const sample = live.slice(0, 12)
for (const u of sample) console.log(`  #${u.id}  ${u.name}`)
if (live.length > sample.length) console.log(`  ... and ${live.length - sample.length} more`)

console.log(
  '\nThis is a measurement, not a regression: it was true before the collapse fixes and is' +
    '\nunchanged by them. It is reported so that "the fix shipped" and "the outcome moved"' +
    '\nstop being the same sentence.',
)
process.exit(1)
