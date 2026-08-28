// mutcheck-live-status.mjs — mutation check for lib-live-status.mjs.
//
// Standing rule (user-settings.md): a new checker arm is not trusted until it is
// measured against positives AND negatives drawn from the live corpus, and until the
// source change is shown to be load-bearing.
//
// Also enforces a corpus invariant over every journal: no status is ever attributed to
// a SUPERSEDED turn when a newer turn carries one.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { liveStatus, normaliseStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('PLANNER_PATH is required'); process.exit(1); }
const journalDir = path.join(PLANNER, 'journal');

let pass = 0, fail = 0;
const ok = (label, cond, got, want) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL [${label}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};

const B = '<!-- OVERNIGHT-AGENT do not edit this line -->';
const A = '<!-- from: overnight-agent -->';
const U = '<!-- from: me -->';

// ---------------------------------------------------------------- normaliseStatus
// POSITIVES: dialects that occur verbatim in the live corpus.
const normPos = [
  ['space dialect (#254 literal)', 'In progress ', 'in-progress'],
  ['hyphen dialect (#244 literal)', 'In-progress ', 'in-progress'],
  ['plain proposed', 'Proposed ', 'proposed'],
  ['done with parenthetical (#196 literal)', 'Done (research complete) ', 'done'],
  ['blocked with parenthetical (#219 literal)', 'Blocked (one question) ', 'blocked'],
  ['trailing em-dash prose', 'In-progress \u2014 checklist delivered; the appointment is yours', 'in-progress'],
  ['bold emphasis inside phrase', '**Done** ', 'done'],
  ['completed alias', 'Completed ', 'done'],
  ['skipped alias', 'Skipped ', 'skip'],
  ['case insensitive', 'BLOCKED', 'blocked'],
];
for (const [label, input, want] of normPos) ok(`norm+ ${label}`, normaliseStatus(input) === want, normaliseStatus(input), want);

// NEGATIVES: phrases that must NOT be coerced onto a canonical status.
const normNeg = [
  ['umbrella category (#191 literal)', 'Umbrella category '],
  ['executed (#248 literal)', 'executed '],
  ['empty', '   '],
  ['null', null],
  ['prose that merely contains a status word', 'the order is not blocked by anything'],
];
for (const [label, input] of normNeg) ok(`norm- ${label}`, normaliseStatus(input) === null, normaliseStatus(input), null);

// ---------------------------------------------------------------- liveStatus turns
// The load-bearing property: an OLDER Status line is not lifted when a NEWER turn has one.
const twoTurns = [
  '# Task 1', B, '**Status:** Proposed \u00b7 plan v1 \u00b7 2026-01-01', '',
  '## 2026-02-01', U, 'go ahead', '',
  '## 2026-02-02', A, '**Status:** Done \u00b7 plan v1 \u00b7 2026-02-02', 'shipped it',
].join('\n');
let r = liveStatus(twoTurns);
ok('newest turn wins over the block', r.status === 'done' && r.turnIndex === 1, r.status + '@' + r.turnIndex, 'done@1');

// A newest turn with NO status must fall back to the block, never to a middle turn.
const noStatusNewest = [
  '# Task 2', B, '**Status:** Blocked \u00b7 plan v2 \u00b7 2026-03-01', '',
  '## 2026-03-02', A, 'some prose with no status line at all', '',
].join('\n');
r = liveStatus(noStatusNewest);
ok('falls back to block when newest turn has none', r.status === 'blocked' && r.source === 'block', r.status + '/' + r.source, 'blocked/block');

// Three turns, only the MIDDLE one has a status -> must be used (it is the newest that has one),
// and must be reported as such rather than as the block.
const middleOnly = [
  '# Task 3', B, 'no status in the block', '',
  '## 2026-04-01', A, '**Status:** In progress \u00b7 plan v1 \u00b7 2026-04-01', '',
  '## 2026-04-02', A, 'prose only',
].join('\n');
r = liveStatus(middleOnly);
ok('newest turn CARRYING a status is used', r.status === 'in-progress' && r.turnIndex === 1, r.status + '@' + r.turnIndex, 'in-progress@1');

// No status anywhere -> null, not a guess.
r = liveStatus('# Task 4\njust prose\n');
ok('no status anywhere -> null', r.status === null && r.source === 'none', r.status + '/' + r.source, 'null/none');

// Non-canonical phrase surfaces raw text and canonical=false (never truncated to a word).
const nonCanon = ['# Task 5', B, '**Status:** Umbrella category \u00b7 no standalone plan \u00b7 2026-07-03'].join('\n');
r = liveStatus(nonCanon);
ok('non-canonical keeps raw + flags it', r.status === null && r.canonical === false && /Umbrella/i.test(r.raw), r.raw, 'Umbrella category');

