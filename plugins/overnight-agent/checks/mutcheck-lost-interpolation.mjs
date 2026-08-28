// mutcheck-lost-interpolation.mjs — mutation check for lib-lost-interpolation.mjs
// (2026-08-26). Every corpus line below is VERBATIM from a real journal, per the
// 2026-08-26 04:30 rule that corpora are harvested from live text, not invented.
//
// POSITIVES are lines where a `\$<amount>` was demonstrably eaten by PowerShell
// interpolation. NEGATIVES are the legitimate-backslash shapes that broke earlier
// cuts of this matcher: Windows paths, paths ending in a separator, glob escapes,
// footnote markers, and escaped angle brackets.

import { findTombstones, stripCode, scanText } from './lib-lost-interpolation.mjs';

let pass = 0;
let fail = 0;
const bad = [];

function expect(label, line, want) {
  const got = findTombstones(stripCode(line)).length > 0;
  if (got === want) pass++;
  else { fail++; bad.push(`${want ? 'MISSED ' : 'FALSE+ '} ${label}\n         ${line.slice(0, 130)}`); }
}

// ---------------------------------------------------------------- POSITIVES ----
const POSITIVE = [
  ['#234 orphaned cents',            '- 6/20 Northgate Market — \\.92'],
  ['#234 orphaned cents w/ italics', "- 6/18 Corazon Cocina — \\.53  *(SB Public Market)*"],
  ['#247 tilde + bold close',        '- Price **~\\**, market cap **~\\**. 52-week range **\\.57 – \\** — so it is down ~55%'],
  ['#247 range dash both sides',     '**Avg 12-mo target ~\\–\\** (~65–75% upside); range \\ low to \\ high.'],
  ['#247 bare amount mid-sentence',  '- **Contract tailwinds:** part of the new **\\ NSSL Lane 1** launch cohort'],
  ['#247 thousands separator',       '- **Revenue ramp is real:** ~\\ (2026) → forecast ~\\.28B (2027)'],
  ['#320 table cell',                '| **Ayres Hotel Mission Viejo** | ~5.5 mi | \\–\\ | **~\\–\\,392** | **Cheapest.** |'],
  ['#320 prose amount',              'you have **Hilton (San Diego?) at \\** and Kiley at **\\**, and you want 2 rooms'],
  ['#377 offer price in a message',  'Would you take **\\ shipped**? Can pay + arrange right away.'],
  ['#377 negotiation floor',         'then I will send the offer and negotiate down toward \\–70.'],
  ['#377 listing price',             '1. **Ariat Heritage IV Paddock Boots — size 9, black — \\** *(was \\)* · ships to you'],
  ['#213 costed materials range',    '(~\\–275), and a Fri-evening → Sunday → following-Wednesday schedule.'],
  ['#335 billions',                  "Microsoft's **Frontier** is a **\\.5B operating unit** that embeds 6,000+ AI engineers"],
  ['#335 comp band',                 '- **OpenAI** — **~70 FDE roles**. Total comp mid/senior ~\\–\\, staff \\+.'],
  ['#249 per-year saving',           '- Result: **TOU alone saves ~\\/yr — effectively nothing**, and **not** the estimate'],
  ['#412 thousands after approx',    '**2× 8-pax Odyssey ≈ \\,035**, both on your Progressive policy'],
  ['#412 amount inside parens',      'Reply **"book turo"** (\\, I will pre-fill to the pay step)'],
  ['#412 eaten before bold close',   '**Turo NV3500HD \\**  (add Turo protection)'],
  ['#297 amount then dash',          '- Avis Passport on-airport is now **\\** — ~\\ under the prior best major'],
  // Not an eaten AMOUNT but the same write-path defect: code-span backticks
  // rewritten as backslashes. Pinned as a positive because an early cut of the
  // `inPathToken` guard absolved it (its trailing `d\` is word-preceded) and
  // silently dropped it from the live corpus.
  ['#326 backticks rewritten to backslashes',
    '- New folder \\Career\\Applications\\Microsoft-AI-2026-06-26\\\\\\ with **RUBRIC-SCORES.md** and per-job folders for the top two (\\job-post.md\\ + \\rubric-score.md\\ + tailored \\Shiv-Bijlani-Resume.md/.html\\).'],
  // Range low-end eaten after a SPACE rather than a `~`. Missed by every earlier
  // cut; found 2026-08-26 while recovering #412 from its deliverable, which
  // still held the true figures ($515 Alamo / $520 Enterprise).
  ['#412 range low end eaten mid-sentence',
    '**Costco = 8-pax ceiling at SNA** (verified full vehicle list; max Enterprise/Alamo Odyssey \\-520).'],
  ['#412 range low end, deliverable table',
    '| **Two vehicles (e.g. 2× 8-pax Odyssey)** | 16 | ~**,035** (2×\\-520) | ✅ yes | Both airport-counter |'],
  ['end of line',                    'the nightly rate came to ~\\'],
  ['#249 per-year saving slash',     '- Result: **TOU alone saves ~\\/yr — effectively nothing**, and **not** the estimate'],
  ['price in parens, paren survives', 'the whole materials list came to (~\\) which is under budget'],
  ['price then hyphen range',        'budget the job at ~\\-275 all-in'],
];

