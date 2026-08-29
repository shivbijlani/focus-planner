// mutcheck-postmortem.mjs — prove the four gates in lib-postmortem.mjs are LOAD-BEARING.
//
// WHY THIS IS MANDATORY FOR THIS PARTICULAR FEATURE
// -----------------------------------------------------------------------------
// The postmortem reviewer (#425) proposes changes to the SKILL LIBRARY. Its
// failure mode is not a missed finding, it is an over-confident one: a detector
// that fires on weak evidence turns "Shiv does not manage skills by hand" into
// "Shiv now reviews a queue of bad skill proposals", which is worse than the
// status quo. So each gate that suppresses a candidate has to be shown to
// actually suppress it — a gate that is decorative is indistinguishable from a
// gate that works, until it ships.
//
// This suite has been burned twice by detectors reading a confident permanent 0
// (cross-task-dependency-sweep's m[2] bug; reversible-gate-sweep filtering out
// the very population its victim lived in), which is why the baseline half here
// asserts the pipeline FIRES, not just that it stays quiet.
//
// METHOD — the same discipline as mutcheck-dead-deliverable / mutcheck-repo-drift:
// copy the REAL source into a temp dir, delete exactly one gate, run the REAL
// `review()` as a child process, and assert the mutant breaks EXACTLY its own
// negative case and nothing else. No reimplementation of the logic under test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LIB = path.join(import.meta.dirname, 'lib-postmortem.mjs');
const SRC = fs.readFileSync(LIB, 'utf8');
const S = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';

// --- Fixtures -----------------------------------------------------------------
// Each scenario is a self-contained corpus so `docFreq` / the ambient-vocabulary
// limit stay predictable. Topic words are repeated >=3 times because the pipeline
// requires a topic to be substantive within its own task before it is a candidate.

// A: genuine recurrence — the same kindle work in two separate completed tasks.
// The human line is what ATTACHES a signal to the topic: `kindle` appears in it,
// so route A's attached-signal clause is satisfied. Without such a line this is
// just a repeated word, which the calibrated detector correctly ignores.
const A1 = `# Task 801: kindle delivery

<!-- from: me -->
The kindle upload keeps failing when the file is too large.

${S}
### Run log
kindle upload done. The kindle library confirmed the kindle document landed.
`;
const A2 = `# Task 802: kindle again

<!-- from: me -->
Next time use the kindle web uploader, not the kindle email path.

${S}
### Run log
Sent to kindle. Verified in the kindle library that the kindle doc is newest.
`;
const A_FILLER1 = `# Task 803: unrelated\n${S}\nnothing of note here at all.\n`;
const A_FILLER2 = `# Task 804: unrelated\n${S}\nalso nothing of note here.\n`;

// B: a one-off chore. Same shape as A, but the topic is a chore word.
const B1 = `# Task 811: booking a table

<!-- from: me -->
The booking keeps failing on their site.

${S}
### Run log
booking made. The booking is confirmed and the booking reference is filed.
`;
const B2 = `# Task 812: booking again

<!-- from: me -->
Next time do the booking by phone, the booking form is broken.

${S}
### Run log
Another booking. The booking went through, booking confirmed.
`;

// C: one task only, WITH an attached signal — so the only thing keeping it out
// is the multi-task requirement. (A no-signal fixture would be rejected for two
// reasons at once and could not isolate the recurrence gate.)
const C1 = `# Task 821: sprinkler

<!-- from: me -->
The sprinkler keeps failing every summer.

${S}
### Run log
sprinkler fixed. The sprinkler valve was stuck so the sprinkler needed a reset.
`;
const C_FILLER = `# Task 822: unrelated\n${S}\nnothing of note here.\n`;

// D: clears recurrence via route B (human correction + procedure, both attached
// to `resume`) but the evidence carries an email address, so the privacy gate
// must suppress it.
const D1 = `# Task 831: resume work

<!-- from: me -->
Next time use resume-final@example.com for the resume, not the old resume address.

${S}
### Run log
1. open the resume doc
2. rewrite the resume summary
3. export the resume to pdf
`;
const D_FILLER = `# Task 832: unrelated\n${S}\nnothing of note here.\n`;

// F: the ambient-vocabulary control. Identical in shape to A and clears every
// other gate — the ONLY thing that may stop it is appearing in more than
// AMBIENT_MAX_DOCS journals.
const fWidget = (id) => `# Task ${id}: widget ${id}

<!-- from: me -->
The widget keeps failing on this widget job.

${S}
### Run log
widget handled. The widget was reset and the widget check passed.
`;