// Date is taken from the status LINE, not from prose elsewhere.
const dated = ['# Task 6', B, '**Status:** In-progress \u00b7 plan v4 \u00b7 2026-08-25 \u2014 supersedes the 2026-06-07 note'].join('\n');
r = liveStatus(dated);
ok('date is the first on the status line', r.date === '2026-08-25', r.date, '2026-08-25');

// ---------------------------------------------------------------- live assertions
function read(id) { return readFileSync(path.join(journalDir, `task-${id}.md`), 'utf8'); }

// The `In progress` space dialect is the one the bridge parser mangles to the bare
// token `in`. Asserted as a CORPUS PROPERTY rather than against one task's current
// status: pinning this to #254 made it fail the moment that task was legitimately
// worked and its line changed to `Done` (2026-08-25 22:00; same brittleness the
// 21:30 run hit with mutcheck-live-ask). A property survives the task being worked.
const rxSpaceDialect = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}In progress\b/mi;
let dialectSeen = 0, dialectWrong = 0;
for (const f of readdirSync(journalDir)) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  const text = readFileSync(path.join(journalDir, f), 'utf8');
  const s = liveStatus(text);
  if (!s.line || !rxSpaceDialect.test(s.line)) continue;
  dialectSeen++;
  if (s.status !== 'in-progress') { dialectWrong++; console.log(`    dialect miss ${f}: ${JSON.stringify(s.raw)} -> ${s.status}`); }
}
ok(`space dialect "In progress" resolves to in-progress across the corpus (${dialectSeen} journals)`,
  dialectSeen > 0 && dialectWrong === 0, { seen: dialectSeen, wrong: dialectWrong }, { seen: '>0', wrong: 0 });

// #234 is the one active-board task whose NEWEST turn disagrees with its block.
r = liveStatus(read('234'));
ok('#234 live -> in-progress from a turn, not the block', r.status === 'in-progress' && r.source !== 'block', r.status + '/' + r.source, 'in-progress/turn-*');

// A genuinely non-canonical Status line must not be coerced onto a canonical status.
//
// ⚠️ This assertion used to read the LIVE journal for #191, and that made it unstable: on
// 2026-08-26 00:47 a run legitimately repaired #191's header from `**Status:** Umbrella
// category · …` to `**Status:** Skip · umbrella category, no standalone plan · …`. `liveStatus`
// then correctly returned `skip` (the word really is "Skip"), the assertion failed, and the
// failure looked like a CODE defect when the code was right and the fixture had moved.
// **Rule: a mutation check must not pin an invariant to a live journal other runs are allowed
// to rewrite — assert the invariant against a FIXTURE, and assert live data separately.**
const NONCANON_FIXTURE = `# Task 999: umbrella
---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## 🌙 Overnight Agent

**Status:** Umbrella category · no standalone plan · 2026-07-03

**Needs from you:** nothing.
`;
r = liveStatus(NONCANON_FIXTURE);
ok('fixture: non-canonical Status is NOT coerced', r.status === null && r.canonical === false, r.status, null);

// And the live companion: #191 now carries a canonical `Skip`, so it must read as skip.
// (If a future run rewrites that header again, THIS is the line to update — not the fixture.)
r = liveStatus(read('191'));
ok('#191 live -> skip (header now canonical)', r.status === 'skip' && r.canonical === true, r.status, 'skip');

// ---------------------------------------------------------------- corpus invariant
// Over every journal: whenever liveStatus picks turn N, no turn AFTER N carries a Status line.
const AGENT = '<!-- from: overnight-agent -->';
const rxStatusLine = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m;
let violations = 0, scanned = 0;
for (const f of readdirSync(journalDir)) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  scanned++;
  const text = readFileSync(path.join(journalDir, f), 'utf8');
  const res = liveStatus(text);
  if (res.source === 'none' || res.source === 'block') continue;
  const idx = Number(String(res.source).replace('turn-', ''));
  const starts = [];
  let i = text.indexOf(AGENT);
  while (i !== -1) { starts.push(i); i = text.indexOf(AGENT, i + AGENT.length); }
  for (let t = idx; t < starts.length; t++) {          // turns strictly AFTER the chosen one
    const slice = text.slice(starts[t], t + 1 < starts.length ? starts[t + 1] : text.length);
    if (rxStatusLine.test(slice)) {
      violations++;
      console.log(`  FAIL invariant [${f}] chose turn ${idx} but turn ${t + 1} also has a Status line`);
      break;
    }
  }
}
ok(`corpus invariant: no superseded attribution (${scanned} journals)`, violations === 0, violations, 0);

console.log(`\nmutcheck-live-status: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
