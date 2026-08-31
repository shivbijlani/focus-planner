// shadow-journal-sweep.mjs
//
// GUARDS: a file that IS a journal, or a fork of one, but which no tool on this machine
// will ever read.
//
// WHY THIS EXISTS
// ---------------
// Every reader in this system filters the journal folder on the same pattern:
//
//     /^task-\d+\.md$/
//
// `oa-state.ps1 scan` uses it, all 42 sweeps use it, and the Telegram bridge uses it. That
// pattern is correct for finding journals. It is also, silently, the definition of "content
// that exists" -- anything in that folder shaped like a journal but named differently is
// invisible to the state store, invisible to every detector, and never mirrored to the phone.
//
// Found live 2026-08-27. Three such files were sitting in the journal folder:
//
//   task-249-DESKTOP-P9116M3.md   OneDrive sync-conflict fork of the #249 journal
//   task-292-DESKTOP-P9116M3.md   OneDrive sync-conflict fork of the #292 journal
//   task-328-shiv-devbox.md       a forked #328 journal misnamed as if it were a deliverable
//
// The last one is the one that shows why this matters. It carried a COMPLETE agent plan from
// 2026-06-27 -- real shopping research -- ending in three direct questions to Shiv:
//
//     1. Who/whose sizes -- US 7 = ? and US 8 = ?
//     2. "Matching" = identical pair or coordinated his-and-hers?
//     3. Budget per pair + any colour lean?
//
// Those questions were never surfaced on ANY surface, because no reader opens that filename.
// This run got lucky: the wedding they were for has passed and #328 was closed by Shiv on
// 2026-08-25, so nothing live was lost. The next one need not be lucky.
//
// This is the same defect class as the raw-append blind spot (PR #198), one level out. There
// the boundary INSIDE a file was wrong; here the set of files being read is wrong. Both fail
// in the dangerous direction: silently, with the content still sitting on disk looking fine.
//
// HOW IT DECIDES -- two arms, deliberately different evidence
// ----------------------------------------------------------
// 1. SHADOW JOURNAL -- the file carries the managed sentinel (`OVERNIGHT-AGENT do not edit`)
//    but is not named `task-<digits>.md`. The sentinel is written only by the agent and only
//    into a journal, so its presence is proof the file was being managed AS a journal. This
//    is evidence, not a guess about the filename.
//
// 2. CONFLICT COPY -- the name carries an OneDrive sync-conflict host suffix
//    (`-DESKTOP-XXXX`, `-LAPTOP-XXXX`). OneDrive writes these when the same file is edited in
//    two places; the planner data folder is OneDrive-synced, so this WILL recur. Reported even
//    without a sentinel, because a fork of a deliverable is also unreachable content, and
//    because a pre-sentinel-era journal fork (task-292) has no sentinel to find.
//
// H1 SHAPE IS DELIBERATELY NOT USED. Measured on the live corpus: `# Task <ID>: <title>` as
// the discriminator returns 5 files, and 3 of them (task-328-shiv-devbox aside) are ordinary
// deliverables that simply title themselves that way -- a 60% false-positive rate. A detector
// that cries wolf gets skimmed, and this family of bug is exactly the one that then slips
// through. The sentinel arm returns those same real hits with no false positives.
//
// WHAT IT REPORTS: for each hit, whether the real `task-<ID>.md` exists, and how many
// non-empty lines exist ONLY in the shadow file. That last number is the actual risk: 0 means
// the live journal is a superset and the shadow is redundant history; >0 means content exists
// nowhere else.
//
// THE BASELINE, and why it is not a snooze button
// -----------------------------------------------
// The three files found on 2026-08-27 were all reviewed by hand that night and all three are
// stale: #292 has no unique content at all, #249's is a June plan that was approved and
// executed, and #328's is a plan for a wedding that has since happened on a task Shiv closed
// himself. None of them needs action, and deleting files he owns is his call, not the agent's.
//
// So without a baseline this detector would read 3 forever. That is the exact failure this
// run spent its time removing from `swallowed-message-sweep`, which had reported the same 5
// settled items every single run until they were answered: a check that can never reach zero
// gets skimmed, and the next line down is the real one. Shipping a new permanent-red check
// would be re-introducing the bug while claiming to fix it.
//
// The baseline is content-addressed -- name + sha256 of the file's unique-line set. It is
// deliberately NOT "ignore this filename":
//   * if a baselined shadow file GAINS content, its hash changes and it becomes a finding again
//   * a NEW shadow file is always a finding
// So it silences exactly what was reviewed, and nothing else. Same pattern as the
// content-addressed baseline `lost-interpolation-sweep` uses for its known-unrecoverable lines.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const planner = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const jdir = join(planner, 'journal');

const SENTINEL = 'OVERNIGHT-AGENT do not edit';
const REAL_JOURNAL = /^task-(\d+)\.md$/;

