// undelivered-plan-sweep.mjs
//
// WHY (established 2026-08-26 05:30 PT on #179, parked 72 days — the joint-oldest task)
// -------------------------------------------------------------------------------------
// `reversible-gate-sweep` (2026-08-26 03:00) catches the case where the ASK *offers*
// reversible work and waits for a word. It reads `liveAsk(text)` and nothing else.
//
// #179 is a DIFFERENT dimension and is invisible to it. Its ask —
//   "Omar's contact/handle if you want the draft addressed, and any specifics about his
//    talk to reference."
// — is a perfectly legitimate `Needs from you:`; there is no offer construction in it, so
// reversible-gate-sweep correctly reports 0. The defect is one level up, in the PLAN:
//
//   1. Summarize the "Die With Zero" ideas and the tombstone exercise …
//   2. Run the tombstone exercise framing … and DRAFT a short follow-up message to Omar …
//   3. NOTE whether an Outlook/email MCP could automate the follow-up — draft only, no send.
//
// Every step is on SKILL.md's ✅ REVERSIBLE list (summarize / draft / note; it even says
// "draft only, no send"). SKILL.md PHASE 2 step 4 is explicit:
//
//   "do the easily-reversible work now as part of the proposal … Leave the irreversible
//    finish for the approved EXECUTE run."
//
// So the whole deliverable should have been produced AT PROPOSAL TIME and linked for
// review. Instead the task sat 72 days having produced nothing, and the one genuinely
// user-owned detail (Omar's handle) held the entire reversible body hostage.
//
// THE SHAPE OF THE BUG, stated generally:
//   status=proposed  +  plan body 100% reversible  +  nothing produced
//
// That is not "the ask gates reversible work" (reversible-gate-sweep's dimension); it is
// "the APPROVAL gates reversible work". Same family as the 2026-08-25 21:45 finding that
// last night's rule pointed at a new dimension — there it was status rather than asks;
// here it is the plan body rather than the ask.
//
// CONSERVATISM — several checkers in this suite have cried wolf, so this reports EVIDENCE:
//   - `proposed` only. `in-progress` has already delivered something by definition, and
//     `blocked` is a different (already-swept) dynamic.
//   - The plan must contain >= 1 reversible verb, so a malformed or empty block cannot hit.
//   - It must contain ZERO irreversible verbs across the steps AND the deliverables line.
//     A plan that ends in "then buy it" is legitimately gated, so it is dropped entirely
//     rather than reported as mixed — a false positive here tells a run to go do work.
//   - It must have produced NOTHING: no `### Run log`, and no `task-<id>-*.{md,html,…}`
//     deliverable file beside the journal.
//   - A journal written today is skipped (same rule as the rest of the suite).

import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);

// Products that are documents/drafts/lookups — undoable by deleting a file.
const REVERSIBLE = /\b(summar[iy]|draft|write\s*-?\s*up|research|outline|compare|comparison|shortlist|note|list|review|read|audit|analy[sz]e|sketch|spec|scaffold|generate|collect|gather|identify|assess|evaluate|price\s+out|look\s+up|propose|recommend|plan)\w*/i;

// Anything that spends money, notifies a human, or mutates shared state.
//
// ⚠️ SPLIT INTO TWO TIERS, and the reason is the whole point of this sweep.
// The first cut used one flat token list — `\b(send|…|post|email|schedule|apply|install)\b`
// — and it dropped **the four joint-oldest tasks on the entire board**, every one of them
// on a NOUN:
//     #175 (73d) "Draft a ready-to-post Facebook Marketplace listing"   -> "post"
//     #179 (73d) "whether an Outlook/email MCP could automate …"        -> "email"
//     #213 (73d) "materials list, and a weekend schedule"               -> "schedule"
//     #263 (72d) "a one-page 'where it applies' list"                   -> "applies"
// In all four the plan is a DRAFT and says so. A bare token list does not distinguish
// "post it to Marketplace" from "ready-to-post", and the tasks it silently swallowed were
// precisely the ones that had been waiting longest. Hence:
//
//   STRICT     — verbs that are almost never nouns in a plan; matched bare.
//   QUALIFIED  — ambiguous words that are only irreversible when they take a direct
//                object ("email him", "schedule the appointment", "order the intercoms").
const IRREVERSIBLE_STRICT = /\b(send|sends|sending|submit|submits|submitting|buy|buys|buying|purchase|purchases|purchasing|merge|merges|merging|deploy|deploys|deploying|publish|publishes|publishing|pay|pays|paying|check\s*out|checkout|sign\s+up)\b/i;

