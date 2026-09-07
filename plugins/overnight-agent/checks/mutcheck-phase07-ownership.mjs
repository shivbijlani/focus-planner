#!/usr/bin/env node
// mutcheck-phase07-ownership.mjs
//
// Holds one boundary in SKILL.md: PHASE 0.7 READS catch-up doc comments. It does not CREATE or
// BIND catch-up docs, and it does not skip a task for lacking one. Creation is owned by
// `ensure-catchup-doc.mjs`, one level up, on a schedule.
//
// WHY THIS IS A CHECK AND NOT A COMMENT IN THE FILE
//
// #548 is what the prose version of this boundary cost. PHASE 0.7 was headed "doc-bound tasks
// only", instructed the reader to "Skip a task with no doc binding", and then — inside the part
// the reader had just been told to skip — instructed it to "Create only when bound: false". The
// instruction that would have ended the skip was unreachable to any run that obeyed the header.
// So the doc-bound set could only grow by hand:
//
//     live board rows : 84
//     doc-bound       :  5      (6.0%, measured 2026-09-05)
//
// and the other 79 kept getting exactly what Shiv complained about — long, stacked, link-less
// Telegram turns — because every behaviour in that family is gated on the task having a doc.
//
// The failure shape is the one this whole task keeps meeting: a step that cannot run looks
// identical to a step that had nothing to do. A run that skipped every unbound task reported no
// error, wrote a normal turn, and left the count at 5. Nothing was broken in a way anything could
// see.
//
// A prose fix would have restored a prose invariant. The contradiction was two sentences apart in
// one section and still survived; it can be reintroduced by any edit that reads reasonably in
// isolation. So the boundary is asserted here, where reintroducing it fails CI.
//
// WHAT IS ASSERTED
//
//   A1  PHASE 0.7 does not tell the reader to create or bind a doc.
//   A2  PHASE 0.7 does not tell the reader to skip a task for having no doc.
//   A3  PHASE 0.7 names the owner (`ensure-catchup-doc`), so a reader who needs binding knows
//       where it happens rather than inferring that it happens nowhere. Without A3, A1 and A2 are
//       satisfied by deleting the subject entirely, which is how a boundary becomes a silence.
//
// A1 and A2 are each independently sufficient to recreate #548: creation instructions inside a
// skipped phase, or a skip with no owner named elsewhere, both end with unbound tasks nobody
// binds. They are asserted separately so a regression says which half came back.
//
// Fixtures are synthetic SKILL.md bodies rather than mutations of the real file: the assertions
// are about a section's CONTENT, so a fixture states the failing shape directly and reads as the
// thing being forbidden.
//
// THE PREDICATES STAY DUMB ON PURPOSE
//
// These match text, so they cannot tell an order from a description of an order — the first draft
// of the fixed SKILL.md failed A2 by quoting the very instruction it had just removed, while
// explaining the history. The tempting fix is a cleverer regex that recognises past tense. That is
// precisely the defect #560 removed from `HasBlockingAsk`: a value recovered from prose, where the
// phrasing an author chose for a human silently decides a gate. Recreating it here to save a
// sentence would be a poor trade.
//
// So the matcher stays literal and the prose accommodates it — the section describes the old
// instruction without reproducing its imperative form. That is the same discipline the .ps1
// mutchecks already rely on for their source anchors, and it keeps the failure mode legible: if
// this check ever fires, the sentence it names really is an instruction, not a memoir.

import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// Repo layout: checks/ and skills/overnight-agent/ are siblings under plugins/overnight-agent/.
// The deployed layout flattens, so an explicit override wins and CI passes one.
const SKILL =
  process.env.OA_SKILL_MD || path.join(HERE, '..', 'skills', 'overnight-agent', 'SKILL.md');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Slice PHASE 0.7 out of a SKILL.md body: from its own heading to the next heading of the same
