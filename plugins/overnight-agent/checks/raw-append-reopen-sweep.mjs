// raw-append-reopen-sweep.mjs
//
// GUARDS: a user message appended at the BOTTOM of a journal must reopen the task --
// including the shape SKILL.md explicitly promises and no other sweep tests: raw text with
// no `## <date>` heading and no `<!-- from: me -->` marker.
//
// SKILL.md, "Reopened after close":
//     reopened: true for any task where the user has spoken after your last turn
//     ... "a new `## <date>` entry OR RAW TEXT AT THE BOTTOM"
//
// oa-state.ps1 finds the end of this agent's last turn by searching FORWARD from its last
// anchor (`<!-- from: overnight-agent -->`, the legacy `<!-- oa-state` block, or the
// OVERNIGHT-AGENT sentinel) for the next `## ` heading. When there is no such heading --
// the normal shape for a journal whose newest turn is the agent's -- it returns
// `$content.Length`: THE WHOLE FILE IS THE AGENT'S TURN. Anything appended below it is
// therefore inside the agent's own turn, and `HasTrailingUser` stays false forever.
//
// So the user types a reply at the end of the file and the agent never sees it. That is the
// dangerous direction: a false "reopened" costs one needless look, a false "already
// answered" SILENTLY SWALLOWS THE MESSAGE, with nothing anywhere to show it happened.
//
// This is NOT the #191 / #192 defect and is not fixed by them. Measured 2026-08-27 across
// the live corpus, both scripts behave identically on the fixtures below. The two are
// separable because this fixture's agent turn carries a `<!-- from: overnight-agent -->`
// stamp, which takes the #191/#192 boundary bugs off the table:
//
//     shape                                          main    PR#192
//     ## <date> + <!-- from: me -->  (the app)        true     true
//     ## <date>, no marker                           true     true
//     raw text, no heading, no marker                FALSE    FALSE   <-- this sweep
//     nothing appended                               false    false
//
// The first two cases are REGRESSION GUARDS and matter as much as the third: every message
// the Focus Planner app and the Telegram fold-back write carries a `## <date>` heading, so
// they are the path that must never break while the third is being fixed.
//
// BEHAVIOURAL, not textual: it runs the *installed* oa-state.ps1 against a synthetic journal
// folder (isolated -JournalDir/-StateDir, live state untouched), so it cannot be fooled by a
// source file that merely mentions the fix.
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

// Mirrors the live shape (verified against task-244 / task-246 on 2026-08-27): the managed
// block, `###` sub-headings, and NO `## ` heading after the agent's turn. The
// `<!-- from: overnight-agent -->` stamp is deliberate -- it anchors the boundary on this
// agent's own marker so the #191/#192 boundary defects cannot influence the verdict.
const AGENT_BLOCK = `# Task 9xx: synthetic

Shiv's own notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

<!-- from: overnight-agent -->

### What I did

Wrote the thing.

**Needs from you:** nothing.
`;

const appShaped = '\r\n## 2026-08-27\r\n\r\n<!-- from: me -->\r\napprove\r\n';
const headingOnly = '\r\n## 2026-08-27\r\n\r\napprove\r\n';
const rawAppend = '\r\n\r\napprove - go ahead please\r\n';

// id -> [append, expectedReopened, description]
const CASES = [
  ['921', appShaped, true,
    'GUARD: an app-written reply (## date + from: me) must reopen'],
  ['922', headingOnly, true,
    'GUARD: a ## date entry with no marker must reopen'],
  ['923', rawAppend, true,
    "raw text at the bottom must reopen -- SKILL.md promises it, and it is silently swallowed"],
  ['924', '', false,
    'GUARD: an untouched answered journal must NOT reopen (no crying wolf)'],
];

function probeInstalledScript() {
  const root = mkdtempSync(join(tmpdir(), 'oa-rawappend-sweep-'));
  const jdir = join(root, 'journal');
  const sdir = join(root, 'state');
  mkdirSync(jdir);
  mkdirSync(sdir);
  try {
    for (const [id] of CASES) {
      writeFileSync(join(jdir, `task-${id}.md`), AGENT_BLOCK, 'utf8');
    }
    const run = (cmd, extra = []) =>
      execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, cmd,
         '-JournalDir', jdir, '-StateDir', sdir, ...extra],
        { encoding: 'utf8' },
      );
    run('seed');
    // Drive the REAL production sequence. SKILL.md requires `mark` after every turn the
    // agent writes, so a journal the agent has answered has ALWAYS been marked. Probing
    // seed->scan alone models a state that does not occur in practice, and would miss a
    // fix that does its work at mark time.
    for (const [id] of CASES) run('mark', ['-Id', id]);
    // The user speaks only AFTER the agent has finished and marked -- that ordering is the
    // whole point, so the appends have to happen here rather than up front.
    for (const [id, append] of CASES) {
      if (!append) continue;
      const f = join(jdir, `task-${id}.md`);
      writeFileSync(f, readFileSync(f, 'utf8').replace(/\s+$/, '') + append, 'utf8');
    }
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

