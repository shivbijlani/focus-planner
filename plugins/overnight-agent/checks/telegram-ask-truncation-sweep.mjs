// telegram-ask-truncation-sweep -- how many task turns lose their ASK to Telegram's 4096-char cap?
//
// WHY THIS IS IN THE SUITE (added 2026-08-28 03:xx PT)
// ---------------------------------------------------
// The 2026-08-27 23:15 PT banner in user-settings.md measured this defect by hand (34 tasks) and
// told future runs to "re-measure the fleet with sweep-telegram-ask-truncation.mjs". That file
// lived in %USERPROFILE%\OneDrive\overnight-agent, was NOT in $Suite, and needed two env vars
// (BRIDGE_SRC, JOURNAL_DIR) that the documented command line never mentioned -- so it crashed with
// ERR_MODULE_NOT_FOUND when run as documented. Exactly the "six sweeps died on an unset BRIDGE_SRC"
// defect this wrapper exists to prevent, one folder over. It had therefore never run nightly.
//
// It also always exited 0, so even when it DID run it could only ever report "ok" -- a detector
// that structurally cannot report FINDINGS is not a check. It now exits 1 when an ask is dropped.
//
// WHY THE MEASUREMENT MATTERS MORE THAN IT LOOKS
// ---------------------------------------------
// The approval digest is OFF (user-settings.md "Approval digest" row, per task #441). The digest
// was the ONLY surface that showed an ask outside a task's own topic. With it off, the per-task
// topic message is the ONLY place Shiv can see an ask -- so a turn whose ask is truncated away has
// its ask visible NOWHERE. Measured 2026-08-28: 31 such tasks, 16 of them open/in-progress, i.e.
// the agent was waiting on answers to questions that were never delivered.
//
// Uses the SHIPPED journal parser and formatter, never a reimplementation, so it measures what the
// bridge actually does rather than what we think it does.
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const SRC = process.env.BRIDGE_SRC
// JOURNAL_DIR is optional: run-sweeps.ps1 exports PLANNER_PATH for every sweep, so derive from it
// rather than requiring yet another variable nobody remembers to set.
const JOURNALS =
  process.env.JOURNAL_DIR ||
  (process.env.PLANNER_PATH ? join(process.env.PLANNER_PATH, 'journal') : null)

if (!SRC) { console.error('BRIDGE_SRC is not set'); process.exit(2) }
if (!JOURNALS) { console.error('neither JOURNAL_DIR nor PLANNER_PATH is set'); process.exit(2) }

const { latestAgentTurn } = await import(`${SRC}/journal.js`)
const { mdToTelegramHtml, escapeHtml } = await import(`${SRC}/telegramFormat.js`)

const TELEGRAM_MAX = 4096

function truncateMarkdown(md, budget) {
  if (md.length <= budget) return md
  const cut = md.slice(0, budget)
  const nl = cut.lastIndexOf('\n')
  return nl > 0 ? cut.slice(0, nl) : cut
}

// Mirrors bridge.js formatForTelegram, returning the markdown that survives.
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

const ASK_RE = /^\s*\*{0,2}(Needs from you|Your call|Next)\b/im

const files = readdirSync(JOURNALS).filter((f) => /^task-\d+\.md$/.test(f))
let total = 0, truncated = 0, askLost = 0, noAskAnyway = 0
const victims = []

for (const f of files) {
  const id = f.match(/^task-(\d+)\.md$/)[1]
  let text
  try { text = readFileSync(join(JOURNALS, f), 'utf8') } catch { continue }
  let turn
  try { turn = latestAgentTurn(text) } catch { continue }
  if (!turn || typeof turn !== 'string' || !turn.trim()) continue
  const body = turn
  total++
  const kept = keptMarkdown(id, '', body)
  if (kept.length >= body.length) continue
  truncated++
  const hadAsk = ASK_RE.test(body)
  const keptAsk = ASK_RE.test(kept)
  if (!hadAsk) { noAskAnyway++; continue }
  if (!keptAsk) {
    askLost++
    victims.push({ id, chars: body.length, kept: kept.length,
                   droppedPct: Math.round(((body.length - kept.length) / body.length) * 100) })
  }
}

console.log(`journals with a parseable agent turn : ${total}`)
console.log(`turns TRUNCATED by the 4096 cap      : ${truncated}`)
console.log(`  ...of those, ask SURVIVED          : ${truncated - askLost - noAskAnyway}`)
console.log(`  ...of those, had no ask anyway     : ${noAskAnyway}`)
console.log(`  ...of those, ASK SILENTLY DROPPED  : ${askLost}`)

if (askLost) {
  victims.sort((a, b) => b.droppedPct - a.droppedPct)
  console.log('\nask-losing turns (task, turn chars, delivered chars, % dropped):')
  for (const v of victims) console.log(`  #${v.id}\t${v.chars}\t${v.kept}\t${v.droppedPct}%`)
  console.log(
    '\nFIX: shorten the turn to <~3,400 chars of markdown, ask-first (the digest is OFF, so the' +
    '\ntask topic is the only surface an ask can appear on). Durable fix is PR #211 / issue #210,' +
    '\nwhich splits a long turn instead of truncating it.')
  process.exit(1)
}
