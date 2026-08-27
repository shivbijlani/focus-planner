// Mutation check for the 4th date dialect added to inprogress-stall-sweep.mjs
// (the `**Status:** ... <date>` line). Standing rule: a new checker arm is not
// trusted until it is measured against positives AND negatives drawn from the
// live corpus, and until the source change is shown to be load-bearing.
const rxStatusDate = /^\s*\*{0,2}Status:\*{0,2}.*?(\d{4}-\d{2}-\d{2})/;

// POSITIVES: real Status lines lifted verbatim from live journals.
const positives = [
  ['#244 literal', '**Status:** In-progress \u00b7 plan v2 \u00b7 2026-08-25 \u2014 checklist delivered; the appointment is yours', '2026-08-25'],
  ['#245 literal', '**Status:** In-progress \u00b7 plan v2 \u00b7 2026-08-25 \u2014 playbook delivered; the call is Amy\u2019s', '2026-08-25'],
  ['#246 literal', '**Status:** In-progress \u00b7 plan v2 \u00b7 2026-08-25 \u2014 the note is written; sharing it with AK is yours', '2026-08-25'],
  ['template form', '**Status:** Proposed \u00b7 plan v1 \u00b7 2026-08-10', '2026-08-10'],
  ['unbolded', 'Status: Blocked \u00b7 plan v3 \u00b7 2026-07-04 \u2014 waiting on a sign-in', '2026-07-04'],
  ['leading space', '  **Status:** Done \u00b7 plan v2 \u00b7 2026-06-01', '2026-06-01'],
  // The prose after the date may name OLDER dates; we must take the FIRST.
  ['prose names an older date', '**Status:** In-progress \u00b7 plan v4 \u00b7 2026-08-25 \u2014 supersedes the 2026-06-07 note', '2026-08-25'],
];

// NEGATIVES: lines that must NOT be read as a Status date. Drawn from the shapes
// that actually occur in these journals.
const negatives = [
  ['run-log bold entry', '**2026-08-04 (overnight):**'],
  ['run-log bullet', '- 2026-07-01 (overnight): did the thing'],
  ['chat header', '## 2026-08-25'],
  ['prose mentioning status', 'The status of the order changed on 2026-08-01.'],
  ['status word mid-sentence', 'I checked its **Status** column and the row was added 2026-05-05.'],
  ['bold non-status heading', '**Risks / assumptions:** fees move; the note is dated 2026-08-25'],
  ['needs-from-you line', '**Needs from you:** nothing \u2014 ready since 2026-08-25'],
  ['deliverable link', '\ud83d\udcc4 **[`task-244-kids-passport-checklist.md`](./x.md)** 2026-08-25'],
  ['status line with NO date', '**Status:** In-progress \u2014 the note is written'],
];

let pass = 0, fail = 0;
for (const [label, line, want] of positives) {
  const m = rxStatusDate.exec(line);
  if (m && m[1] === want) { pass++; }
  else { fail++; console.log(`  FAIL positive [${label}] -> got ${m ? m[1] : 'null'}, want ${want}`); }
}
for (const [label, line] of negatives) {
  const m = rxStatusDate.exec(line);
  if (!m) { pass++; }
  else { fail++; console.log(`  FAIL negative [${label}] -> matched ${m[1]}`); }
}
console.log(`positives ${positives.length}, negatives ${negatives.length}`);
console.log(fail === 0 ? `ALL ${pass} CASES PASS` : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
