// self-answerable-sweep.mjs
//
// WHY: the "operative line" family of defects has a sibling that keeps recurring —
// a task parked because the agent asked the USER a question the AGENT could have
// answered itself. Established rule (user-settings.md, 2026-08-25 17:00):
//   "Only ask the user for facts that exist solely in their head. Location, path,
//    filename and 'is X installed' are all self-answerable — and asking anyway costs months."
// Victims so far: #265 (72d, "which skill file"), #279 (70d, "where does the live app run"),
// #262 (70d, approval to clean files that no longer exist),
// #234 (2026-08-25, "if you remember: were those Jul 18 Alaska flights for the August trip or
//       for NY?" — answerable in 3 read-only calls from his own calendar + YNAB).
//
// #234 exposed a SCOPING GAP: the original patterns were all location/existence/installation
// phrasing. A *recall* ask ("if you remember…", "do you recall…") is the same defect class —
// the answer lives in the user's own records, not only in his head — but matched nothing.
// The recall arm below closes that. Kept deliberately narrow: it requires an explicit appeal
// to memory, because "do you know" / "which one" alone are ordinary preference questions and
// would flood this with false positives.
//
// #196 + #390 exposed a SECOND SCOPING GAP (2026-08-25 19:30). Both were parked asking for the
// make/model of an appliance the user OWNS — #196 for 123 days, #390 for 27 — and the answers
// were in his own Drive the whole time (`2026 washer-concerns.md` names the washer model, product
// code AND serial; a Sears receipt scan names the 2010 LG pair). Neither matched any arm above:
// they are not location, existence or recall questions. The `owned-artifact-identity` arm closes
// this. NOTE the deliberate framing — a model number often IS on a physical sticker, so this is
// not "the user cannot answer"; it is "SEARCH HIS RECORDS FIRST, ask only if that fails."
// That is why this file reports evidence, not verdicts.
//
// #289 exposed a THIRD SCOPING GAP (2026-08-26). It was the longest-stalled task on the board —
// **39 days** — parked on "confirm Jody's name spelling … + phone for the two dental
// record-requests". That is neither a location, an existence, a recall, nor a product-model ask,
// so it matched nothing. Yet BOTH halves were already in his own records: the attorney's spelling
// sits in her signature block in the saved `thread.md` inside the case folder (JODY REICH LAW,
// PLLC), and the phone was a single Google Contacts lookup. The `contact-detail` arm closes this.
// ⚠️ Sharpest lesson from that fix: this ask was ALREADY in `mutcheck-owned-artifact.mjs`'s
// NEGATIVE list. A previous run had read it, correctly judged it "not an owned-artifact ask", and
// enshrined it as expected-good — never asking whether it was self-answerable in some OTHER way.
// **A checker's negative corpus is harvested from real UNSOLVED asks, so it can quietly certify a
// genuine defect as intended behaviour. When adding an arm, re-read the existing negatives and ask
// which of them are actually positives for the new arm.**
//
// This flags active, non-terminal tasks whose LAST ask contains a location /
// existence / installation-state question. Every hit is a candidate for
// "answer it yourself instead of asking".
//
// It is a HEURISTIC. Per the false-alarm lesson (three checkers have now cried wolf),
// it deliberately reports evidence, not verdicts, and it excludes tasks whose journal
// was written today so a fresh turn is never mistaken for rot.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);

