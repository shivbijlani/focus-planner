// block-truncation-scope.mjs
//
// WHY (found 2026-08-26 06:45 PT while auditing why #307 sat 63 days unflagged)
// ----------------------------------------------------------------------------
// This is digest failure mode #7 — the "stray `<!-- from: overnight-agent -->` marker
// INSIDE the agent block" — reappearing in a DIFFERENT file. It was diagnosed and fixed
// in the telegram-bridge's `agentBlockText()` (PR #168, 2026-08-23) and then never
// back-ported to the sweep suite, which grew its own private copy of the same parser.
//
// The shape: SKILL.md's block is
//     <!-- OVERNIGHT-AGENT ... -->
//     ## 🌙 Overnight Agent
//     **Status:** ...
//     <!-- from: overnight-agent -->      <-- stray provenance stamp, NOT a chat entry
//     ### Proposed plan (v1)
//     1. ...
//
// `undelivered-plan-sweep.blockText()` (and any sibling that copied it) does:
//     end = first index of AGENT or USER marker after the sentinel
// A *bare* agent marker with no `## <date>` heading above it is a provenance stamp a past
// run wrote inside its own block. Cutting there severs the block immediately after the
// Status line, so `planParts()` sees ZERO numbered steps and the task is dropped by
// `if (!steps.length) continue` — before any reversibility logic runs.
//
// Consequence: such a task can NEVER be flagged by undelivered-plan-sweep, no matter how
// long it is parked or how reversible its plan is. It is a silent, structural exclusion —
// the same class of failure as the digest one, and invisible for the same reason: the
// sweep reports "considered: N" and a healthy "FLAGGED: 0", so the miss looks like health.
//
// The bridge's fix is the correct semantics and is what this measures:
//   - `<!-- from: me -->`            terminates the block UNCONDITIONALLY (user spoke).
//   - `<!-- from: overnight-agent -->` terminates it ONLY once a `## <date>` heading has
//     been seen (i.e. it genuinely starts a chat entry); otherwise it is provenance and
//     the block continues through it.
//
// Reports, per active non-terminal task: whether the naive parser truncates, and how many
// numbered plan steps each parser recovers. A row where naive=0 and fixed>0 is a task the
// sweep suite structurally cannot see.

import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';

/** The buggy copy, verbatim from undelivered-plan-sweep.mjs. */
function blockTextNaive(text) {
  const s = text.lastIndexOf(SENTINEL);
  if (s === -1) return null;
  let end = text.length;
  for (const needle of [AGENT, USER]) {
    const i = text.indexOf(needle, s);
    if (i !== -1 && i < end) end = i;
  }
  return text.slice(s, end);
}

/** The bridge's post-#168 semantics. */
function blockTextFixed(text) {
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

/** Numbered plan steps, verbatim from undelivered-plan-sweep.planParts(). */
function planSteps(block) {
  const steps = [];
  let inPlan = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^#{2,4}\s*.*Proposed plan/i.test(line)) { inPlan = true; continue; }
    if (/^\s*\*{0,2}Deliverables[^:]*:\*{0,2}\s*(.*)$/i.test(line)) { inPlan = false; continue; }
    if (/^\s*\*{0,2}(Risks|Needs from you|Your call|Context)\b/i.test(line)) { inPlan = false; continue; }
    if (inPlan && /^\s*\d+[.)]\s+\S/.test(line)) steps.push(line.trim());
  }
  return steps;
}

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);

const rows = [];
let scanned = 0;

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;

  let status = '?';
  try {
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    status = JSON.parse(raw).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');
  const naive = blockTextNaive(text);
  const fixed = blockTextFixed(text);
  if (!naive || !fixed) continue;
  scanned++;

  const nSteps = planSteps(naive).length;
  const fSteps = planSteps(fixed).length;
  // `fixed` re-joins lines and so can differ from `naive` by a trailing newline; only a
  // real severing (lost content or lost steps) counts as truncation.
  const lost = fixed.length - naive.length;
  if (fSteps === nSteps && lost <= 2) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 58);
  rows.push({
    id,
    status,
    title,
    nSteps,
    fSteps,
    lost,
    invisible: nSteps === 0 && fSteps > 0,
  });
}

rows.sort((a, b) => (b.fSteps - b.nSteps) - (a.fSteps - a.nSteps));

const invisible = rows.filter((r) => r.invisible);
console.log(`active non-terminal journals with a block: ${scanned}`);
console.log(`blocks TRUNCATED by the naive parser      : ${rows.length}`);
console.log(`  ...of those, plan steps 0 -> N (structurally invisible to undelivered-plan-sweep): ${invisible.length}\n`);

for (const r of rows) {
  const flag = r.invisible ? ' <-- INVISIBLE' : '';
  console.log(`#${r.id.padEnd(4)} ${r.status.padEnd(11)} steps naive=${r.nSteps} fixed=${r.fSteps}  lost=${r.lost}b  ${r.title}${flag}`);
}
