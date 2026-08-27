// reversible-gate-sweep.mjs
//
// WHY: a defect class established on 2026-08-26 03:00 and confirmed live at 03:30 —
// `approval-gating work that needs no approval`. The agent writes an ask offering to do
// something, and waits — but the thing it offered is on the ✅ REVERSIBLE side of
// SKILL.md's own list, which means it was supposed to just do it and link the result.
//
// SKILL.md is explicit in two places:
//   - opening a draft PR is "easily reversible — OK to do during the plan step (no approval needed)"
//   - PHASE 2 step 4 INSTRUCTS the agent to "do the easily-reversible work now as part of the
//     proposal — branch, commit, push, and open a draft PR … Leave the irreversible finish
//     (merging) for the approved EXECUTE run."
//
// Victims measured so far:
//   #273 — 46d parked on "on your go I'll open the draft PR(s)"        (fixed 2026-08-26 03:00)
//   #432 —  2 nights parked offering `venue` (read-only research) and
//           `watch` (read-only monitoring) as if they needed approval  (fixed 2026-08-26 03:30)
//   #449 — parked on "one word — `draft the email`"; drafting is the
//           reversible thing SKILL.md says to produce INSTEAD of asking (fixed 2026-08-26 03:50)
//   #363 — 40d parked offering "scaffold" (a draft PR), "joy interview"
//           (draft a questionnaire) and "paths" (generate a doc from his
//           own files) — 3 of 4 options reversible                     (fixed 2026-08-26 03:52)
//
// The cost is not cosmetic: #363 sat 40 days and #273 sat 46 days waiting on a word that
// was never required. And per #432, a parked reversible ask can go STALE — its premise
// (SAM had 9 tickets) was falsified while it waited, so the answer the user would have
// given had already stopped being actionable.
//
// HEURISTIC, and deliberately conservative — three checkers in this suite have already
// cried wolf, so this reports EVIDENCE, not verdicts:
//   - it requires an explicit OFFER construction ("I'll …", "want me to …", "say the word
//     … "), or a backticked/bolded imperative token, so past-tense "I drafted it" and the
//     user's own prose can't trip it;
//   - it only matches verbs whose OUTPUT is a reversible artifact (a document, a draft, a
//     branch, a draft PR, a read-only lookup);
//   - it never matches send/submit/buy/order/merge/deploy/book/publish, which are the
//     ⛔ half an ask is legitimately allowed to gate.
//
// An ask offering BOTH (e.g. "`draft the email` … or `order it`") is still flagged, and
// should be: the reversible half should have been done, leaving only the irreversible
// half to ask about. That is exactly what #449 looked like.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);

// Verbs whose product is a reversible artifact. Kept tight on purpose.
const V = String.raw`(draft|write\s+up|research|generate|scaffold|compare|shortlist|price\s+out|look\s+up|spec\s+out|sketch|outline|prototype|propose|find\s+alternatives|monitor|watch)`;

// An offer is the agent volunteering to do it. Without this, ordinary prose matches.
const OFFERS = [
  new RegExp(String.raw`\b(?:I'?ll|I\s+will|I'?d|I\s+can)\s+(?:\w+\s+){0,3}${V}\b`, 'i'),
  new RegExp(String.raw`\bwant\s+me\s+to\s+(?:\w+\s+){0,2}${V}\b`, 'i'),
  new RegExp(String.raw`\bsay\s+the\s+word[^.]{0,40}?${V}\b`, 'i'),
  new RegExp(String.raw`\bif\s+you(?:'?d)?\s+(?:want|like)\s+me\s+to\s+(?:\w+\s+){0,2}${V}\b`, 'i'),
  // A one-word command token the user is asked to reply with: **`draft the email`**, `scaffold`
  new RegExp(String.raw`[\`"*]\s*${V}\b`, 'i'),
];

// Purely irreversible offers are legitimate gates. Listed for documentation and for the
// "mixed ask" note below — NOT used to suppress, because a mixed ask is still a defect.
const IRREVERSIBLE = /\b(send|submit|buy|order|purchase|merge|deploy|book|publish|pay|post)\b/i;

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);
const hits = [];
let considered = 0;

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;

  let status = '?';
  try {
    // oa-state.ps1 writes UTF-8 *with BOM*; JSON.parse throws without stripping it.
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    status = JSON.parse(raw).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');

  // A turn written today is not rot.
  const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).filter((d) => d <= TODAY).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  if (last === TODAY) continue;
  const ageDays = last ? Math.round((new Date(TODAY) - new Date(last)) / 86400000) : null;

  considered++;

  // The LIVE ask only — a superseded ask is not what the user is looking at.
  const { ask } = liveAsk(text);
  if (!ask) continue;

  const why = [];
  for (const re of OFFERS) {
    const hit = ask.match(re);
    if (hit) why.push(hit[0].trim().slice(0, 48));
  }
  if (!why.length) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 62);
  hits.push({
    id,
    status,
    ageDays,
    title,
    mixed: IRREVERSIBLE.test(ask),
    why: [...new Set(why)],
    ask: ask.slice(0, 190),
  });
}

hits.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

console.log(`considered (active, non-terminal, not written today): ${considered}`);
console.log(`FLAGGED — live ask gates work that needs no approval: ${hits.length}\n`);
for (const h of hits) {
  console.log(`#${h.id.padEnd(4)} ${String(h.ageDays ?? '?').padStart(3)}d  ${h.status.padEnd(11)} ${h.title}`);
  console.log(`      offer: ${h.why.join(' | ')}`);
  if (h.mixed) console.log('      note : MIXED — also offers an irreversible action; do the reversible half, keep the ask for the rest.');
  console.log(`      ask  : ${h.ask}\n`);
}