// ---------------------------------------------------------------- NEGATIVES ----
const NEGATIVE = [
  ['#276 windows path in backticks', '- Files: `…\\Applications\\LinkedIn-Similar-2026-06-13\\03-GitHub\\Resume.pdf`'],
  ['#326 bare windows path',         '- …\\Microsoft-AI-2026-06-26\\01-DevEx-CICD\\Shiv-Bijlani-Resume.pdf (rubric 58/Hedge)'],
  ['#422 absolute path',             'Found them in C:\\Users\\shiv\\OneDrive\\6044 house spiget temp\\ and analyzed all three.'],
  ['#419 versioned dll path',        '…\\Application\\151.0.4129.93\\msedge.dll, while edge-cdp-3 loaded …\\151.0.4129.101\\msedge.dll'],
  ['#320 path ending in separator',  '**HTML deliverable:** task-320-lodging-report.html (Focus Planner\\journal\\).'],
  ['#306 glob escape after slash',   '| Dependency security loop | vuln upgrades across **github.com/shivbijlani/\\*** |'],
  ['#412 footnote marker at BOL',    '\\*Ranges are **typical market rates, not live quotes** — pricing 3 days out is volatile'],
  ['#412 footnote marker 2',         '\\*Not a live quote. 12-pax passenger vans are a "call the branch" category.'],
  ['#263 escaped angle brackets',    '| Name | npm | github.com/**\\<name\\>** (user/org) | .com | .app | .dev |'],
  ['correctly escaped dollar',       'the range is ~\\$150–275 for the whole materials list'],
  ['escaped underscore',             'the file is called task\\_213\\_paint\\_plan and lives in the journal'],
  ['escaped bracket',                'see \\[draft PR #168\\] for the back-ported parser fix'],
  ['regex inside code span',         'the matcher is `/\\\\(?=[\\s.,;:)\\]}%])/` and it is deliberately narrow'],
  ['path with trailing dot',         'stored under V:\\repos\\focus-planner.worktrees\\oa-block-stray-marker\\packages'],
  ['escaped paren in prose',         'the figure \\(before tax\\) is in the linked deliverable'],
  ['escaped hyphen at BOL',          '\\- this is a literal dash, not a bullet'],
  ['escaped bang for image',         'write \\!\\[alt\\] when you want a literal image marker'],
  // Harvested 2026-08-26 10:55 from the live corpus: every one of these was
  // FLAGGED by the shipped matcher, and all four sit on BOARD-ACTIVE tasks —
  // i.e. the noise was concentrated exactly where a real corruption matters
  // most. They are what made a run skim the finding list and re-note it twice.
  ['#276 JSON-escaped path + ellipsis',
    'Wrote 4 JD-tailored resumes to OneDrive\\\\...\\\\Applications\\\\GitHub-2026-06-20\\\\<req>\\\\Shiv-Bijlani-Resume.md (PARS voice rules respected).'],
  ['#276 JSON-escaped path before period',
    'PDFs ready on disk under Applications\\\\GitHub-2026-06-20\\\\<req>\\\\. Awaiting user to enter email + consent.'],
  ['#289 JSON path, separator then period',
    'wrote 2 draft record-request emails (Pacific Perio, Crown Hill) in accident\\\\draft-emails\\\\. Only PIP=State Farm at-fault.'],
  ['#296 path ends in separator after >',
    'Explained skills live in .github\\skills\\<name>\\ with a SKILL.md and are invoked by /name (like /dance-church).'],
  ['#348 escaped asterisk in quoted prose',
    '- From inbox: you replied twice on the review thread — *"I was expecting it all in the email"* and *"\\*Sections"*.'],
];

for (const [label, line] of POSITIVE) expect(label, line, true);
for (const [label, line] of NEGATIVE) expect(label, line, false);

// ------------------------------------------------- structural: fenced code ----
const fenced = ['before', '```js', "const RE = /\\ /;", 'const x = 1 \\', '```', 'after'].join('\n');
if (scanText(fenced).length === 0) pass++;
else { fail++; bad.push('FALSE+  fenced code block should be skipped entirely'); }

