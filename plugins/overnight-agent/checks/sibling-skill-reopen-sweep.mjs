// sibling-skill-reopen-sweep.mjs
//
// GUARDS: a sibling skill's journal turn must never read as a USER reopen.
//
// Task journals are shared. This agent writes turns into them, but so do the other installed
// skills (dance-church, instagram-publisher-monitor, kranbox-backup, ...), each stamping its
// own `<!-- from: <author> -->` marker. oa-state.ps1 originally recognised only
// `<!-- from: overnight-agent -->`, `<!-- oa-state`, and the OVERNIGHT-AGENT sentinel as
// machine-authored, so every other marker fell through to "user prose the agent hasn't
// answered" -> `reopened: true`.
//
// That verdict is UNCLEARABLE: SKILL.md forbids skipping a reopened task "even if its status is
// done/skip", so the agent re-opens a settled task, finds no human message, re-marks it -- and
// the sibling skill re-appends on its own schedule and re-arms it. Live instance: #254.
//
// This sweep is BEHAVIOURAL, not textual. It runs the *installed* oa-state.ps1 against a
// synthetic journal folder (isolated -JournalDir/-StateDir, live state untouched) and asserts
// the verdicts directly, so it cannot be fooled by the source merely mentioning the fix.
// It also reports how many live journals are currently exposed to the defect.
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

const HUMAN = 'me';
const PROV = /^[ \t]*<!--[ \t]*from:[ \t]*([^>\r\n]*?)[ \t]*-->/gm;

const AGENT_BLOCK = `# Task ID: synthetic

Notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

<!-- from: overnight-agent -->
The agent's last turn.

**Needs from you:** none
`;

const userTurn = '## 2026-08-26\n\n<!-- from: me -->\nOne more thing?';
const sibTurn = '## 2026-08-26\n\n<!-- from: dance-church -->\nRan the loop - nothing to change.';

// id -> [entries, expectedReopened, description]
const CASES = [
  ['901', [sibTurn], false, "a sibling skill's turn alone must NOT reopen"],
  ['902', [userTurn], true, 'a genuine user reply must reopen'],
  ['903', [sibTurn, userTurn], true, 'sibling then user must reopen'],
  ['904', [userTurn, sibTurn], true, 'user then sibling must reopen (no swallowed message)'],
];

function probeInstalledScript() {
  const root = mkdtempSync(join(tmpdir(), 'oa-sibling-sweep-'));
  const jdir = join(root, 'journal');
  const sdir = join(root, 'state');
  mkdirSync(jdir);
  mkdirSync(sdir);
  try {
    for (const [id, entries] of CASES) {
      const body = AGENT_BLOCK + entries.map((e) => `\n${e}\n`).join('');
      writeFileSync(join(jdir, `task-${id}.md`), body, 'utf8');
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

// Port of the CORRECT trailing-region rule, used only to size live exposure.
function siblingOnlyTrailing(content) {
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
  const marks = [...trailing.matchAll(PROV)].map((m) => m[1].trim());
  return marks.length > 0 && !marks.includes(HUMAN);
}

const exposed = [];
for (const f of readdirSync(join(planner, 'journal'))) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  const content = readFileSync(join(planner, 'journal', f), 'utf8');
  if (siblingOnlyTrailing(content)) exposed.push(f.replace(/^task-|\.md$/g, ''));
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
  `live journals whose newest content is a sibling skill's turn: ${exposed.length}` +
    (exposed.length ? ` (${exposed.map((i) => `#${i}`).join(', ')})` : ''),
);

if (probeError) {
  console.log(`\nFINDING: could not probe the installed script -- ${probeError}`);
  process.exit(1);
}

if (failures.length === 0) {
  console.log('\nbehavioural probe: 4/4 correct - a sibling turn does not reopen, a user reply still does.');
  process.exit(0);
}

console.log(`\nFINDINGS: ${failures.length} of ${CASES.length} behavioural cases wrong`);
for (const f of failures) {
  console.log(`  case ${f.id}: expected reopened=${f.expected}, got ${f.actual} -- ${f.why}`);
}
if (exposed.length) {
  console.log(
    `\n  ${exposed.length} live journal(s) are hitting this right now: ${exposed
      .map((i) => `#${i}`)
      .join(', ')}`,
  );
}
process.exit(1);