// G: agent-authored evidence ONLY. `gizmo` recurs across two tasks and has an
// attached signal, but that signal is the agent's own procedure text — nobody
// human ever said anything about gizmos. Route A must refuse to count it.
const gGizmo = (id) => `# Task ${id}: gizmo ${id}

<!-- from: me -->
Please get this done when you can.

${S}
### Run log
1. open the gizmo panel
2. reset the gizmo counter
3. verify the gizmo output
`;

// E: same as A, but a skill already covers the topic -> must REFINE, not create.
const E_SKILLS = ['kindle-sender'];

const SCENARIOS = {
  A: { tasks: [['801', A1], ['802', A2], ['803', A_FILLER1], ['804', A_FILLER2]], skills: [] },
  B: { tasks: [['811', B1], ['812', B2], ['803', A_FILLER1], ['804', A_FILLER2]], skills: [] },
  C: { tasks: [['821', C1], ['822', C_FILLER]], skills: [] },
  D: { tasks: [['831', D1], ['832', D_FILLER]], skills: [] },
  E: { tasks: [['801', A1], ['802', A2], ['803', A_FILLER1], ['804', A_FILLER2]], skills: E_SKILLS },
  F: {
    tasks: [
      ['841', fWidget(841)], ['842', fWidget(842)], ['843', fWidget(843)],
      ['844', fWidget(844)], ['845', fWidget(845)], ['846', A_FILLER1],
    ],
    skills: [],
  },
  G: { tasks: [['851', gGizmo(851)], ['852', gGizmo(852)], ['853', A_FILLER1]], skills: [] },
};

const RUNNER = `
import { review } from './lib-postmortem.mjs';
const scenarios = JSON.parse(process.argv[2]);
const out = {};
for (const [name, s] of Object.entries(scenarios)) {
  const tasks = s.tasks.map(([id, text]) => ({ id, title: '', text }));
  const { accepted, rejected } = review(tasks, s.skills);
  out[name] = {
    accepted: accepted.map((a) => ({ topic: a.topic, action: a.action, target: a.target })),
    rejected: rejected.map((r) => ({ topic: r.topic, reason: r.reason })),
  };
}
console.log(JSON.stringify(out));
`;