const IRREVERSIBLE_QUALIFIED = [
  // "post it to Marketplace" — but NOT "ready-to-post" / "post-mortem".
  /(?<![-\w])post(?:s|ing)?\s+(?:it|them|this|the|a|an|to)\b/i,
  // "email him", "email the vendor", "email foo@bar" — but NOT "email MCP", "email address".
  /(?<![-\w/])email(?:s|ing)?\s+(?:it|them|him|her|us|out\b|the\s|a\s|\S+@)/i,
  // "schedule the appointment" — but NOT "a weekend schedule".
  /\bschedul(?:e|es|ing)\s+(?:it|them|the|a|an)\b/i,
  // "apply for the job" / "apply to the program" — but NOT "where it applies".
  /\bapply(?:ing)?\s+(?:for|to)\b/i,
  // "install the unit" — but NOT "installation notes".
  /\binstall(?:s|ing)?\s+(?:it|them|the|a|an)\b/i,
  // "book the flight" — but NOT "a book".
  /\bbook(?:s|ing)?\s+(?:it|them|the|a|an)\b/i,
  // "order the intercoms", "place the order" — but NOT "in order to".
  /\border(?:s|ing)?\s+(?:it|them|the|a|an|\d)\b/i,
  /\bplace\s+(?:the|an)\s+order\b/i,
  // "delete the rows" — but NOT "deletion is safe".
  /\bdelet(?:e|es|ing)\s+(?:it|them|the|a|an)\b/i,
  // "cancel the subscription".
  /\bcancel(?:s|ling|ing)?\s+(?:it|them|the|a|an)\b/i,
];

function matchIrreversible(s) {
  const m = s.match(IRREVERSIBLE_STRICT);
  if (m) return m[0];
  for (const re of IRREVERSIBLE_QUALIFIED) {
    const q = s.match(re);
    if (q) return q[0];
  }
  return null;
}

// A plan that PROMISES NOT to do the irreversible thing is the strongest possible signal
// that its body is reversible — yet the naive test above reads it as the opposite.
// #179's step 3 ends "— draft only, no send", and that literal "send" is what hid the
// joint-oldest task on the board from the first cut of this sweep. Strip such disclaimers
// (and "draft only" / "no purchase" / "without sending" / "rather than merging") BEFORE
// testing, so a negated verb cannot be read as an intent to perform it.
const NEGATED = new RegExp(
  String.raw`\b(?:no|not|never|without|rather\s+than|instead\s+of|stopping\s+short\s+of)\s+` +
  String.raw`(?:\w+\s+){0,2}` +
  String.raw`(?:send|sent|sending|submit|submitting|buy|buying|purchase|purchasing|order|ordering|` +
  String.raw`merge|merging|deploy|deploying|book|booking|publish|publishing|pay|paying|post|posting|` +
  String.raw`email|emailing|install|installing|apply|applying|delete|deleting|cancel|cancelling|schedule|scheduling)\w*`,
  'gi',
);
const DRAFT_ONLY = /\bdraft\s+only\b/gi;

function stripNegations(s) {
  return s.replace(NEGATED, ' ').replace(DRAFT_ONLY, ' ');
}

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const files = fs.readdirSync(JOURNAL);