// level. Returns null when the phase is absent, which is itself a finding rather than a pass.
export function extractPhase(md) {
  const start = md.search(/^### PHASE 0\.7\b.*$/m);
  if (start === -1) return null;
  const rest = md.slice(start);
  const nextIdx = rest.slice(1).search(/^### /m);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx + 1);
}

// The three assertions, as pure predicates over the phase text so the mutation arms can drive them
// with synthetic bodies. Each returns true when the boundary HOLDS.
//
// The create/bind patterns deliberately match the imperative ("Create only when", "create a doc",
// "bind it here") and not the noun — the phase must be able to *talk about* binding, name its
// owner, and explain why it does not do it. A predicate that banned the word would forbid A3.
export const RULES = {
  A1: {
    name: 'PHASE 0.7 does not instruct doc creation or binding',
    why: 'creation is owned by ensure-catchup-doc.mjs; two owners for one act is #548',
    holds: (p) =>
      !/^\s*\d+\.\s.*\bcreate\s+(?:a\s+|the\s+)?(?:second\s+)?doc/im.test(p) &&
      !/\bcreate only when\b/i.test(p) &&
      !/\bbind it here\b(?!\s*(?:rather|instead))/i.test(p),
  },
  A2: {
    name: 'PHASE 0.7 does not instruct skipping a task for having no doc',
    why: 'a phase cannot end a skip it is itself skipped by',
    holds: (p) => !/\bskip\s+(?:a|any|the)\s+task\s+(?:with|that has)\s+no\s+doc/i.test(p),
  },
  A3: {
    name: 'PHASE 0.7 names ensure-catchup-doc as the owner of binding',
    why: 'without a named owner, removing the instructions turns a boundary into a silence',
    holds: (p) => /ensure-catchup-doc/i.test(p),
  },
};

function evaluate(md) {
  const phase = extractPhase(md);
  if (phase === null) return { phase: null, results: null };
  const results = {};
  for (const [id, r] of Object.entries(RULES)) results[id] = r.holds(phase);
  return { phase, results };
}

console.log(`mutcheck-phase07-ownership — SKILL.md: ${SKILL}\n`);

if (!fs.existsSync(SKILL)) {
  console.error(`SKILL.md not found at ${SKILL}`);
  process.exit(2);
}

console.log('BASELINE (the real SKILL.md)');
const real = fs.readFileSync(SKILL, 'utf8');
const base = evaluate(real);

check('PHASE 0.7 section is present and extractable', base.phase !== null, 'no "### PHASE 0.7" heading found');

if (base.results) {
  for (const [id, r] of Object.entries(RULES)) {
    check(`${id}: ${r.name}`, base.results[id], r.why);
  }
}

// --- Mutations -----------------------------------------------------------------------------
//
// Each arm reintroduces one half of #548 into a synthetic phase and asserts the corresponding rule
// FAILS. An assertion that cannot fail is decoration; these are what make the three above load-
// bearing rather than three lines that happen to be true today.

const OK_PHASE = [
  '### PHASE 0.7 — Read the catch-up doc comments',
  '',
  'You do not create or bind docs here, and you do not skip a task for lacking one.',
  'Binding is enforced by `ensure-catchup-doc.mjs` in the sweep suite.',
  '',
  '1. `oa-state.ps1 doc -Id <ID>` → resolve the binding. Never search by title.',
  '',
  '### PHASE 1 — next',
  '',
].join('\n');

const MUTATIONS = [
  {
    id: 'A1',
    name: 'the numbered create instruction comes back',
    phase: OK_PHASE.replace(
      '1. `oa-state.ps1 doc -Id <ID>` → resolve the binding. Never search by title.',
      '1. `oa-state.ps1 doc -Id <ID>` → resolve the binding. Create only when `bound: false`.',
    ),
  },
  {
    id: 'A1',
    name: 'creation returns in different wording',
    phase: OK_PHASE.replace(
      '1. `oa-state.ps1 doc -Id <ID>` → resolve the binding. Never search by title.',
      '1. If the task is unbound, create a doc for it and bind it here.',
    ),
  },
  {
    id: 'A2',
    name: 'the self-cancelling skip comes back',
    phase: OK_PHASE.replace(
      'You do not create or bind docs here, and you do not skip a task for lacking one.',
      'Skip a task with no doc binding.',
    ),
  },
  {
    id: 'A3',
    name: 'the owner stops being named, so the boundary becomes a silence',
    phase: OK_PHASE.replace('Binding is enforced by `ensure-catchup-doc.mjs` in the sweep suite.', ''),
  },
];

console.log('\nMUTATIONS');
for (const m of MUTATIONS) {
  const { results } = evaluate(m.phase);
  check(
    `${m.id} killed — ${m.name}`,
    results !== null && results[m.id] === false,
    results === null ? 'phase not extractable' : `${m.id} still reported as holding`,
  );
}

// A phase that vanishes entirely must not read as a pass. Deleting the section satisfies every
// "does not contain" rule perfectly, which is the same success-shaped silence #548 was made of.
console.log('\nABSENCE');
{
  const { phase } = evaluate('# SKILL\n\n### PHASE 1 — next\n\nnothing here\n');
  check('a missing PHASE 0.7 is a finding, not a silent pass', phase === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