// Questions the agent can settle with a glob / a file read / a process check.
const PATTERNS = [
  [/\bwhere\b[^.?]{0,60}\b(live|lives|run|runs|running|located|installed|is it|does it)\b/i, 'where-is/where-runs'],
  [/\bwhich\s+(file|folder|path|repo|directory|script|skill)\b/i, 'which-file/folder'],
  [/\bwhat\s+(file|folder|path|repo|directory)\b/i, 'what-file/folder'],
  [/\bhow\s+(the|your)?\s*\w[\w\s-]{0,30}\b(runs|launches|starts|is launched|is started)\b/i, 'how-does-it-run'],
  [/\bconfirm\b[^.?]{0,60}\b(where|which file|which folder|path|installed|exists?)\b/i, 'confirm-location'],
  [/\bis\b[^.?]{0,40}\b(installed|present|already there|on disk)\b/i, 'is-it-installed'],
  [/\bdoes\b[^.?]{0,40}\b(exist|already exist)\b/i, 'does-it-exist'],
  // Recall arm (added 2026-08-25 19:00 after #234). Requires an EXPLICIT appeal to memory.
  [/\b(if|do|does|can)\s+you\s+(happen\s+to\s+)?(remember|recall)\b/i, 'appeals-to-memory'],
  [/\bany\s+(memory|recollection)\s+of\b/i, 'appeals-to-memory'],
  [/\b(remind|refresh)\s+(me|my memory)\b/i, 'appeals-to-memory'],
  // Owned-artifact identity arm (added 2026-08-25 19:30 after #196 + #390). Requires an explicit
  // request for a manufacturer identifier. Receipts, manuals and prior notes are searchable, so
  // these must be looked up BEFORE they are asked.
  [/\b(make|brand)\s*(\+|and|\/|,)\s*model\b/i, 'owned-artifact-identity'],
  [/\bmodel\s*(#|number|no\.?)\b/i, 'owned-artifact-identity'],
  [/\bserial\s*(#|number|no\.?)\b/i, 'owned-artifact-identity'],
  [/\b(what|which)\s+(brand|make)\b/i, 'owned-artifact-identity'],
  // NB: bare "which model" is deliberately NOT matched — in this corpus "model" is far more often
  // abstract ("which model of engagement", "data model", an LLM). Requiring "model is/are" keeps
  // the physical-artifact sense without flooding. Caught by mutcheck-owned-artifact.mjs.
  [/\b(what|which)\s+model\s+(is|are)\b/i, 'owned-artifact-identity'],
  // Contact-detail arm (added 2026-08-26 after #289). A PERSON'S name spelling, phone number,
  // email or postal address is not a fact that lives solely in the user's head either — it lives
  // in his Google Contacts, in the saved email thread with that person, and in the project folder.
  // #289 sat parked **39 days** (the longest stall on the board) asking him to "confirm Jody's
  // name spelling" and supply "Kiley's phone number". Both were already on disk/in his account:
  // the spelling was in the attorney's own signature block in `thread.md` inside the case folder
  // (JODY REICH LAW, PLLC) and echoed by the retainer filename, and the phone was ONE Contacts
  // lookup away (+1 206-250-7217). Same framing as owned-artifact-identity, deliberately: the
  // user CAN answer these, but his records must be SEARCHED FIRST and asked only if that fails.
  [/\b(name|surname|first name|last name)['’]?s?\s+spelling\b/i, 'contact-detail'],
  [/\bspelling\s+of\b/i, 'contact-detail'],
  [/\bhow\s+(do\s+you\s+)?spell\b/i, 'contact-detail'],
  [/\b(phone|cell|mobile|telephone)\s*(#|number|no\.?)\b/i, 'contact-detail'],
  [/\b(e-?mail|mailing|postal|street|home)\s+address\b/i, 'contact-detail'],
];

// Suppressor for the owned-artifact arm ONLY (added 2026-08-25 21:30 after #219, that
// arm's first live hit post-fix turned out to be a false positive).
//
// #219 asks "what detects the front gate today (camera brand+model / existing sensor /
// nothing)". It matched `brand+model`, but the ask ITSELF offers "nothing" as a valid
// answer — which means the asker already knows the artifact may not exist. That is a
// question about the STATE OF THE WORLD, not a lookup in the user's records, and no
// receipt search can answer it. Verified the hard way this run: a full sweep of his
// OneDrive (docs, receipts, scans) and a check for an Amazon order report found no
// camera/Echo ownership evidence at all — unlike #196/#205/#390, where a receipt or note
// named the artifact outright.
//
// Deliberately narrow: it requires an explicit "or nothing" / "/ none" alternative, so it
// cannot suppress a plain "what brand is the dryer?".
const OWNED_SUPPRESS = /(\/|\bor\b)\s*(nothing|none|neither)\b/i;

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
    // NB: oa-state.ps1 writes these UTF-8 *with BOM*; JSON.parse throws without stripping it.
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    status = JSON.parse(raw).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');

  // Skip anything already touched today — a fresh turn is not rot.
  const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).filter((d) => d <= TODAY).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  if (last === TODAY) continue;
  const ageDays = last ? Math.round((new Date(TODAY) - new Date(last)) / 86400000) : null;

  considered++;

  // The LIVE ask only (lib-live-ask.mjs). Taking the last `Needs from you:` anywhere in
  // the file tested a SUPERSEDED turn - which on this sweep risks the expensive direction:
  // a genuinely self-answerable live ask hidden behind a stale one.
  const { ask } = liveAsk(text);
  if (!ask) continue;

  let why = PATTERNS.filter(([re]) => re.test(ask)).map(([, label]) => label);

  // An owned-artifact ask that offers "nothing/none" as an answer is a state question,
  // not a records lookup. Drop that label; keep any other arm that fired on its own.
  if (OWNED_SUPPRESS.test(ask)) {
    why = why.filter((l) => l !== 'owned-artifact-identity');
  }
  if (!why.length) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 62);
  hits.push({ id, status, ageDays, title, why, ask: ask.slice(0, 190) });
}

hits.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

console.log(`considered (active, non-terminal, not written today): ${considered}`);
console.log(`FLAGGED — ask looks self-answerable: ${hits.length}\n`);
for (const h of hits) {
  console.log(`#${h.id.padEnd(4)} ${String(h.ageDays ?? '?').padStart(3)}d  ${h.status.padEnd(11)} ${h.title}`);
  console.log(`      why : ${h.why.join(', ')}`);
  console.log(`      ask : ${h.ask}\n`);
}
