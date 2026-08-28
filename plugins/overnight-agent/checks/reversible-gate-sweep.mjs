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
//
// ---------------------------------------------------------------------------------
// SECOND SIGNAL — ARTEFACT (added 2026-08-28, from the 02:00 PT run learnings)
// ---------------------------------------------------------------------------------
// #357 sat 2 days on `**`build 188`**` — a token authorising a DRAFT PR. This sweep ran
// and reported FLAGGED: 0, because `build` was not in the verb list. The list was then
// widened by one word, and the learning recorded the real problem:
//
//   "the offer-detection should key on *what the ask authorises* (does the journal's own
//    plan say the next step produces a branch / draft PR / document?) instead of on the
//    imperative verb Shiv is asked to type. The verb is the agent's arbitrary word
//    choice; the artefact is the fact."
//
// A vocabulary matcher degrades SILENTLY: it keeps printing 0, and that 0 is
// indistinguishable from a clean night. Appending synonyms one victim at a time cannot
// converge, because the vocabulary is the agent's own free choice of word.
//
// So there is now a second, independent signal that does not care which verb is used:
//
//   the ask hands the user a COMMAND TOKEN  (`build 188`, `go`, `ship it`)
//   AND names a REVERSIBLE ARTEFACT nearby  (draft PR, branch, write-up, shortlist…)
//   AND the token is not an irreversible imperative (merge/send/order/buy…)
//     => the token authorises PRODUCING a reversible artefact => it should not have been asked.
//
// The third clause is what keeps `merge 214` quiet even though its turn is entirely about
// a draft PR: there the artefact ALREADY EXISTS and the ask gates the irreversible finish,
// which is a legitimate gate. Producing an artefact is reversible; committing it is not.
//
// Both signals are reported with a `verb:` / `artefact:` prefix so a future run can see
// WHICH one fired — i.e. whether the verb list is still carrying its weight or the
// artefact signal is doing the work. That distinction is the thing the 02:00 learning
// says a bare `FLAGGED: 0` could never show.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);

// Verbs whose product is a reversible artifact. Kept tight on purpose.
const V = String.raw`(build|implement|code\s+up|draft|write\s+up|research|generate|scaffold|compare|shortlist|price\s+out|look\s+up|spec\s+out|sketch|outline|prototype|propose|find\s+alternatives|monitor|watch)`;

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

// --- ARTEFACT SIGNAL -------------------------------------------------------------
// Nouns that NAME a reversible deliverable. Unlike the verb list these are not the
// agent's free word choice — they are the thing that would exist afterwards, and
// SKILL.md's ✅ list is itself written in these terms ("a draft, a branch, an open PR",
// "research, comparisons, drafts, links, a decision-ready recommendation").
const ARTEFACT = String.raw`(draft\s+PR|draft\s+pull\s+request|pull\s+request|draft\s+issue|branch|write-?up|comparison|shortlist|outline|questionnaire|inventory|checklist|mock-?up|wireframe|spec(?:ification)?|scaffold|options?\s+list|documents?|docs?)`;

// ⚠️ MEASURED 2026-08-28: a bare artefact noun near a command token is NOT enough.
// Run on the live corpus it flagged 9 of 79 asks and 8 were false — because these
// journals are *about* producing documents, so the vocabulary is everywhere. #284's
// "(my recommendation)", #244's "the kids' ages", #459's "open the doc and leave one
// comment" are decision- or input-asks, not offers to produce something.
//
// The fact that matters is not the noun but the RELATION: does the ask say the token
// causes the agent to PRODUCE that artefact. So the artefact must be governed by a
// production verb within a short window. This is still verb vocabulary — but it is a
// closed semantic class describing an OUTCOME ("open the draft PR"), not the arbitrary
// imperative the user is told to type ("build 188"), which is what could never converge.
const PRODUCE = String.raw`(?:open|create|make|produce|put\s+up|write|build|generate|draft|prepare|scaffold|stand\s+up|spin\s+up|assemble|deliver|raise|file)`;
const PRODUCES_ARTEFACT = new RegExp(String.raw`\b${PRODUCE}\s+(?:\w+[\s-]+){0,3}${ARTEFACT}\b`, 'ig');

// ⚠️ MEASURED, round 2: production-relation alone still gave 3 of 79 false, because a
// production phrase says nothing about WHO produces it or WHETHER it is being offered:
//   #459  "open the doc and leave one comment"   -> the subject is SHIV, an instruction to him
//   #244  "nothing to make the checklist usable" -> a DISMISSAL ("needs nothing")
// So the relation must additionally be (a) attributed to the agent and (b) not negated.
// Both are read from a short lookback window, which is where English puts the subject.
const AGENT_SUBJECT = /\b(?:I|I'?ll|I'?d|me|we)\b/i;
const NEGATED = /\b(?:nothing|no\s+need|don'?t|doesn'?t|won'?t|not|never|without)\b/i;

function offersToProduce(scope) {
  for (const m of scope.matchAll(PRODUCES_ARTEFACT)) {
    const back = scope.slice(Math.max(0, m.index - 48), m.index);
    if (!AGENT_SUBJECT.test(back)) continue;   // Shiv is the one doing it, or nobody is
    if (NEGATED.test(back)) continue;          // "nothing to make the checklist usable"
    return m[0];
  }
  return null;
}

// The token the user is asked to type back: **`build 188`**, `go`, "ship it".
// Kept short (<= 4 words) so a backticked path or a quoted sentence is not a "command".
const TOKEN = /[`"]([^`"\n]{1,40})[`"]|\*\*([^*\n]{1,40})\*\*/g;

function commandTokens(ask) {
  const out = [];
  for (const m of ask.matchAll(TOKEN)) {
    const t = (m[1] ?? m[2] ?? '').trim();
    if (!t) continue;
    if (t.split(/\s+/).length > 4) continue;      // a phrase, not a command
    if (/^(Needs from you|Your call|Next|Status)\b/i.test(t)) continue; // journal furniture
    out.push(t);
  }
  return out;
}
// --------------------------------------------------------------------------------

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
  const { ask, context } = liveAsk(text);
  if (!ask) continue;

  // Asks wrap; the artefact is often on the continuation line. Tokens, however, must
  // come from the ask itself — that is the word the user is being told to type.
  const scope = context && context.length > ask.length ? context : ask;

  const why = [];
  for (const re of OFFERS) {
    const hit = ask.match(re);
    if (hit) why.push(`verb:${hit[0].trim().slice(0, 40)}`);
  }

  // SIGNAL 2 — the token authorises PRODUCING a reversible artefact.
  // Suppressed when anything irreversible is in play: then the artefact already exists
  // and the ask is gating the committing step, which is a legitimate gate.
  const tokens = commandTokens(ask);
  const art = offersToProduce(scope);
  if (tokens.length && art && !IRREVERSIBLE.test(scope)) {
    why.push(`artefact:${art.trim().slice(0, 40)} <- \`${tokens[0]}\``);
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
