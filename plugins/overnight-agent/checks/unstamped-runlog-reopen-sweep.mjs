// unstamped-runlog-reopen-sweep.mjs
//
// GUARDS: a journal where THIS AGENT already replied must never read as a USER reopen --
// including the many historical journals where the reply carries no provenance marker.
//
// oa-state.ps1 computes  reopened = changed AND HasTrailingUser.  `changed` is a whole-file
// hash compare, so ANY byte edit flips it -- including an in-place repair by a sibling sweep
// (a dead-link rewrite, an apostrophe repair) that adds no content whatsoever.
//
// Most journals predate the `<!-- from: overnight-agent -->` stamp: the agent answered the
// user by appending a `### Run log` UNDER their `## <date>` entry. The turn boundary then
// lands on that user heading, so the agent's own reply sits in the "trailing" region and is
// read as unanswered user prose -- HasTrailingUser is pinned true forever. Such a journal is
// quiet only while it is byte-identical to the last snapshot, and one sweep away from
// false-reopening with a message answered weeks ago.
//
// That verdict is the expensive kind: SKILL.md forbids skipping a reopened task "even if its
// status is done/skip", so the agent re-answers a settled task -- which is exactly the
// "something seems to be executing in tasks that are already closed" symptom Shiv reported on
// #400. Live instance this run: #367 (done since 2026-07-27) reopened because the dead-link
// sweep rewrote two links in place at 16:53.
//
// This sweep is BEHAVIOURAL, not textual. It runs the *installed* oa-state.ps1 against a
// synthetic journal folder (isolated -JournalDir/-StateDir, live state untouched) and asserts
// the verdicts directly, so it cannot be fooled by the source merely mentioning the fix.
//
// The negative cases matter more than the positive ones: the guard must refuse to advance the
// boundary over anything that is not run-log shaped, because a false "already answered"
// silently swallows the user's message, while a false "reopened" only costs a look.
//
// exit 1 = findings.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const planner = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const script =
  process.env.OA_STATE_PS1 ||
  'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent\\oa-state.ps1';

const PROV = /^[ \t]*<!--[ \t]*from:[ \t]*([^>\r\n]*?)[ \t]*-->/gm;
const RUNLOG = /^[ \t]*###[ \t]+Run log[ \t]*$/gm;

const AGENT_BLOCK = `# Task ID: synthetic

Shiv's own notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

### Proposed plan (v1)
1. Do the thing.

**Needs from you:** none
`;

// The historical shape: the user speaks under a `## <date>` heading with no marker, and the
// agent answers with an unstamped `### Run log` directly beneath it.
const unstampedUserThenRunLog = `## 2026-07-27

He accidentally purchased from orbit, so we're just going to use that

### Run log
**2026-07-27 (overnight):**
- Got it, closing this out.
- Result: done. No further action.
- Next: complete.`;

const unstampedUserOnly = `## 2026-07-27

He accidentally purchased from orbit, so we're just going to use that`;

// The dangerous case the guard exists for: raw user text appended BELOW a run log, with no
// `## ` heading of its own. SKILL.md explicitly allows "a new `## <date>` entry or raw text
// at the bottom", so this must still reopen.
const runLogThenRawUserText = `## 2026-07-27

Earlier question?

### Run log
**2026-07-27 (overnight):**
- Answered it.
- Next: complete.

Actually wait, one more thing - can you also check the deductible?`;

const markedUserTurn = '## 2026-08-26\n\n<!-- from: me -->\nOne more thing?';
const siblingTurn = '## 2026-08-26\n\n<!-- from: dance-church -->\nRan the loop - nothing to change.';

// id -> [entries, expectedReopened, description]
const CASES = [
  ['911', [unstampedUserThenRunLog], false,
    'an unstamped run log answering the user must NOT reopen'],
  ['912', [unstampedUserOnly], true,
    'an unanswered unstamped user message must still reopen'],
  ['913', [runLogThenRawUserText], true,
    'GUARD: raw user text below a run log must still reopen'],
  ['914', [unstampedUserThenRunLog, markedUserTurn], true,
    'a new user reply after the answered turn must reopen'],
  ['915', [unstampedUserThenRunLog, siblingTurn], false,
    "a sibling turn after the answered turn must NOT reopen (no regression on #191)"],
  ['916', [markedUserTurn], true,
    'a plain marked user reply must still reopen (no regression)'],
  ['917', [siblingTurn], false,
    "a sibling turn alone must NOT reopen (no regression on #191)"],
];

