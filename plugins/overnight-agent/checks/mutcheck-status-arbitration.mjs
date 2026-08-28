// mutcheck-status-arbitration.mjs — mutation check for the turn-vs-block DATE
// arbitration added to lib-live-status.mjs on 2026-08-25 22:00 PT.
//
// The property under test: when a journal has BOTH a Status-bearing agent turn and a
// Status line in the agent block, the LIVE status is whichever line is strictly newer —
// not whichever is positionally later. Before the fix the turn always won, so a run that
// rewrote the block and appended a turn without a Status line reported a stale status.
//
// Every synthetic case below is written so it FAILS against the pre-fix behaviour
// (turn-always-wins). Live assertions use literal strings from the real corpus, but are
// phrased robustly so working those tasks does not break the test (the 21:30 lesson:
// a brittle exact-string assertion against a live journal fails every time it is worked).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { liveStatus, statusStampDate } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('PLANNER_PATH is required'); process.exit(1); }
const journalDir = path.join(PLANNER, 'journal');

let pass = 0, fail = 0;
const ok = (label, cond, got, want) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL [${label}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};

const B = '<!-- OVERNIGHT-AGENT do not edit this line -->';
const A = '<!-- from: overnight-agent -->';
const U = '<!-- from: me -->';

// ------------------------------------------------------------------ 0. statusStampDate
// Date-driven arbitration is only as good as the date. Neither "first date on the line"
// nor "last date" is sound: #320/#314 need the FIRST (the stamp, followed by prose that
// mentions another date), #352 needs the LAST (prose first, stamp trailing). The rule is
// positional — the stamp is a date forming its own `·`/dash-delimited segment. All lines
// below are literal shapes from the live corpus.
const stampCases = [
  ['#320 stamp first, prose mentions a later date', '**Status:** Done \u00b7 2026-08-23 \u2014 trip completed 2026-08-01 (flew `AS631 SEA\u2192SNA`); asks aged out.', '2026-08-23'],
  ['#314 stamp first, prose mentions a correction date', '**Status:** Done \u00b7 2026-07-01 \u2014 tombstone shipped (`c90fbfb`, PR #45). Status line corrected 2026-08-23', '2026-07-01'],
  ['#352 prose first, stamp trailing', '**Status:** Done \u2014 shipped 2026-07-18 (PR #100, `ffddfc5`); postmortem written 2026-08-22. \u2014 2026-08-22', '2026-08-22'],
  ['#312 parenthetical follow-up is not the stamp', '**Status:** Done \u00b7 2026-06-25 (answered follow-up 2026-06-26)', '2026-06-25'],
  ['#250 no standalone segment falls back to the first date', "**Status correction (2026-08-22 overnight): this task's blocker line was stale.** The last 2026-07-01 note", '2026-08-22'],
  ['#352 both dates embedded in prose', '**Status:** Done \u00b7 HTML mirroring already in `main` (PR #96, 2026-07-17) \u00b7 verified live 2026-07-27', '2026-07-17'],
  ['SKILL.md template shape', '**Status:** Proposed \u00b7 plan v1 \u00b7 2026-08-25', '2026-08-25'],
  ['#376 stamp then em-dash prose', '**Status:** Proposed \u00b7 plan v4 \u00b7 2026-08-25 \u2014 the sized comparison is now written', '2026-08-25'],
  ['#239 trailing stamp after a parenthetical clause', '**Status:** in-progress \u00b7 answered your cash-parking question (researched + emailed) \u00b7 2026-07-01', '2026-07-01'],
  ['no date at all', '**Status:** blocked (on you) \u2014 waiting on PayPal', null],
];
for (const [label, line, want] of stampCases) {
  ok(`stamp ${label}`, statusStampDate(line) === want, statusStampDate(line), want);
}

