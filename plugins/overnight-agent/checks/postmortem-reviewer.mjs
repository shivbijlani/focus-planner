// postmortem-reviewer.mjs — Dream mode's postmortem reviewer (task #425).
//
// OFF BY DEFAULT, ON PURPOSE.
// -----------------------------------------------------------------------------
// The approved plan (step 4) says: "keep activation behind a review gate until
// false-positive rates are known". This script therefore does NOTHING unless
//
//     OA_DREAM_POSTMORTEM=on
//
// is set. Unset, it prints one line and exits 0. That is deliberate and is the
// whole safety story for a feature whose failure mode is mutating the skill
// library on weak evidence.
//
// It is registered in run-sweeps.ps1 anyway, because that script's UNREGISTERED
// guard exists precisely so a new .mjs cannot be silently skipped — and a
// detector that is disabled AND unregistered is a detector nobody will ever
// switch on. Registered-and-disabled is visible; unregistered is not.
//
// WHAT IT PRODUCES (approved plan, step 5)
// -----------------------------------------------------------------------------
// A Dream-mode report listing candidates, accepted changes, rejected false
// positives WITH THEIR REASON, and the evidence behind each. It writes NOTHING
// to the skill library and NOTHING to any journal. Every action it proposes is
// a draft for a human to accept — matching the reversibility rule in SKILL.md
// (drafts and reports are reversible; mutating an installed skill is not).
//
// USAGE
//   $env:PLANNER_PATH='C:\Users\shiv\OneDrive\Apps\Focus Planner'
//   $env:OA_DREAM_POSTMORTEM='on'
//   node postmortem-reviewer.mjs [--json] [--out <file>]
//
// EXIT CODES — matching run-sweeps.ps1's CRASH/FINDINGS contract:
//   0  disabled, or enabled and no accepted candidates
//   1  enabled and it has candidates to show (FINDINGS, not a crash)
import fs from 'node:fs';
import path from 'node:path';
import { review } from './lib-postmortem.mjs';

const ENABLED = /^(on|1|true|yes)$/i.test(process.env.OA_DREAM_POSTMORTEM || '');

if (!ENABLED) {
  console.log(
    'postmortem-reviewer: DISABLED (set OA_DREAM_POSTMORTEM=on to enable). ' +
      'Off by default per task #425 step 4 — activation stays behind a review gate ' +
      'until false-positive rates are measured.',
  );
  process.exit(0);
}

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) {
  console.error('postmortem-reviewer: PLANNER_PATH is not set. Run via run-sweeps.ps1.');
  process.exit(2);
}

const JOURNALS = path.join(PLANNER, 'journal');
const asJson = process.argv.includes('--json');
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > -1 ? process.argv[outIdx + 1] : null;

// --- Which tasks are COMPLETED? -------------------------------------------------
// The completed board is the user's own action (SKILL.md: the agent never writes
// it), so it is the only authoritative statement that a task is finished. Agent
// state `done` is the agent's own claim about its own work and is deliberately
// NOT used here — same reasoning as #227: the agent must not be the sole witness
// for a decision about the agent.
function completedIds() {
  const p = path.join(PLANNER, 'planner-completed.md');
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    console.log('note: no planner-completed.md — nothing is authoritatively completed; exiting.');
    return [];
  }
  const ids = new Set();
  const rx = /^\|\s*(\d+)/gm;
  let m;
  while ((m = rx.exec(text))) ids.add(m[1]);
  return [...ids];
}

// --- Which skills already exist? ------------------------------------------------
// Reused rather than re-derived: #357 built the skills inventory for exactly this
// question. Falling back to an empty list is FAIL-SAFE in the conservative
// direction — with no known skills, GATE 4 can only ever route to `new-skill`,
// which is the loudest outcome and therefore the one a human will notice.
function existingSkills() {
  const roots = [
    path.join(process.env.USERPROFILE || '', '.copilot', 'skills'),
    path.join(process.env.USERPROFILE || '', '.agents', 'skills'),
  ];
  const names = new Set();
  for (const r of roots) {
    try {
      for (const e of fs.readdirSync(r, { withFileTypes: true })) names.add(e.name);
    } catch {
      /* absent root is not an error */
    }
  }
  return [...names];
}

const ids = completedIds();
if (!ids.length) process.exit(0);

const tasks = [];
for (const id of ids) {
  const p = path.join(JOURNALS, `task-${id}.md`);
  try {
    tasks.push({ id, title: '', text: fs.readFileSync(p, 'utf8') });
  } catch {
    /* a completed task with no journal has no postmortem to read */
  }
}

const skills = existingSkills();
const { accepted, rejected } = review(tasks, skills);

const report = {
  generated: new Date().toISOString(),
  completedTasksRead: tasks.length,
  knownSkills: skills.length,
  accepted,
  rejectedCount: rejected.length,
  rejectedByReason: rejected.reduce((a, r) => ((a[r.reason] = (a[r.reason] || 0) + 1), a), {}),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`postmortem-reviewer: read ${tasks.length} completed journals, ${skills.length} known skills.`);
  console.log(`  rejected ${rejected.length}: ${JSON.stringify(report.rejectedByReason)}`);
  if (!accepted.length) {
    console.log('  no candidates cleared all four gates.');
  } else {
    console.log(`  ${accepted.length} candidate(s):`);
    for (const c of accepted) {
      console.log(
        `   - ${c.topic}  ${c.action} -> ${c.target}  ` +
          `(confidence ${c.confidence}, tasks ${c.taskIds.join(',')})`,
      );
      const ev = c.signals.filter((s) => s.author === 'me').slice(0, 2);
      for (const e of ev) console.log(`       evidence [${e.kind}]: ${e.evidence}`);
    }
    console.log('  NOTE: these are DRAFT proposals. Nothing was written to any skill.');
  }
}

if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

process.exit(accepted.length ? 1 : 0);