// `write-turn.ps1` writes `task-<id>.bak-<stamp>.md` beside every journal it touches, so the
// folder is full of these by design. They are backups of a file that IS read, not orphans.
const BACKUP = /\.bak-/;

// OneDrive's conflict-copy suffix: the machine name, upper-case, before the extension.
const CONFLICT = /-(?:DESKTOP|LAPTOP)-[A-Z0-9]+\.md$/;

// The task id a shadow file belongs to, from its `task-<id>-...` prefix.
const OWNER = /^task-(\d+)[-.]/;

function uniqueLines(shadowText, liveText) {
  // Non-empty lines present in the shadow file and in no form in the live journal. Compared
  // as a set of trimmed lines: the two files are forks of one document, so ordering and
  // whitespace churn are noise and only genuinely absent content is interesting.
  const live = new Set(liveText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const out = [];
  for (const raw of shadowText.split(/\r?\n/)) {
    const l = raw.trim();
    if (l && !live.has(l)) out.push(l);
  }
  return out;
}

// The shadow files reviewed by hand on 2026-08-27 and confirmed stale. Keyed by name, valued
// by the sha256 of the file's unique-line set, so any NEW content in one of these re-arms it.
// Add an entry only after actually reading the unique lines and confirming nothing is owed.
const REVIEWED = new Map([
  ['task-328-shiv-devbox.md',
    { on: '2026-08-27',
      hash: 'f17214356a803ef9af5b6b3f8e2a97c5738a4bae8ac4b910b97abfafb50dbc32',
      why: 'plan for the Aug 10-11 wedding, now past; #328 closed by Shiv 2026-08-25' }],
  ['task-249-DESKTOP-P9116M3.md',
    { on: '2026-08-27',
      hash: '600e9b4c4e669e6a2c49f9544a039118c60dc0ae7bc8fea54523678857188931',
      why: 'June 14 plan that was approved and executed on June 15; superseded' }],
  ['task-292-DESKTOP-P9116M3.md',
    { on: '2026-08-27',
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      why: 'no unique content -- the live journal is a strict superset' }],
  ['task-451.truncated-bak-20260830.md',
    { on: '2026-08-30',
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      why: 'forensic copy of the 2026-08-30 external truncation of #451; the repaired live journal is a strict superset (0 unique lines)' }],
]);

function uniqueHash(unique) {
  return createHash('sha256').update((unique ?? []).join('\n'), 'utf8').digest('hex');
}

function classify(name, content) {
  const reasons = [];
  if (!REAL_JOURNAL.test(name) && content.includes(SENTINEL)) {
    reasons.push('carries the managed sentinel but is not named task-<id>.md');
  }
  if (CONFLICT.test(name)) {
    reasons.push('OneDrive sync-conflict copy');
  }
  return reasons;
}

// ---------------------------------------------------------------------------------------
// Behavioural fixtures. Asserts BOTH directions: it must fire on the real shapes found live
// and stay silent on the shapes that fill this folder legitimately. The silent half is the
// load-bearing one -- the folder holds ~130 deliverables and a growing pile of backups, and a
// detector that flags those is worse than no detector.
// ---------------------------------------------------------------------------------------
const BODY_WITH_SENTINEL = `# Task 9xx: synthetic\n\n---\n<!-- ${SENTINEL} this line; the agent manages everything below it -->\n\n## Overnight Agent\n\nbody\n`;
const BODY_PLAIN = `# Task 9xx: synthetic deliverable\n\nSome research output.\n`;

const FIXTURES = [
  ['task-328-shiv-devbox.md', BODY_WITH_SENTINEL, true,
    'the real find: a forked journal misnamed as a deliverable'],
  ['task-249-DESKTOP-P9116M3.md', BODY_WITH_SENTINEL, true,
    'a conflict copy that also carries the sentinel'],
  ['task-292-DESKTOP-P9116M3.md', BODY_PLAIN, true,
    'a pre-sentinel conflict copy: caught by the name arm alone'],

  ['task-328.md', BODY_WITH_SENTINEL, false,
    'GUARD: a real journal is read by everything and must never be flagged'],
  ['task-422-irrigation-rebuild.md', BODY_PLAIN, false,
    'GUARD: an ordinary deliverable is not a journal'],
  ['task-328-shiv-devbox.md'.replace('.md', '.bak-20260827-0440.md'), BODY_WITH_SENTINEL, false,
    'GUARD: a write-turn backup is a backup of a file that IS read'],
  ['task-257.bak-20260827-0440.md', BODY_WITH_SENTINEL, false,
    'GUARD: the backup naming write-turn.ps1 actually produces'],
];

function runFixtures() {
  const failures = [];
  for (const [name, body, expected, why] of FIXTURES) {
    const actual = !BACKUP.test(name) && classify(name, body).length > 0;
    if (actual !== expected) failures.push({ name, expected, actual, why });
  }
  // The baseline must silence a VERDICT, not a filename. Assert both directions directly,
  // because "it went quiet" is indistinguishable from "it went blind" without this.
  const anyName = [...REVIEWED.keys()][0];
  if (anyName) {
    const base = REVIEWED.get(anyName);
    if (uniqueHash(base.sample ?? null) === base.hash && base.hash !== uniqueHash(null)) {
      failures.push({ name: anyName, expected: 'hash derived from real content', actual: 'empty',
        why: 'BASELINE: a baselined hash must come from the file, not from nothing' });
    }
    // Same file, one extra line of unique content => different hash => re-armed.
    if (uniqueHash(['a new line Shiv just typed']) === base.hash) {
      failures.push({ name: anyName, expected: 'changed content re-arms', actual: 'still silenced',
        why: 'BASELINE: new content in a baselined file must become a finding again' });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------------------
const fixtureFailures = runFixtures();

const files = readdirSync(jdir).filter((f) => f.endsWith('.md') && !BACKUP.test(f));
const hits = [];

for (const name of files) {
  const full = join(jdir, name);
  if (!statSync(full).isFile()) continue;
  const content = readFileSync(full, 'utf8');
  const reasons = classify(name, content);
  if (reasons.length === 0) continue;

  const owner = name.match(OWNER)?.[1] ?? null;
  const livePath = owner ? join(jdir, `task-${owner}.md`) : null;
  let liveExists = false;
  let unique = null;
  if (livePath && files.includes(`task-${owner}.md`)) {
    liveExists = true;
    unique = uniqueLines(content, readFileSync(livePath, 'utf8'));
  }
  hits.push({ name, reasons, owner, liveExists, unique });
}

// Split what was reviewed and confirmed stale from what is genuinely new. A baselined file
// re-arms the moment its unique content changes, so this silences a verdict, not a filename.
const findings = [];
const reviewed = [];
for (const h of hits) {
  const base = REVIEWED.get(h.name);
  if (base && base.hash === uniqueHash(h.unique)) reviewed.push({ ...h, base });
  else findings.push(h);
}

console.log(`journal folder: ${files.length} .md files (backups excluded)`);
console.log(`fixtures: ${FIXTURES.length - fixtureFailures.length}/${FIXTURES.length} correct`);

if (fixtureFailures.length) {
  console.log('\nFINDINGS: the detector itself is wrong -- live results below are untrustworthy');
  for (const f of fixtureFailures) {
    console.log(`  ${f.name}: expected flagged=${f.expected}, got ${f.actual} -- ${f.why}`);
  }
}

if (reviewed.length) {
  console.log(
    `\nknown, reviewed and confirmed stale: ${reviewed.length} ` +
    '(reported apart from findings; each re-arms if its content changes)',
  );
  for (const r of reviewed) {
    console.log(`  ${r.name} -- ${r.base.why} [reviewed ${r.base.on}]`);
  }
}

if (findings.length === 0) {
  console.log('\nno NEW journal-shaped file is hidden from the readers.');
  process.exit(fixtureFailures.length ? 1 : 0);
}

// Files holding content that exists nowhere else come first -- that is the only arm of this
// that can actually lose something.
findings.sort((a, b) => (b.unique?.length ?? 0) - (a.unique?.length ?? 0));

console.log(`\nFINDINGS: ${findings.length} file(s) no reader will ever open`);
for (const h of findings) {
  const base = REVIEWED.get(h.name);
  console.log(`\n  ${h.name}`);
  console.log(`    why           : ${h.reasons.join('; ')}`);
  if (base) {
    console.log(`    ⚠ re-armed    : reviewed ${base.on}, but its unique content has CHANGED since`);
  }
  console.log(`    belongs to    : ${h.owner ? `#${h.owner}` : '(unknown)'}` +
    `${h.owner ? (h.liveExists ? ' (live journal exists)' : ' (NO live journal!)') : ''}`);
  if (h.unique === null) {
    console.log('    unique content: cannot compare -- no live journal to diff against');
  } else if (h.unique.length === 0) {
    console.log('    unique content: none -- the live journal is a superset, this is stale history');
  } else {
    console.log(`    unique content: ${h.unique.length} line(s) exist ONLY here:`);
    for (const l of h.unique.slice(0, 6)) {
      console.log(`      > ${l.length > 140 ? `${l.slice(0, 140)}...` : l}`);
    }
    if (h.unique.length > 6) console.log(`      ... and ${h.unique.length - 6} more`);
  }
  console.log(`    baseline hash : ${uniqueHash(h.unique)}`);
}
console.log(
  '\nA file with 0 unique lines is safe to leave; one with unique lines is holding content ' +
  'that exists nowhere a reader will find it. Deleting files is Shiv\'s call, not the agent\'s.\n' +
  'Once reviewed and confirmed stale, add it to REVIEWED with the baseline hash printed above.',
);
process.exit(1);