// ------------------------------------------------------------------ 1. block newer wins
// The #376 shape: block rewritten today, newest Status-bearing turn is 3 days old.
const blockNewer = [
  '# Task 1', '', '## 2026-08-20', 'user note', '',
  '---', B, '', '## \u{1F319} Overnight Agent', '',
  '**Status:** Proposed \u00b7 plan v4 \u00b7 2026-08-25', '',
  '## 2026-08-22', A, '**Status:** Blocked - autofill disproven - 2026-08-22', 'old turn', '',
  '## 2026-08-25', A, 'new turn with NO status line', '',
].join('\n');
let r = liveStatus(blockNewer);
ok('block-newer wins', r.status === 'proposed', r.status, 'proposed');
ok('block-newer source', r.source === 'block', r.source, 'block');
ok('block-newer arbitration', r.arbitration === 'block-newer', r.arbitration, 'block-newer');

// ------------------------------------------------------------------ 2. turn newer wins
// The ordinary case must be untouched: a turn dated after the block still wins.
const turnNewer = [
  '# Task 2', '---', B, '', '**Status:** Proposed \u00b7 plan v1 \u00b7 2026-01-01', '',
  '## 2026-02-02', A, '**Status:** Done \u00b7 2026-02-02', 'shipped',
].join('\n');
r = liveStatus(turnNewer);
ok('turn-newer wins', r.status === 'done', r.status, 'done');
ok('turn-newer source is a turn', String(r.source).startsWith('turn-'), r.source, 'turn-*');
ok('turn-newer arbitration', r.arbitration === 'turn-newer', r.arbitration, 'turn-newer');

// ------------------------------------------------------------------ 3. undated turn dated by its header
// The #292/#349 shape: the turn's Status line has no date, but its `## YYYY-MM-DD`
// header does — and the block is newer than that header.
const headerDated = [
  '# Task 3', '---', B, '', '**Status:** Done \u00b7 confirmed complete \u00b7 2026-08-18', '',
  '## 2026-07-08', A, '**Status:** Blocked - awaiting WhatsApp Web for phone numbers.', 'stale turn',
].join('\n');
r = liveStatus(headerDated);
ok('undated turn dated from header, block newer', r.status === 'done', r.status, 'done');
ok('undated turn header arbitration', r.arbitration === 'block-newer', r.arbitration, 'block-newer');

// ...and the mirror: header newer than the block means the TURN still wins.
const headerDatedTurnWins = [
  '# Task 4', '---', B, '', '**Status:** Proposed \u00b7 2026-06-01', '',
  '## 2026-07-08', A, '**Status:** Blocked - waiting on you', 'turn',
].join('\n');
r = liveStatus(headerDatedTurnWins);
ok('undated turn dated from header, turn newer', r.status === 'blocked', r.status, 'blocked');

// ------------------------------------------------------------------ 4. tie keeps the turn
const sameDate = [
  '# Task 5', '---', B, '', '**Status:** Proposed \u00b7 plan v2 \u00b7 2026-08-25', '',
  '## 2026-08-25', A, '**Status:** In progress \u00b7 2026-08-25', 'same day',
].join('\n');
r = liveStatus(sameDate);
ok('same-date keeps the turn', r.status === 'in-progress', r.status, 'in-progress');
ok('same-date arbitration', r.arbitration === 'same-date-turn', r.arbitration, 'same-date-turn');

// ------------------------------------------------------------------ 5. undatable keeps the turn
// No date anywhere: fall back to the OLD behaviour rather than inventing an order.
const undatable = [
  '# Task 6', '---', B, '', '**Status:** Proposed', '',
  A, '**Status:** Blocked - waiting', 'turn with no header and no date',
].join('\n');
r = liveStatus(undatable);
ok('undatable keeps the turn', r.status === 'blocked', r.status, 'blocked');
ok('undatable arbitration', r.arbitration === 'undatable-turn', r.arbitration, 'undatable-turn');

// ------------------------------------------------------------------ 6. single-sided cases
const blockOnly = ['# T', '---', B, '', '**Status:** Done \u00b7 2026-08-01', ''].join('\n');
r = liveStatus(blockOnly);
ok('block only', r.status === 'done' && r.arbitration === 'block-only', { s: r.status, a: r.arbitration }, { s: 'done', a: 'block-only' });

