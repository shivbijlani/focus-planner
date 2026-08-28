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
//
// TWO FALSE POSITIVES, ONE NIGHT LATER (fixed 2026-08-27 01:20 PT)
// ----------------------------------------------------------------
// This sweep shipped on 2026-08-26 finding exactly 1 victim (#357). On its SECOND run it
// reported 2 findings and BOTH were false. A detector that cries wolf on its second night
// gets skimmed, and the specific harm here is concrete: a run that obeys either finding
// would REDO FINISHED WORK — re-drafting an application packet that already exists on disk.
// (user-settings.md, 2026-08-26 15:00: "the detector for it would have been the sixth
// wolf-crier".) They failed for two INDEPENDENT reasons, so both fixes are load-bearing:
//
//   1. #357 — DOC_GUARD was evaluated PER LINE while the documentation it looks for is a
//      PARAGRAPH. The live text is a postmortem quoting the retired sentence:
//
//          *The previous version of this line said "On your approval I can open a **draft
//          PR** ... as the reversible
//          first step." That sentence is why this task sat for 52 days: ... SKILL.md's own
//          list of things that need no approval ...
//          ... Recorded as the founding case of `deliverable-gate-sweep`.*
//
//      The gate matched on line 1; every DOC_GUARD token ("SKILL.md's own", "need no
//      approval", "deliverable-gate") sits on lines 2-4, because markdown wrapped the
//      paragraph. So the sweep flagged the very sentence that documents its own founding
//      case. Fix: evaluate DOC_GUARD over the whole surrounding paragraph, and teach it the
//      quotation markers ("the previous version ... said", "used to say", "founding case").
//      This is the same line-vs-paragraph scoping bug as the 2026-08-25 21:00 finding that
//      three sweeps were "matching the right marker in the WRONG TURN".
//
//   2. #253 — a gate that was SATISFIED, with the evidence in a different file. The tracker
//      still carries a June offer ("Say the word and I'll **draft one tailored
//      application**"), but that draft was WRITTEN on 2026-08-26: the journal's live block
//      reads "application packet drafted (both roles)" and the packet is on disk at
//      Career\Applications\Sourcegraph-2026-08-26\ (8 files). The OFFER-modal guard cannot
//      catch this: the offer text is verbatim present-tense and never gets edited once the
//      work moves on. Fix: a gate is not live if the journal's LIVE AGENT BLOCK already
//      reports delivering that same verb family. The live block is the authority on what is
//      currently parked; a deliverable file is supporting evidence that goes stale.

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
// Evaluated over the whole PARAGRAPH, not one line: markdown wraps a postmortem across
// several lines, so the gate quotation and the words that mark it as a quotation routinely
// land on different lines (this is what made #357 a false positive on 2026-08-27).
const DOC_GUARD = /(deliverable-gate|reversible-gate|reversible\s+list|SKILL\.md's own|needs?\s+no\s+approval|defect\s+class|this\s+sweep|postmortem|founding\s+case|previous\s+version\s+of\s+this\s+line|used\s+to\s+(?:say|read)|that\s+sentence\s+is\s+why|no\s+longer\s+gated)/i;

// A gate is not live if the work it offers has since been DONE. The offer text in a
// deliverable is written once and rarely edited, so a satisfied gate stays verbatim
// present-tense forever (#253: a June "Say the word and I'll draft ..." still sits in the
// tracker, months after the packet was actually written). The authority on what is
// *currently* parked is the journal's live agent block, so ask it.
//
// Each family maps the OFFER verb to the shape its COMPLETION takes in a run log.
const VERB_FAMILIES = [
  { offer: /open\w*\s+(?:a\s+|the\s+)?(?:\w+\s+){0,2}?(?:draft\s+)?PRs?\b/i,
    done: /\b(?:opened|raised|pushed|landed)\b[^.!?]{0,60}\bPRs?\b|\bPR\s*#\d+|\/pull\/\d+/i },
  { offer: /\bdraft\b/i,        done: /\bdrafted\b|\bdraft\s+(?:is\s+)?(?:written|ready|delivered|complete)\b/i },
  { offer: /\bwrite\s+up\b/i,   done: /\b(?:wrote\s+up|written\s+up|write-?up\s+(?:is\s+)?(?:done|ready|delivered))\b/i },
  { offer: /\bresearch\b/i,     done: /\bresearched\b|\bresearch\s+(?:is\s+)?(?:done|complete|delivered)\b/i },
  { offer: /\bscaffold\b/i,     done: /\bscaffolded\b/i },
  { offer: /\bprototype\b/i,    done: /\bprototyped\b/i },
  { offer: /\bspec\s+out\b/i,   done: /\bspec(?:'?d|ced|ked)\s+out\b|\bspec\s+(?:is\s+)?(?:written|filed)\b/i },
  { offer: /\bshortlist\b/i,    done: /\bshortlisted\b/i },
  { offer: /\bcompare\b/i,      done: /\bcompared\b|\bcomparison\s+(?:is\s+)?(?:done|delivered)\b/i },
  { offer: /\boutline\b/i,      done: /\boutlined\b/i },
  { offer: /\bfile\s+(?:a\s+|an\s+)?issue\b/i, done: /\bfiled\b[^.!?]{0,40}\bissue\b|\bissues?\/\d+|\bGH\s*#\d+/i },
  { offer: /\bbuild\b/i,        done: /\bbuilt\b/i },
  { offer: /\bimplement\b/i,    done: /\bimplemented\b/i },
  { offer: /\bgenerate\b/i,     done: /\bgenerated\b/i },
  { offer: /\bsketch\b/i,       done: /\bsketched\b/i },
  { offer: /\bprice\s+out\b/i,  done: /\bpriced\s+out\b/i },
  { offer: /\blook\s+up\b/i,    done: /\blooked\s+up\b/i },
  { offer: /\bmock\s+up\b/i,    done: /\bmocked\s+up\b/i },
  { offer: /\bwire\s+up\b/i,    done: /\bwired\s+up\b/i },
  { offer: /\bpropose\b/i,      done: /\bproposed\b/i },
];

// Everything below the OVERNIGHT-AGENT sentinel: the agent block plus the chat entries
// that follow it. That whole region is "what the journal currently says", which is what a
// reader sees and therefore what decides whether the task is parked.
function liveBlock(text) {
  const i = text.search(/<!--\s*OVERNIGHT-AGENT\b/i);
  return i === -1 ? text : text.slice(i);
}

// Split a document into paragraphs, keeping each line's index so a matched line can be
// resolved back to the block of prose it belongs to.
function paragraphs(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let cur = null;
  lines.forEach((line, idx) => {
    if (!line.trim()) { cur = null; return; }
    if (!cur) { cur = { from: idx, lines: [] }; out.push(cur); }
    cur.lines.push(line);
  });
  return out.map((p) => ({ from: p.from, lines: p.lines, text: p.lines.join(' ') }));
}

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
const satisfied = [];
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
  const live = liveBlock(text);
  for (const f of files) {
    filesScanned++;
    const body = fs.readFileSync(path.join(JOURNAL, f), 'utf8');
    for (const para of paragraphs(body)) {
      // The paragraph, not the line, is the unit of documentation. A postmortem that
      // quotes a retired gate keeps the quotation and the "this is a quotation" markers
      // on different lines once markdown has wrapped it.
      if (DOC_GUARD.test(para.text)) continue;
      for (const line of para.lines) {
        const l = line.trim();
        if (!l) continue;
        let hit = null;
        for (const re of GATES) {
          hit = l.match(re);
          if (hit) break;
        }
        if (!hit) continue;

        // Has this offer already been fulfilled? If the live journal reports doing the
        // same verb, the deliverable's text is stale, not a live gate.
        const fam = VERB_FAMILIES.find((v) => v.offer.test(hit[0]));
        if (fam && fam.done.test(live)) {
          satisfied.push({ id, file: f, quote: hit[0].replace(/\s+/g, ' ').trim().slice(0, 90) });
          continue;
        }

        found.push({ file: f, quote: hit[0].replace(/\s+/g, ' ').trim().slice(0, 120), mixed: IRREVERSIBLE.test(l) });
        break;
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
// Report the suppressor's work rather than hiding it. A guard nobody can see is a guard
// nobody can tell has gone over-broad — the failure mode that made this sweep's own first
// night look clean while it was about to flag two non-defects.
if (satisfied.length) {
  console.log(`suppressed — offer already fulfilled in the live journal: ${satisfied.length} (${[...new Set(satisfied.map((s) => `#${s.id}`))].join(', ')})`);
}
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