function run(mutatedSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-pm-'));
  fs.writeFileSync(path.join(dir, 'lib-postmortem.mjs'), mutatedSource, 'utf8');
  fs.writeFileSync(path.join(dir, 'runner.mjs'), RUNNER, 'utf8');
  const stdout = execFileSync(process.execPath, [path.join(dir, 'runner.mjs'), JSON.stringify(SCENARIOS)], {
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(stdout);
}

// --- Assertions ----------------------------------------------------------------
let pass = 0;
let fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
};

const acceptedTopics = (r, k) => r[k].accepted.map((a) => a.topic);
const rejectionFor = (r, k, topic) => (r[k].rejected.find((x) => x.topic === topic) || {}).reason;

console.log('BASELINE — the shipped source:');
const base = run(SRC);

// The firing proof. If this ever goes quiet the detector is dead, not clean.
check('A: genuine recurrence is ACCEPTED', acceptedTopics(base, 'A').includes('kindle'));
check('B: one-off chore is rejected as one-off-chore', rejectionFor(base, 'B', 'booking') === 'one-off-chore');
check('C: single-task topic rejected as insufficient-recurrence',
  rejectionFor(base, 'C', 'sprinkler') === 'insufficient-recurrence');
check('D: private data in evidence is rejected as private-data',
  rejectionFor(base, 'D', 'resume') === 'private-data');
check('E: an existing skill routes to refine-skill, not new-skill',
  (base.E.accepted.find((a) => a.topic === 'kindle') || {}).action === 'refine-skill');
check('E: refine-skill names the existing skill as its target',
  (base.E.accepted.find((a) => a.topic === 'kindle') || {}).target === 'kindle-sender');
// The two calibration gates. These are not theoretical: on the live corpus of 52
// completed tasks the detector accepted 1,417 candidates before the rarity cap
// and 195 before the human-evidence clause. Both numbers are recorded in
// task-425-dream-postmortem-design.md.
check('F: a topic in >AMBIENT_MAX_DOCS journals is rejected as ambient-vocabulary',
  rejectionFor(base, 'F', 'widget') === 'ambient-vocabulary');
check('G: agent-authored evidence alone does NOT satisfy recurrence',
  rejectionFor(base, 'G', 'gizmo') === 'insufficient-recurrence');

// --- Mutations ------------------------------------------------------------------
// Each deletes ONE gate. The assertion is two-sided: its own case must break, and
// the other cases must be unaffected — that is what proves the gates are
// independent rather than one gate masking another.
const MUTATIONS = [
  {
    id: 'M1 recurrence gate',
    find: 'return routeA || routeB;',
    repl: 'return true;',
    breaks: (r) => acceptedTopics(r, 'C').includes('sprinkler'),
    intact: (r) => rejectionFor(r, 'B', 'booking') === 'one-off-chore'
      && rejectionFor(r, 'D', 'resume') === 'private-data',
  },
  {
    id: 'M2 one-off-chore gate',
    find: 'return CHORE_TOPICS.has(candidate.topic);',
    repl: 'return false;',
    breaks: (r) => acceptedTopics(r, 'B').includes('booking'),
    intact: (r) => rejectionFor(r, 'C', 'sprinkler') === 'insufficient-recurrence'
      && rejectionFor(r, 'D', 'resume') === 'private-data',
  },
  {
    id: 'M3 privacy gate',
    find: 'return SECRET_PATTERNS.some((rx) => rx.test(text));',
    repl: 'return false;',
    breaks: (r) => acceptedTopics(r, 'D').includes('resume'),
    intact: (r) => rejectionFor(r, 'B', 'booking') === 'one-off-chore'
      && rejectionFor(r, 'C', 'sprinkler') === 'insufficient-recurrence',
  },
  {
    id: 'M4 existing-skill preference',
    // ⚠️ SINGLE-LINE ANCHOR ON PURPOSE. The first cut of this check used the whole
    // multi-line `existingSkills.find(...)` expression and reported "anchor not
    // found" — because these files are CRLF on disk while a JS template literal is
    // LF, so a multi-line anchor never matches. That failure mode is quiet in the
    // dangerous direction for a mutation check: it looks like a FAIL here, but the
    // same mistake in a two-sided harness would silently skip the mutation and
    // report a gate as proven when it was never tested. Keep every anchor to ONE
    // line, which is line-ending agnostic.
    find: '(s) => s.toLowerCase().includes(topic) || topic.includes(s.toLowerCase()),',
    repl: '() => false,',
    breaks: (r) => (r.E.accepted.find((a) => a.topic === 'kindle') || {}).action !== 'refine-skill',
    intact: (r) => rejectionFor(r, 'B', 'booking') === 'one-off-chore'
      && rejectionFor(r, 'D', 'resume') === 'private-data',
  },
  {
    // GATE 5. Restores the relative limit's practical effect: with the cap
    // effectively removed, ordinary vocabulary becomes a candidate again.
    id: 'M5 entity-rarity cap',
    find: 'export const AMBIENT_MAX_DOCS = 4;',
    repl: 'export const AMBIENT_MAX_DOCS = 999;',
    breaks: (r) => acceptedTopics(r, 'F').includes('widget'),
    intact: (r) => rejectionFor(r, 'B', 'booking') === 'one-off-chore'
      && rejectionFor(r, 'G', 'gizmo') === 'insufficient-recurrence',
  },
  {
    // The human-evidence clause on route A. Dropping the author test lets the
    // agent's own procedure text vouch for recurrence — the #227 mistake,
    // relocated. This is the mutation that reproduces the 195-candidate run.
    id: 'M6 human-evidence clause',
    find: "    candidate.signals.filter((s) => s.author === 'me' && s.taskId).map((s) => s.taskId),",
    repl: '    candidate.signals.filter((s) => s.taskId).map((s) => s.taskId),',
    breaks: (r) => acceptedTopics(r, 'G').includes('gizmo'),
    intact: (r) => rejectionFor(r, 'B', 'booking') === 'one-off-chore'
      && rejectionFor(r, 'F', 'widget') === 'ambient-vocabulary',
  },
];

console.log('\nMUTATIONS — each must break exactly its own case:');
for (const m of MUTATIONS) {
  if (!SRC.includes(m.find)) {
    fail++;
    console.log(`  FAIL ${m.id}: anchor not found in source (the check has drifted from the code)`);
    continue;
  }
  const mutated = SRC.replace(m.find, m.repl);
  let res;
  try {
    res = run(mutated);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${m.id}: mutant crashed — ${e.message.split('\n')[0]}`);
    continue;
  }
  check(`${m.id}: KILLED (its own case regresses)`, m.breaks(res));
  check(`${m.id}: other gates unaffected`, m.intact(res));
}

console.log(`\nmutcheck-postmortem: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