const turnOnly = ['# T', '---', B, '', 'no status here', '', '## 2026-08-01', A, '**Status:** Blocked'].join('\n');
r = liveStatus(turnOnly);
ok('turn only', r.status === 'blocked' && r.arbitration === 'turn-only', { s: r.status, a: r.arbitration }, { s: 'blocked', a: 'turn-only' });

// ------------------------------------------------------------------ 7. the 21:00 property still holds
// An OLDER turn must never be lifted when a NEWER turn carries a status.
const twoTurns = [
  '# T', '---', B, '', '**Status:** Proposed \u00b7 2026-01-01', '',
  '## 2026-02-01', A, '**Status:** Blocked \u00b7 2026-02-01', 'older turn', '',
  '## 2026-03-01', A, '**Status:** Done \u00b7 2026-03-01', 'newer turn',
].join('\n');
r = liveStatus(twoTurns);
ok('newest turn still beats an older turn', r.status === 'done', r.status, 'done');

// ------------------------------------------------------------------ 8. live corpus assertions
function readTask(id) {
  const f = path.join(journalDir, `task-${id}.md`);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}
// #376: block says Proposed (2026-08-25); a 2026-08-22 turn says Blocked. Phrased as
// "must not be the stale blocked" so re-working the task cannot break the test.
const t376 = readTask(376);
if (t376) {
  const s = liveStatus(t376);
  ok('#376 not attributed to the stale 08-22 blocked turn',
    !(s.status === 'blocked' && s.date === '2026-08-22'), { status: s.status, date: s.date }, 'not blocked@2026-08-22');
}
// #239: no turn carries a Status line, so the block must still be used (the fix must not
// have broken the fallback that finds genuinely stale block lines).
const t239 = readTask(239);
if (t239) {
  const s = liveStatus(t239);
  ok('#239 still resolves via the block fallback', s.source === 'block', s.source, 'block');
}

// ------------------------------------------------------------------ 9. corpus invariant
// Whatever wins, it must be the newest dated Status assertion in the file — never one
// that another Status line strictly post-dates.
//
// Scoped to the regions liveStatus is DEFINED over: agent turns and the sentinel block.
// User regions are deliberately excluded by the marker model (the space above/inside a
// `<!-- from: me -->` region is the user's), so asserting over them would test a domain
// the function does not claim. Two legacy journals — #373 and #377 — carry an extra
// `## 🌙 Overnight Agent` heading with NO sentinel above it, stranded inside a user
// region; both are off the active board and both resolve to the same status either way,
// so this is a recorded data anomaly, not a parser bug.
const rxAnyStatus = /^[ \t]*\*{0,2}Status:?\*{0,2}[^\n]*$/gm;
let violations = 0, scanned = 0;
function agentVisibleRegions(text) {
  const marks = [];
  for (const m of [A, U]) {
    let i = text.indexOf(m);
    while (i !== -1) { marks.push({ off: i, kind: m === A ? 'agent' : 'user' }); i = text.indexOf(m, i + m.length); }
  }
  const sent = text.lastIndexOf(B.slice(0, 21));
  if (sent !== -1) marks.push({ off: sent, kind: 'agent' });
  marks.sort((a, b) => a.off - b.off);
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].kind !== 'agent') continue;
    const end = i + 1 < marks.length ? marks[i + 1].off : text.length;
    out.push(text.slice(marks[i].off, end));
  }
  return out;
}
for (const f of readdirSync(journalDir)) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  const text = readFileSync(path.join(journalDir, f), 'utf8');
  const s = liveStatus(text);
  if (!s.effDate) continue;
  scanned++;
  let newest = null;
  for (const region of agentVisibleRegions(text)) {
    rxAnyStatus.lastIndex = 0;
    let m;
    while ((m = rxAnyStatus.exec(region)) !== null) {
      const d = statusStampDate(m[0].split(/\r?\n/)[0]);
      if (d && (!newest || d > newest)) newest = d;
    }
  }
  if (newest && newest > s.effDate) { violations++; console.log(`    violation ${f}: live=${s.effDate} but an agent-visible Status line is dated ${newest}`); }
}
ok(`corpus invariant over ${scanned} dated journals: no status pre-dated by another agent-visible Status line`, violations === 0, violations, 0);

console.log(`mutcheck-status-arbitration: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
