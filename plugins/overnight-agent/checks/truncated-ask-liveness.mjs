// truncated-ask-liveness.mjs -- classify each ask-losing turn by whether its ask is ACTIONABLE.
//
// WHY THIS EXISTS (added 2026-08-28 04:30 PT)
// ------------------------------------------
// telegram-ask-truncation-sweep correctly flags every turn whose ask is cut off by Telegram's
// 4096-char cap. Triage then has to decide which of those matter. Two runs in a row got that
// decision wrong, in opposite directions, and both times by eye:
//
//   2026-08-27 23:15 -- called all 15 remaining victims "moot, closed/orphaned". 10 were live.
//   2026-08-28 03:23 -- called the last 5 benign because their ask text "starts with nothing".
//                       #232 read "one word on Kiley's copy" and #431 read "nothing to read the
//                       doc. One word only if you want the POC or the child task" -- BOTH carried
//                       real one-word decisions that Shiv had never been shown.
//
// The discriminator that actually works is not the first word of the ask, and not board
// membership. It is: does the ask name a CHOICE the user has to make? A choice is named by a
// backticked token (`forward it`, `go POC`, `merge 214`) or an explicit "one word" phrasing.
//
// This script is deliberately a CLASSIFIER, not a filter: it never suppresses a finding from
// telegram-ask-truncation-sweep (teaching that detector to ignore "nothing" would be a loosening,
// and this file already records what happens when a safety writer is quietly relaxed). It only
// tells you which victims to look at FIRST, and it shows the ask text so the call is made on the
// content rather than on a heuristic.
//
// Usage: BRIDGE_SRC=... PLANNER_PATH=... node truncated-ask-liveness.mjs
// Exit 1 if any victim has an ACTIONABLE ask; 0 otherwise.
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const SRC = process.env.BRIDGE_SRC
const PLANNER = process.env.PLANNER_PATH
const JOURNALS = process.env.JOURNAL_DIR || (PLANNER ? join(PLANNER, 'journal') : null)
if (!SRC || !JOURNALS) { console.error('BRIDGE_SRC and PLANNER_PATH/JOURNAL_DIR required'); process.exit(2) }

const { latestAgentTurn } = await import(`${SRC}/journal.js`)
const { mdToTelegramHtml, escapeHtml } = await import(`${SRC}/telegramFormat.js`)

const TELEGRAM_MAX = 4096
function truncateMarkdown(md, budget) {
  if (md.length <= budget) return md
  const cut = md.slice(0, budget)
  const nl = cut.lastIndexOf('\n')
  return nl > 0 ? cut.slice(0, nl) : cut
}
function keptMarkdown(taskId, turn) {
  const headerHtml = `<b>${escapeHtml(`\u{1F4CB} Task #${taskId}`)}</b>`
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

const ASK_RE = /^\s*\*{0,2}(Needs from you|Your call|Next)\b/im
// The ask block = the "Needs from you" line plus everything after it in the turn.
function askText(turn) {
  const m = turn.match(/^\s*\*{0,2}Needs from you\b[\s\S]*$/im)
  return m ? m[0] : ''
}
// A choice is named by a backticked token, or by an explicit "one word"/"say" instruction.
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

// board membership (for context only -- liveness is NOT board membership alone)
function onBoard(id) {
  const p = join(PLANNER || '', 'planner.md')
  if (!PLANNER || !existsSync(p)) return null
  const t = readFileSync(p, 'utf8')
  return new RegExp(`^\\|\\s*${id}\\s*\\|`, 'm').test(t)
}

const files = readdirSync(JOURNALS).filter((f) => /^task-\d+\.md$/.test(f))
const actionable = [], benign = []

for (const f of files) {
  const id = f.match(/^task-(\d+)\.md$/)[1]
  let text; try { text = readFileSync(join(JOURNALS, f), 'utf8') } catch { continue }
  let turn; try { turn = latestAgentTurn(text) } catch { continue }
  if (!turn || !turn.trim()) continue
  const kept = keptMarkdown(id, turn)
  if (kept.length >= turn.length) continue          // not truncated
  if (!ASK_RE.test(turn) || ASK_RE.test(kept)) continue  // no ask, or ask survived
  const ask = askText(turn)
  const c = classifyAsk(ask)
  const row = { id, onBoard: onBoard(id), ...c, ask: ask.replace(/\s+/g, ' ').slice(0, 220) }
  ;(c.actionable ? actionable : benign).push(row)
}

console.log(`ask-losing turns classified: ${actionable.length + benign.length}`)
console.log(`  ACTIONABLE (a real choice Shiv has never seen) : ${actionable.length}`)
console.log(`  benign (ask genuinely requires nothing)        : ${benign.length}`)

if (actionable.length) {
  console.log('\nACTIONABLE -- re-deliver these as short, ask-first turns:')
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
  console.log('\nFIX: rewrite each ACTIONABLE turn ask-first under ~3,400 chars and re-run PHASE 3.')
  process.exit(1)
}