/**
 * The agent block = sentinel -> the first genuine chat entry below it (or EOF).
 *
 * ⚠️ This is digest failure mode #7 (diagnosed 2026-08-23, fixed in the telegram-bridge's
 * `agentBlockText()` by PR #168) reappearing here, because the sweep suite grew its own
 * private copy of the parser and never got the back-port. Re-found 2026-08-26 06:45 while
 * auditing why #307 sat 63 days unflagged.
 *
 * A chat entry is a `## <date>` heading FOLLOWED BY a `<!-- from: … -->` marker, so the
 * date heading is the real boundary. A *bare* `<!-- from: overnight-agent -->` with no
 * date heading above it is not a chat entry at all — it is a provenance stamp a past run
 * wrote INSIDE its own block, between `**Status:**` and the plan body. Cutting there
 * severs the block right after the Status line, `planParts()` then finds zero numbered
 * steps, and `if (!steps.length) continue` drops the task before any reversibility logic
 * runs — so it can never be flagged, however long it is parked.
 *
 * Measured live with `block-truncation-scope.mjs` (82 active non-terminal blocks):
 * 5 blocks truncated, 4 of them 0 steps -> 3–5 steps, i.e. structurally invisible —
 * #307 (63d, proposed), #325 (60d, proposed), #283, #269. #272 loses 11.7 KB.
 *
 * Correct semantics, copied from the bridge:
 *   - `<!-- from: me -->` ends the block UNCONDITIONALLY (once the user speaks it's over).
 *   - `<!-- from: overnight-agent -->` ends it ONLY after a `## <date>` heading has been
 *     seen; otherwise it is provenance and the block continues through it.
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

/** Numbered plan steps + the "Deliverables if approved" line, from the block. */
function planParts(block) {
  const lines = block.split(/\r?\n/);
  const steps = [];
  let inPlan = false;
  let deliverables = '';
  for (const line of lines) {
    if (/^#{2,4}\s*.*Proposed plan/i.test(line)) { inPlan = true; continue; }
    const d = line.match(/^\s*\*{0,2}Deliverables[^:]*:\*{0,2}\s*(.*)$/i);
    if (d) { deliverables = d[1].trim(); inPlan = false; continue; }
    if (/^\s*\*{0,2}(Risks|Needs from you|Your call|Context)\b/i.test(line)) { inPlan = false; continue; }
    if (inPlan && /^\s*\d+[.)]\s+\S/.test(line)) steps.push(line.trim());
  }
  return { steps, deliverables };
}

const hits = [];
const drops = [];
let considered = 0;

for (const f of files) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;

  let status = '?';
  try {
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    status = JSON.parse(raw).status;
  } catch { /* untracked */ }
  if (status !== 'proposed') continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');

  const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).filter((d) => d <= TODAY).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  if (last === TODAY) continue;
  const ageDays = last ? Math.round((new Date(TODAY) - new Date(last)) / 86400000) : null;

  const block = blockText(text);
  if (!block) continue;
  const { steps, deliverables } = planParts(block);
  if (!steps.length) continue;

  considered++;

  const body = `${steps.join('\n')}\n${deliverables}`;
  if (!REVERSIBLE.test(body)) continue;
  const irr = matchIrreversible(stripNegations(body));
  if (irr) { drops.push({ id, ageDays, verb: irr, body: body.slice(0, 150) }); continue; }

  // Did it actually produce anything?
  const hasRunLog = /^#{2,4}\s*Run log/im.test(text);
  const artifacts = files.filter((x) => x.startsWith(`task-${id}-`));
  if (hasRunLog || artifacts.length) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 62);
  hits.push({ id, ageDays, title, steps: steps.length, deliverables: deliverables.slice(0, 120) });
}

hits.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

console.log(`considered (active, proposed, has a plan, not written today): ${considered}`);
console.log(`FLAGGED — plan is entirely reversible but nothing was produced: ${hits.length}\n`);
for (const h of hits) {
  console.log(`#${h.id.padEnd(4)} ${String(h.ageDays ?? '?').padStart(3)}d  ${h.steps} steps  ${h.title}`);
  console.log(`      deliverables: ${h.deliverables || '(none stated)'}\n`);
}

// Audit trail: which candidates an irreversible verb removed, and which verb did it.
// This is how the `email`-the-noun over-match that hid #179 was found; keep it available
// so the next tuning pass is evidence-driven rather than guesswork.
if (process.env.OA_SHOW_DROPS) {
  console.log(`\ndropped by an irreversible verb: ${drops.length}`);
  for (const d of drops.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))) {
    console.log(`  #${d.id.padEnd(4)} ${String(d.ageDays ?? '?').padStart(3)}d  verb="${d.verb}"`);
  }
}