// a tombstone OUTSIDE a fence, after one closes, must still be found
const fencedThenReal = ['```', 'code \\ here', '```', 'the total was ~\\'].join('\n');
if (scanText(fencedThenReal).length === 1) pass++;
else { fail++; bad.push('MISSED  tombstone after a closed fence'); }

// ------------------------------------------------------ strong classification --
const strongCase = findTombstones('the range is ~\\–275');
if (strongCase.length && strongCase[0].strong) pass++;
else { fail++; bad.push('MISSED  `~\\–275` should classify as STRONG'); }

const weakCase = findTombstones('trailing note \\');
if (weakCase.length && !weakCase[0].strong) pass++;
else { fail++; bad.push('FALSE+  bare trailing backslash should be WEAK, not strong'); }

// ------------------------------------------------- ARM 2: tab-escape damage ----
// `\t` is a JSON/JS escape (not a PowerShell one), so a payload that travelled
// through a JSON tool call turns `\task-213-paint-plan.md` into TAB + `ask-...`.
function expectScan(label, text, wantCount) {
  const got = scanText(text).length;
  if (got === wantCount) pass++;
  else { fail++; bad.push(`ARM2   ${label}: got ${got}, want ${wantCount}\n         ${text.slice(0, 120)}`); }
}

expectScan('#192 deliverable link label', '- Deliverable: [\task-192-roadmap.md](task-192-roadmap.md).', 1);
expectScan('#213 bold deliverable line', '**Deliverables:** [\task-213-paint-plan.md](task-213-paint-plan.md) — done.', 1);
expectScan('#370 emoji deliverable line', '- 📄 [\task-370-healthy-living.md](task-370-healthy-living.md) — the living schedule', 1);
expectScan('#370 bare ref in a table cell', '| morning | Focus block | Itches → \task-370-backlog.md, not into the task |', 1);
expectScan('clean deliverable link', '- Deliverable: [task-213-paint-plan.md](task-213-paint-plan.md) — fine.', 0);
expectScan('leading-tab indented list', '\t- an indented bullet using a hard tab is not damage', 0);
expectScan('tab-indented code-ish prose', 'a line ending with a trailing tab\t', 0);

// ------------------------------------------------- ARM 3: lone-CR damage ----
// PowerShell's escape char is the backtick, so `renderInline` -> CR + "enderInline".
expectScan('#313 code span starting with r', 'the touch-points named in v1 (\renderInline at src/App.jsx:3381) were re-checked', 1);
expectScan('#399 reopened flag',             'it diffs each journal against the hash I last left, and reports changed/\reopened).', 1);
expectScan('#326 rubric path',               'per-job folders for the top two (job-post.md + \rubric-score.md + resume).', 1);
expectScan('normal CRLF file is clean',      'first line\r\nsecond line\r\nthird line', 0);
expectScan('normal LF file is clean',        'first line\nsecond line\nthird line', 0);

// ------------------------------------------- ARM 4: eaten value inside BOLD ----
// No backslash tombstone at all — the price was bolded but not escaped, so
// PowerShell removed it without a trace. Both shapes harvested verbatim from
// #412's deliverable, where they sat beside `\$` damage the sweep DID report.
expectScan('#412 empty bold in a table cell',
  '| **Turo — Nissan NV3500HD** | **12** | **** ✅ | ❌ (add Turo protection) | Only firm quote. |', 1);
expectScan('#412 empty bold mid-row',
  "| **Enterprise** Honda Odyssey | **8** | **** ← Enterprise's biggest at SNA |", 1);
expectScan('#412 severed thousands separator',
  '| **Two vehicles (e.g. 2× 8-pax Odyssey)** | 16 | ~**,035** (2×$515-520) | ✅ yes |', 1);
// The false positive this arm must never re-create: #422's drip-tubing gauge is
// a legitimate decimal-led bold span. It is why the arm matches `,` and not `.`.
expectScan('#422 decimal-led bold is NOT damage',
  'about 1/4-inch branch tubing; this failure is the larger **.600-inch OD mainline**, so its valve', 0);
expectScan('thematic break of asterisks is not empty bold', '****', 0);
expectScan('adjacent bold spans are not empty bold', 'the **first**, **second** and **third** items', 0);
// A write-up that DOCUMENTS this defect must not trip it. Caught live: the
// 2026-08-26 journal turn describing the fix quoted both signatures as examples
// and the arm flagged its own postmortem.
expectScan('documented signature inside a code span is not damage',
  'An unescaped `**$471**` leaves `****`, and `~**$1,035**` leaves `~**,035**`. No tombstone.', 0);

console.log(`mutcheck-lost-interpolation: ${pass} passed, ${fail} failed`);
if (bad.length) { console.log(''); for (const b of bad) console.log('  ' + b); }
process.exit(fail ? 1 : 0);
