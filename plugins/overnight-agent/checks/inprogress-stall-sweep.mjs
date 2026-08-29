// Sweep: `in-progress` tasks that the AGENT owes the next move on, but has silently dropped.
//
// WHY THIS BUCKET IS DIFFERENT (established 2026-08-25 12:30 PT)
// -------------------------------------------------------------
// `proposed` and `blocked` both mean "waiting on Shiv" - idling there is by design.
// `in-progress` is the ONLY status that means "the agent will continue this on a later
// night". But SKILL.md PHASE 1 only continues an in-progress task "whose next step is
// approved", and PHASE 2 only proposes for tasks with no block / status `revise`. So an
// in-progress task that is not `reopened` and not `approved` falls through BOTH phases
// and is never picked up again. Nothing measures that.
//
// Flag = in-progress + idle + its own ask does not actually need Shiv.
//
// Harness discipline (per recorded traps):
//  - strip the UTF-8 BOM oa-state.ps1 writes, and NEVER swallow the parse error
//  - regexes bound to distinct `rx*` names so a loop variable cannot shadow them
//  - NEEDS_RE copied verbatim from the bridge; a stricter checker invents defects
//  - population count is printed so it can be cross-checked against `oa-state scan`
//
// RECENCY BUG, FOUND + FIXED 2026-08-25 19:10 PT
// ---------------------------------------------
// This sweep used to date a journal ONLY by `/^\*\*(\d{4}-\d{2}-\d{2})/` - the bold
// Run-log dialect from SKILL.md (`**2026-08-04 (overnight):**`). Real journals use at
// least three date forms, and the other two were invisible:
//   - bullet Run-log entries : `- 2026-07-01 (overnight): ...`
//   - chat-entry headers     : `## 2026-08-25`
// The failure was TWO-SIDED and the output was wrong in both directions at once:
//   - FALSE ALARM: #234 reported idle=21d (last bold entry 2026-08-04) when its newest
//     turn was 2026-08-25 - i.e. worked that very day.
//   - SILENT MISS: 6 of 31 in-progress tasks had NO bold entry anywhere, so idle was
//     null, so `stale` was false, so they could NEVER be flagged no matter how old.
//     #283 (36d) and #390 (27d) were genuinely stalled and structurally invisible.
// Fix: date the journal by the MAX over all three forms. Any of them is evidence the
// journal was touched that day, which is exactly what "idle" is supposed to measure.
// Rule this re-proves: a checker that reads a hand-written format must accept EVERY
// dialect that format actually appears in, or it reports confident nonsense.
//
// FOURTH DIALECT, FOUND 2026-08-25 20:00 PT - the 19:10 fix was itself incomplete
// ------------------------------------------------------------------------------
// The 19:10 pass enumerated "three date forms" from the journals it happened to look
// at, and missed the one form SKILL.md *mandates* in every single agent block:
//   - the Status line : `**Status:** In-progress - plan v2 - 2026-08-25 - ...`
// A journal whose agent block records its date ONLY there (no Run log at all) was
// still dated `null` -> `stale` false -> permanently unflaggable. Measured live:
// #244, #245 and #246 were all in exactly that shape, i.e. the previous fix left
// behind the very class of victim it was written to eliminate.
// Meta-rule: enumerating dialects from a sample is how you get an incomplete list.
// Enumerate them from the SPEC (SKILL.md's block template) as well as from the data.
// Safety: idle is a MAX over dialects, so adding one can only move a date NEWER. It
// can never manufacture a stall; the worst case is declining to flag something.
import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH;
const JOURNALS = path.join(PLANNER, 'journal');
const IDLE_DAYS = Number(process.env.IDLE_DAYS || 14);

// EXACT copies of the bridge's markers - do not tighten.
const rxNeeds = /^\s*\*{0,2}Needs from you\b[^:]*:\*{0,2}\s*(.*)$/i;
const rxDismissive = /^\s*(none|nothing|n\/a|no)\b/i;
const rxRunEntry = /^\*\*(\d{4}-\d{2}-\d{2})/;
const rxRunBullet = /^\s*[-*]\s*(\d{4}-\d{2}-\d{2})\b/;
const rxChatHeader = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
// The block template's own Status line. Take the FIRST date on it: the format is
// `**Status:** <status> - plan vN - <date> - <prose>`, and the prose after it may
// legitimately mention other (older) dates.
const rxStatusDate = /^\s*\*{0,2}Status:\*{0,2}.*?(\d{4}-\d{2}-\d{2})/;
const rxNext = /^\s*[-*]?\s*\*{0,2}Next:\*{0,2}\s*(.*)$/i;
const rxBoardRow = /^\|\s*(\d+)[,\s|]/gm;

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const activeIds = new Set();
for (const m of board.matchAll(rxBoardRow)) activeIds.add(m[1]);

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const now = new Date();
const rows = [];
let parseFails = 0;

