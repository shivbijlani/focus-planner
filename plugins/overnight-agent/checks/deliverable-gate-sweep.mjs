// deliverable-gate-sweep.mjs
//
// WHY (found 2026-08-26 11:40 PT on #357, parked 52 days — the oldest ask on the board)
// -------------------------------------------------------------------------------------
// `reversible-gate-sweep` measures ONE dimension of the approval-gating defect: a gate
// written into the task's LIVE ASK. It reads 0 and has read 0 for several runs.
//
// #357 is a victim it structurally cannot see. Its journal ask is:
//
//     Needs from you: answers to the 4 open questions (or just "start with the
//     read-only Skills section").
//
// — no offer verb, nothing to match. The gate lives in the DELIVERABLE the ask points at,
// `journal\task-357-skills-as-loops.md`, last line:
//
//     "On your approval I can open a **draft PR** on V:\repos\focus-planner for the
//      read-only Skills section as the reversible first step."
//
// Opening a draft PR is the single most explicit item on SKILL.md's ✅ REVERSIBLE list, and
// PHASE 2 step 4 *instructs* the agent to do it as part of the proposal. So the task waited
// 52 days for a word that was never required — and the existing detector reported clean,
// because a deliverable file is not a journal ask.
//
// This is the same shape as the cross-task blind spot found on 2026-08-26 07:30 ("all 25
// detectors were single-journal"): the evidence lives one file away from where we look.
//
// WHAT THIS MATCHES — deliberately narrower than reversible-gate-sweep
// --------------------------------------------------------------------
// A finding needs ALL THREE, in one clause:
//   1. an APPROVAL-CONDITIONAL construction — "on your approval", "once you approve",
//      "on your go", "say the word", "pending your sign-off", …
//   2. an OFFER modal — "I can", "I'll", "I will", "let me", … The modal is what makes it a
//      standing offer rather than a report. Its own mutation check found this the hard way:
//      without it, "On your approval last week I opened the draft PR, which is now merged"
//      was flagged as a live gate. A satisfied, historical gate is not a defect.
//   3. a verb whose product is a REVERSIBLE artifact — open a draft PR, draft, scaffold,
//      prototype, spec out, research, write up, …
//
// Requiring the conditional (which reversible-gate-sweep does not) is what keeps this quiet
// on ordinary prose: a deliverable is a long document and "I'll draft …" appears in it for
// all sorts of innocent reasons. "On your approval I can draft …" does not.
//
// Purely-irreversible conditionals ("on your approval I'll merge / send / buy it") are
// LEGITIMATE gates and are not reported. A MIXED clause is reported, because the reversible
// half should already have been done.
//
// GUARD — a detector must not fire on text that documents the defect (rule established
// 2026-08-26 11:15). Lines naming this sweep, reversible-gate-sweep, or quoting SKILL.md's
// reversible list are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);

// 1. The approval-conditional. This is the discriminator.
const COND = String.raw`(?:on\s+your\s+(?:approval|go|nod|word|ok|okay|say-so|green\s*light)|once\s+you(?:'?ve)?\s+(?:approve|approved|say|said|confirm|confirmed)|when\s+you\s+approve|if\s+you\s+approve|after\s+you\s+approve|with\s+your\s+(?:approval|ok|okay|sign-?off)|pending\s+your\s+(?:approval|sign-?off)|subject\s+to\s+your\s+approval|say\s+the\s+word|give\s+me\s+the\s+(?:go|green\s*light|nod)|upon\s+approval|on\s+approval)`;

// 2. The OFFER modal — a standing offer, not a report of something already done.
//    Without this the sweep flags satisfied historical gates (see mutcheck).
const OFFER = String.raw`(?:I(?:'?ll|\s+will|\s+can|\s+could|\s+would|'?d)|we(?:'?ll|\s+will|\s+can)|let\s+me|happy\s+to|glad\s+to)`;