function probeInstalledScript() {
  const root = mkdtempSync(join(tmpdir(), 'oa-runlog-sweep-'));
  const jdir = join(root, 'journal');
  const sdir = join(root, 'state');
  mkdirSync(jdir);
  mkdirSync(sdir);
  try {
    for (const [id, entries] of CASES) {
      writeFileSync(
        join(jdir, `task-${id}.md`),
        AGENT_BLOCK + entries.map((e) => `\n${e}\n`).join(''),
        'utf8',
      );
    }
    const run = (cmd) =>
      execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, cmd,
         '-JournalDir', jdir, '-StateDir', sdir],
        { encoding: 'utf8' },
      );
    run('seed');
    const rows = JSON.parse(run('scan'));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const failures = [];
    for (const [id, , expected, why] of CASES) {
      const actual = Boolean(byId.get(id)?.reopened);
      if (actual !== expected) failures.push({ id, expected, actual, why });
    }
    return failures;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Port of the boundary rule WITHOUT the run-log recovery, used only to size live exposure:
// how many journals are pinned at HasTrailingUser=true purely because the agent's reply was
// never stamped. These are the ones primed to false-reopen on the next byte change.
function pinnedByUnstampedRunLog(content) {
  const sentinel = content.lastIndexOf('OVERNIGHT-AGENT do not edit');
  let self = -1;
  for (const m of content.matchAll(PROV)) {
    if (m[1].trim() === 'overnight-agent') self = m.index;
  }
  const marker = Math.max(self, sentinel, content.lastIndexOf('<!-- oa-state'));
  if (marker < 0) return false;
  let next = content.indexOf('\n## ', marker);
  if (marker === sentinel && next >= 0) {
    const he = content.indexOf('\n', next + 1);
    next = he < 0 ? -1 : content.indexOf('\n## ', he);
  }
  const end = next < 0 ? content.length : next + 1;
  const trailing = content.slice(end);
  if (!trailing.trim()) return false;

  // Only counts if the agent demonstrably spoke last: a `### Run log` after the boundary,
  // with no `## ` heading following it.
  const logs = [...content.matchAll(RUNLOG)];
  if (!logs.length) return false;
  const last = logs[logs.length - 1].index;
  if (last < end) return false;
  return content.indexOf('\n## ', last) < 0;
}

const exposed = [];
for (const f of readdirSync(join(planner, 'journal'))) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  const content = readFileSync(join(planner, 'journal', f), 'utf8');
  if (pinnedByUnstampedRunLog(content)) exposed.push(f.replace(/^task-|\.md$/g, ''));
}

let failures = [];
let probeError = null;
try {
  failures = probeInstalledScript();
} catch (err) {
  probeError = err.message;
}

console.log(`installed oa-state.ps1: ${script}`);
console.log(
  `live journals pinned by an unstamped run log: ${exposed.length}` +
    (exposed.length ? ` (${exposed.map((i) => `#${i}`).join(', ')})` : ''),
);

if (probeError) {
  console.log(`\nFINDING: could not probe the installed script -- ${probeError}`);
  process.exit(1);
}

if (failures.length === 0) {
  console.log(
    `\nbehavioural probe: ${CASES.length}/${CASES.length} correct - an answered turn does not ` +
      'reopen, an unanswered one still does, and raw text below a run log is never swallowed.',
  );
  process.exit(0);
}

console.log(`\nFINDINGS: ${failures.length} of ${CASES.length} behavioural cases wrong`);
for (const f of failures) {
  console.log(`  case ${f.id}: expected reopened=${f.expected}, got ${f.actual} -- ${f.why}`);
}
process.exit(1);