for (const f of fs.readdirSync(stateDir)) {
  const mf = /^task-(\d+)\.json$/.exec(f);
  if (!mf) continue;
  const id = mf[1];
  if (!activeIds.has(id)) continue;

  let st;
  const raw = fs.readFileSync(path.join(stateDir, f), 'utf8').replace(/^\uFEFF/, '');
  try { st = JSON.parse(raw); } catch (e) { console.error(`PARSE FAIL ${f}: ${e.message}`); parseFails++; continue; }
  if (st.status !== 'in-progress') continue;

  const jf = path.join(JOURNALS, `task-${id}.md`);
  if (!fs.existsSync(jf)) { rows.push({ id, idle: null, ask: '(no journal)', next: '', flag: '?' }); continue; }
  const text = fs.readFileSync(jf, 'utf8');
  const lines = text.split(/\r?\n/);

  // Newest dated marker of ANY dialect, and the `Next:` recorded under it.
  // Collect (date -> latest Next: seen under an entry with that date), then pick the
  // max date. Journals are mostly but not strictly chronological, so "last marker in
  // the file" is not the same as "newest date" - and a `Next:` sitting under an older
  // entry must not be attributed to the newest one.
  const nextByDate = new Map();
  let curDate = null;
  for (const line of lines) {
    const md = rxRunEntry.exec(line) || rxRunBullet.exec(line) || rxChatHeader.exec(line) || rxStatusDate.exec(line);
    if (md) { curDate = md[1]; nextByDate.set(curDate, ''); continue; }
    if (curDate) {
      const mn = rxNext.exec(line);
      if (mn) nextByDate.set(curDate, mn[1].trim());
    }
  }
  let lastDate = null;
  for (const d of nextByDate.keys()) if (lastDate === null || d > lastDate) lastDate = d;
  const lastNext = lastDate ? (nextByDate.get(lastDate) || '') : '';
  const idle = lastDate ? Math.floor((now - new Date(lastDate + 'T12:00:00')) / 86400000) : null;

  // The LIVE ask only - see lib-live-ask.mjs. The previous "last Needs-from-you line in
  // the whole file" semantics lifted the ask out of superseded turns (#283 reported its
  // turn-1 v1 ask, 7 turns and 70 days stale, which is what produced this FLAG).
  const { ask, source: askSource } = liveAsk(text);

  const dismissive = ask !== null && rxDismissive.test(ask);
  const stale = idle !== null && idle >= IDLE_DAYS;
  rows.push({
    id, idle,
    ask: ask === null ? `NO LIVE ASK (${askSource})` : ask.slice(0, 90),
    askSource,
    next: lastNext.slice(0, 70),
    lastDate,
    flag: (stale && dismissive) ? 'FLAG' : (stale ? 'stale' : ''),
  });
}

rows.sort((a, b) => (b.idle ?? -1) - (a.idle ?? -1));
console.log(`in-progress tasks on active board: ${rows.length}   (cross-check vs 'oa-state scan')`);
if (parseFails) console.log(`!! ${parseFails} state files failed to parse - result is NOT trustworthy`);
console.log(`idle threshold: ${IDLE_DAYS}d\n`);
for (const r of rows) {
  console.log(`${(r.flag || '').padEnd(6)} #${r.id}  idle=${r.idle === null ? '?' : r.idle + 'd'}  last=${r.lastDate ?? '?'}`);
  console.log(`        Next: ${r.next || '(none recorded)'}`);
  console.log(`        Ask : ${r.ask}`);
}
const flagged = rows.filter(r => r.flag === 'FLAG');
console.log(`\nFLAGGED (agent owes the move, is idle >=${IDLE_DAYS}d, and its own ask needs nothing from Shiv): ` +
  (flagged.map(r => '#' + r.id).join(', ') || '(none)'));