// 3. Verbs whose OUTPUT is a reversible artifact. `open …(draft) PR` is listed first
//    because it is SKILL.md's own headline example. Bare/infinitive forms only — a
//    past-tense form ("opened", "drafted") is a report, and is deliberately unmatched.
const REV = String.raw`(?:open(?:ing)?\s+(?:a\s+|the\s+)?(?:\w+\s+){0,2}?(?:draft\s+)?PRs?\b|draft|write\s+up|research|generate|scaffold|compare|shortlist|price\s+out|look\s+up|spec\s+out|sketch|outline|prototype|propose|build|implement|create\s+(?:a\s+)?(?:branch|issue|doc)|file\s+(?:a\s+|an\s+)?issue|mock\s+up|wire\s+up)`;

const IRREVERSIBLE = /\b(merge|send|submit|buy|order|purchase|deploy|book|publish|pay|post|apply|delete|rotate)\b/i;

// Both orders occur in real prose: "on your approval I can open a draft PR" and
// "I can open a draft PR on your approval". The inter-token gaps are `[^.!?]` so they
// stay inside one clause but can still cross markdown noise — the live #357 gate is
// "I can open a **draft PR**", where a `\w+`-only gap cannot get past the asterisks.
const GATES = [
  new RegExp(String.raw`${COND}[^.!?]{0,40}?\b${OFFER}\s[^.!?]{0,24}?\b${REV}\b`, 'i'),
  new RegExp(String.raw`\b${OFFER}\s[^.!?]{0,24}?\b${REV}\b[^.!?]{0,60}?${COND}`, 'i'),
];

// Text that DOCUMENTS the defect rather than committing it.
const DOC_GUARD = /(deliverable-gate|reversible-gate|reversible\s+list|SKILL\.md's own|needs no approval|defect class|this sweep|postmortem)/i;

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);

// Index every deliverable file by the task id encoded in its name.
const deliverables = new Map();
for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)-.+\.md$/i);
  if (!m) continue;
  if (!deliverables.has(m[1])) deliverables.set(m[1], []);
  deliverables.get(m[1]).push(f);
}

const hits = [];
let considered = 0;
let filesScanned = 0;

for (const id of [...active].sort((a, b) => Number(a) - Number(b))) {
  const journalFile = path.join(JOURNAL, `task-${id}.md`);
  if (!fs.existsSync(journalFile)) continue;

  let status = '?';
  try {
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    status = JSON.parse(raw).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const files = deliverables.get(id) || [];
  if (!files.length) continue;

  const text = fs.readFileSync(journalFile, 'utf8');

  // A turn written today is not rot.
  const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).filter((d) => d <= TODAY).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  if (last === TODAY) continue;
  const ageDays = last ? Math.round((new Date(TODAY) - new Date(last)) / 86400000) : null;

  // Only tasks that are actually WAITING on him. If there is no live ask, nobody is parked.
  const { ask } = liveAsk(text);
  if (!ask) continue;

  considered++;

  const found = [];
  for (const f of files) {
    filesScanned++;
    const body = fs.readFileSync(path.join(JOURNAL, f), 'utf8');
    for (const line of body.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || DOC_GUARD.test(l)) continue;
      for (const re of GATES) {
        const hit = l.match(re);
        if (hit) {
          found.push({ file: f, quote: hit[0].replace(/\s+/g, ' ').trim().slice(0, 120), mixed: IRREVERSIBLE.test(l) });
          break;
        }
      }
    }
  }
  if (!found.length) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 62);
  hits.push({ id, status, ageDays, title, ask: ask.slice(0, 150), found });
}

hits.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

console.log(`active non-terminal tasks with a live ask AND a deliverable file: ${considered}`);
console.log(`deliverable files scanned: ${filesScanned}`);
console.log(`FLAGGED — deliverable gates reversible work behind approval: ${hits.length}\n`);
for (const h of hits) {
  console.log(`#${h.id.padEnd(4)} ${String(h.ageDays ?? '?').padStart(3)}d  ${h.status.padEnd(11)} ${h.title}`);
  console.log(`      ask  : ${h.ask}`);
  for (const f of h.found) {
    console.log(`      gate : ${f.file}`);
    console.log(`             "${f.quote}"${f.mixed ? '   [MIXED — do the reversible half]' : ''}`);
  }
  console.log('');
}

process.exit(hits.length ? 1 : 0);
