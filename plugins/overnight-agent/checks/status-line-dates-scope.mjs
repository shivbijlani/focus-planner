// status-line-dates-scope.mjs — how often does a Status line carry MORE THAN ONE date,
// and would "last date" vs "first date" change the answer?
//
// lib-live-status's statusFromSlice() takes the FIRST date on the line. The SKILL.md
// template puts the stamp LAST (`**Status:** Proposed · plan v1 · <YYYY-MM-DD>`), so any
// earlier date on the line is a reference inside prose, not the stamp. Since the new
// turn-vs-block arbitration is date-driven, a wrong date can decide the wrong winner.
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');

const rxStatusLine = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}[^\n]*/gm;
const rxDateG = /(\d{4}-\d{2}-\d{2})/g;
const TODAY = new Date().toISOString().slice(0, 10);

let lines = 0, multi = 0, wouldChange = 0, futureLast = 0;
const rows = [];

for (const f of fs.readdirSync(JDIR)) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');
  rxStatusLine.lastIndex = 0;
  let s;
  while ((s = rxStatusLine.exec(text)) !== null) {
    const line = s[0].split(/\r?\n/)[0];
    const dates = line.match(rxDateG) || [];
    if (!dates.length) continue;
    lines++;
    if (dates.length < 2) continue;
    multi++;
    const first = dates[0];
    const last = dates[dates.length - 1];
    const notFuture = dates.filter(d => d <= TODAY);
    const chosen = notFuture.length ? notFuture[notFuture.length - 1] : first;
    if (last > TODAY) futureLast++;
    if (chosen !== first) {
      wouldChange++;
      rows.push({ id: m[1], first, last, chosen, dates, line: line.slice(0, 130) });
    }
  }
}

console.log(`Status lines carrying a date: ${lines}`);
console.log(`  ...with MORE THAN ONE date: ${multi}`);
console.log(`  ...where "latest non-future" differs from "first": ${wouldChange}`);
console.log(`  ...where the LAST date is in the future (so "last" alone would be wrong): ${futureLast}`);
for (const r of rows) {
  console.log(`\n  #${r.id}  first=${r.first} last=${r.last} -> chosen=${r.chosen}   dates=[${r.dates.join(', ')}]`);
  console.log(`     ${r.line}`);
}