// Sizes live exposure. A journal is exposed when nothing marks where the agent's turn
// ended, so anything appended below it is absorbed into that turn.
//
// Two things can provide that boundary:
//   1. a `## ` heading after the agent's last anchor (a later entry), or
//   2. an explicit `<!-- /overnight-agent turn-end -->` stamp, which `mark` writes at the
//      end of the turn. The stamp is the durable fix, because the boundary is genuinely
//      ambiguous from content alone -- an agent turn may end in a plain prose paragraph
//      that is indistinguishable from a short human reply.
//
// The sentinel branch mirrors the shipped boundary logic (skip the managed "Overnight
// Agent" heading, which is the agent's own, not a user entry).
const TURN_END = /^[ \t]*<!--[ \t]*\/overnight-agent[ \t]+turn-end[ \t]*-->[ \t]*$/m;

function rawAppendInvisible(content) {
  const sentinel = content.lastIndexOf('OVERNIGHT-AGENT do not edit');
  let self = -1;
  for (const m of content.matchAll(PROV)) {
    if (m[1].trim() === 'overnight-agent') self = m.index;
  }
  const marker = Math.max(self, sentinel, content.lastIndexOf('<!-- oa-state'));
  if (marker < 0) return false;

  // A turn-end stamp at or after the anchor is an explicit boundary: not exposed.
  const stamp = content.slice(marker).match(TURN_END);
  if (stamp) return false;

  let next = content.indexOf('\n## ', marker);
  if (marker === sentinel && next >= 0) {
    const he = content.indexOf('\n', next + 1);
    next = he < 0 ? -1 : content.indexOf('\n## ', he);
  }
  return next < 0;
}

const exposed = [];
let total = 0;
for (const f of readdirSync(join(planner, 'journal'))) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  total += 1;
  const content = readFileSync(join(planner, 'journal', f), 'utf8');
  if (rawAppendInvisible(content)) exposed.push(f.replace(/^task-|\.md$/g, ''));
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
  `live journals where a raw append at EOF would be invisible: ${exposed.length} of ${total}`,
);

if (probeError) {
  console.log(`\nFINDING: could not probe the installed script -- ${probeError}`);
  process.exit(1);
}

if (failures.length === 0 && exposed.length === 0) {
  console.log(
    `\nbehavioural probe: ${CASES.length}/${CASES.length} correct - every shape of user reply ` +
      'reopens the task, and an untouched journal stays quiet.',
  );
  process.exit(0);
}

// The live count MUST affect the verdict, and for a long time it did not.
//
// The probe above calls `mark` on every fixture before appending (it models the production
// sequence, correctly). But `mark` is exactly what writes the turn-end stamp -- so the probe
// only ever tested the world where the stamp EXISTS. Meanwhile 157 of 238 real journals were
// in the other world, unmarked since the stamp shipped and therefore blind to a raw append.
// The sweep printed "157" and exited 0 on every run.
//
// That is the "a detector that cannot see and a system that is healthy produce the same
// number" failure: the one signal that would have caught the live gap was the one signal
// wired to nothing. A passing probe proves the CODE is right; only this count proves the
// CORPUS is. Both have to be able to fail.
if (exposed.length > 0) {
  console.log(
    `\nFINDINGS: ${exposed.length} live journal(s) would silently swallow a raw reply typed ` +
      'at the bottom -- the agent turn runs to EOF with no turn-end stamp.',
  );
  console.log(`  exposed: ${exposed.slice(0, 40).join(', ')}${exposed.length > 40 ? ', ...' : ''}`);
  console.log('  fix: powershell -File plugins/overnight-agent/checks/backfill-turn-end.ps1');
}

if (failures.length) {
  console.log(`\nFINDINGS: ${failures.length} of ${CASES.length} behavioural cases wrong`);
  for (const f of failures) {
    console.log(`  case ${f.id}: expected reopened=${f.expected}, got ${f.actual} -- ${f.why}`);
  }
}
process.exit(1);
