// self-promise-sweep.mjs — "I'll get on with it" that nobody got on with.
//
// WHY THIS EXISTS
// ---------------
// Found live 2026-08-26 23:50 PT on task #460. Its plan closed with:
//
//     **Needs from you:** nothing to start — the research half is reversible and I'll
//     get on with it.
//
// and then produced nothing. No Run log, no deliverable file. The run that wrote that
// sentence ended right after writing it. Shiv reads these on his phone in the evening,
// so what he saw was a promise with nothing behind it, on a task he had raised that
// afternoon. #459 carried the same sentence the same day.
//
// THE GAP THIS FILLS, precisely
// -----------------------------
// `undelivered-plan-sweep` already looks for reversible plans that produced nothing —
// and it read **0** on the run where #460 was sitting undelivered. It is not broken. Its
// own header states the rule it inherits from the rest of the suite:
//
//     "A journal written today is skipped (same rule as the rest of the suite)."
//
// That one-day grace is correct for every other delivery question — you cannot fault a
// plan for not being finished the minute it was written. But it makes this particular
// defect **structurally undetectable on the only run that could have prevented it**:
//
//   * The promise "I'll get on with it" is due THIS run, not tomorrow.
//   * Every detector that could see it is blind for 24 hours.
//   * By the time it becomes visible, the user has already read the empty promise.
//
// So the fix is not a shorter grace period — that would flag every freshly written plan,
// which is exactly the false positive the grace period exists to prevent. The fix is to
// make the test **self-contained within a single turn**, which removes the time
// dimension altogether:
//
//     If a turn asserts that nothing is needed from the user in order to start,
//     that same turn must show what it did.
//
// Both halves are written by the same run, in the same file write. There is no window in
// which the flag can be a false alarm because "it might still be coming" — the run that
// wrote the promise had its chance and has already ended.
//
// WHAT IT FLAGS
// -------------
// A task on the ACTIVE board whose live agent block:
//   1. contains a Proposed plan with at least one numbered step  — so it promised work
//      (this gate is what keeps purely informational "nothing needed, FYI" turns out);
//   2. has a `Needs from you` that asserts nothing/none is required to start;
//   3. shows no evidence of delivery anywhere after the sentinel — no `### Run log`, no
//      `task-<id>-*` deliverable file on disk, and no later agent chat entry.
//
// The third clause is deliberately generous. A false positive here sends a run off to
// redo work that is already done, which is the expensive failure mode; a missed catch
// only costs what it already cost. Delivery recorded in a chat entry below the block
// (which is how #459 was actually delivered) counts.
//
// Exit 1 when it finds something, 0 when clean — same contract as the rest of the suite.

import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = process.env.OA_JOURNAL_DIR || path.join(PLANNER, 'journal');

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';

// An assertion that the user is not required in order to begin.
//
// Tight on purpose. It must match the promise and not the ordinary "nothing to unblock
// it, but here are two optional calls" sign-off that dozens of finished tasks carry —
// those all have Run logs, so they pass clause 3 anyway, but a regex that leans on that
// for correctness would be one edit away from a wave of false alarms.
const SELF_START = [
  /^\W*(nothing|none)\b[^.]*\bto\s+(start|begin|kick\s*off|get\s+going)/i,
  /\bI'?ll\s+(just\s+)?(get\s+on\s+with\s+(it|this)|crack\s+on|press\s+ahead)/i,
  /^\W*(nothing|none)\b[^.]*\breversible\b[^.]*\bI'?ll\b/i,
  /^\W*(nothing|none)\b[^.]*\bI'?ll\s+do\s+(it|this)\s+(now|tonight|this\s+run)/i,
];

/**
 * The agent block = sentinel -> the first genuine chat entry below it (or EOF).
 * Copied verbatim from `undelivered-plan-sweep.mjs`, which took it from the telegram
 * bridge's `agentBlockText()` after digest failure mode #7. A bare
 * `<!-- from: overnight-agent -->` with no date heading above it is provenance, not a
 * chat entry, and cutting there severs the block right after the Status line.
 */
function blockText(text) {
  const s = text.lastIndexOf(SENTINEL);
  if (s === -1) return null;
  const lines = text.slice(s).split(/\r?\n/);
  const out = [];
  let sawDateHeading = false;
  for (const line of lines) {
    if (/^##\s+20\d\d-\d\d-\d\d/.test(line)) sawDateHeading = true;
    if (line.trim() === USER) break;
    if (line.trim() === AGENT && sawDateHeading) break;
    out.push(line);
  }
  return out.join('\n');
}

/** Numbered plan steps, from the block. Same parser as the sibling sweep. */
function planSteps(block) {
  const steps = [];
  let inPlan = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^#{2,4}\s*.*Proposed plan/i.test(line)) { inPlan = true; continue; }
    if (/^\s*\*{0,2}(Deliverables|Risks|Needs from you|Your call|Context)\b/i.test(line)) { inPlan = false; continue; }
    if (inPlan && /^\s*\d+[.)]\s+\S/.test(line)) steps.push(line.trim());
  }
  return steps;
}

/**
 * The `Needs from you` value, including its wrapped continuation lines.
 *
 * The promise that started this sweep spans two lines — "nothing to start — the research
 * half is reversible and I'll" / "get on with it." — so a single-line read would miss the
 * operative half of the sentence it exists to find.
 */
function needsFromYou(block) {
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\*{0,2}Needs from you:?\*{0,2}\s*(.*)$/i);
    if (!m) continue;
    const parts = [m[1].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;                                   // blank line ends it
      if (/^\s*\*{0,2}(Your call|Risks|Deliverables|Context|Status)\b/i.test(l)) break;
      if (/^\s*#{2,4}\s/.test(l)) break;                       // next heading
      parts.push(l.trim());
    }
    return parts.join(' ').trim();
  }
  return null;
}

/** Did this task produce anything at all, anywhere after the sentinel? */
function hasEvidence(text, id) {
  const s = text.lastIndexOf(SENTINEL);
  const after = s === -1 ? text : text.slice(s);

  if (/^#{2,4}\s*Run log\b/im.test(after)) return 'run log';

  // A later agent chat entry means the agent spoke again after the plan — which is how
  // #459's step 1 was actually delivered.
  if (/^##\s+20\d\d-\d\d-\d\d/m.test(after) && after.includes(AGENT)) return 'chat entry';

  const deliverable = fs
    .readdirSync(JOURNAL)
    .find((f) => new RegExp(`^task-${id}-.+\\.(md|html|csv|json|txt)$`, 'i').test(f));
  if (deliverable) return `deliverable ${deliverable}`;

  return null;
}

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const hits = [];
let considered = 0;

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');
  const block = blockText(text);
  if (!block) continue;

  if (!planSteps(block).length) continue;

  const needs = needsFromYou(block);
  if (!needs) continue;
  if (!SELF_START.some((re) => re.test(needs))) continue;

  considered++;

  if (hasEvidence(text, id)) continue;

  const title = (text.split(/\r?\n/)[0] || '').replace(/^#\s*/, '').trim();
  hits.push({ id, title, needs: needs.slice(0, 110) });
}

console.log(`turns promising to start without you: ${considered}`);
console.log(`FLAGGED — promised to get on with it, produced nothing: ${hits.length}\n`);
for (const h of hits) {
  console.log(`#${h.id.padEnd(4)} ${h.title}`);
  console.log(`      promised: ${h.needs}`);
}

process.exit(hits.length ? 1 : 0);
