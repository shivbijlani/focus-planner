// installed-capability-sweep.mjs
//
// GUARDS: the installed plugin must retain named BEHAVIOURAL CAPABILITIES, independently of
// which git ref its bytes happen to match.
//
// WHY THIS EXISTS (measured 2026-08-28 01:30 PT)
// ---------------------------------------------
// installed-skill-drift-sweep.mjs already asks "are the installed bytes a version we can name?"
// and its own header says it exists to catch, among others:
//
//     "2. BACKWARD: a plugin reinstall/update would overwrite the hand-deployed file with main's
//      copy and silently REVERT both reopen fixes, with no detector to notice."
//
// That is exactly what happened tonight -- and the sweep reported "no drift".
//
// The plugin was reinstalled at 2026-08-27 21:06 (focus-planner/overnight-agent v1.3.1). That
// overwrote the hand-deployed oa-state.ps1 with origin/main's copy, which has NO UTF-8 decoder
// and NO `resnapshot`, because the fix lives in the still-OPEN PR #198. Measured harm on the
// next scan: 207 of 239 journals flipped to `changed`, and `reopened` read **0 while 16 tasks
// had trailing user content** -- i.e. the agent was structurally blind to user replies.
//
// installed-skill-drift-sweep could not see it, and the reason is not a bug in it. Its health
// criterion is "installed == origin/main" -> verdict MAIN -> "Fine". When the required fix is
// NOT YET ON MAIN, reverting *to* main is a regression that scores as perfect health. The
// detector answered a different question ("is this file a named version?") and the answer
// looked fine -- the exact defect class user-settings.md keeps recording.
//
// So the two sweeps are complementary and must both exist:
//   installed-skill-drift-sweep : provenance -- can we NAME the bytes we are running?
//   installed-capability-sweep  : capability -- can the bytes we are running DO the job?
// Provenance can be perfect while capability is broken. Tonight it was.
//
// GUARDS (each must be load-bearing; see mutcheck-installed-capability.mjs)
//   g1 ref-independence: this sweep MUST NOT consult git. Consulting git is what makes the
//      drift sweep blind here -- "matches a ref" would re-admit the reverted file. The check
//      reads the installed bytes and nothing else. Mutating this to accept "matches main"
//      must resurrect tonight's regression.
//   g2 missing-target-is-a-FINDING, never a skip: if a capability's file is absent, that is the
//      strongest possible failure (the capability cannot be present), so it must be reported,
//      not skipped. A skip-on-missing turns the roster blind to itself -- the same failure as
//      the `mutcheck-*.mjs` glob (2026-08-27 13:45) and the unset BRIDGE_SRC (2026-08-25 22:45),
//      both of which reported clean while checking nothing.
//   g3 non-empty manifest: an empty/filtered-to-nothing manifest must FAIL. Otherwise the sweep
//      degrades silently to asserting nothing while still exiting 0 -- the decay mode that
//      produced both incidents named in g2. Assert the COUNT, not just the cleanliness.
//
// Each capability records the incident it guards, so a future run can tell why it is here and
// must not "tidy" it away.
//
// exit 1 = findings.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const INSTALLED =
  process.env.OA_INSTALLED_PLUGIN ||
  join(homedir(), '.copilot', 'installed-plugins', 'focus-planner');

const SKILL = join(INSTALLED, 'overnight-agent', 'skills', 'overnight-agent');

// --- the capability manifest ---------------------------------------------------------------
// Every entry was satisfied by the installed tree at the moment it was added, so this sweep is
// green when healthy and goes red only on a genuine regression.
const MANIFEST = [
  {
    id: 'oa-state/utf8-decoder',
    file: join(SKILL, 'oa-state.ps1'),
    mustMatch: [/UTF8Encoding/],
    why:
      'journals are UTF-8 without BOM; without an explicit decoder the journal hash becomes ' +
      'host-dependent, so `changed`/`reopened` stop meaning anything',
    incident: '2026-08-28 reinstall: 207/239 journals flipped changed, reopened read 0 while 16 had user content',
  },
  {
    id: 'oa-state/resnapshot',
    file: join(SKILL, 'oa-state.ps1'),
    mustMatch: [/resnapshot/],
    why:
      'the documented recovery path after any change to how journals are decoded or hashed; ' +
      'without it a decoder change leaves every task permanently `changed` with no way back',
    incident: '2026-08-28 reinstall removed it together with the decoder, so the revert had no remedy',
  },
  {
    id: 'oa-state/no-bare-raw-journal-read',
    file: join(SKILL, 'oa-state.ps1'),
    // A plain /Get-Content .*-Raw/ is NOT usable here and the first cut of this sweep proved it:
    // it fired on the healthy build, because three of the four hits are COMMENTS warning against
    // the very thing, and the fourth is Read-State reading the agent's own state JSON. A detector
    // that is red on a healthy tree can never reach zero, which is the decay mode user-settings.md
    // warns about -- so the rule is scoped to what actually matters.
    //
    // The invariant: a MARKDOWN read must never go through the host-dependent decoder. State files
    // are JSON and are machine-written ASCII, so `| ConvertFrom-Json` is a sound discriminator --
    // a journal is never parsed as JSON.
    assert: (text) => {
      const offenders = text
        .split(/\r?\n/)
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !line.trim().startsWith('#')) // drop comment lines
        .filter(({ line }) => /Get-Content\s+[^\r\n]*-Raw|-Raw\s+[^\r\n]*Get-Content/.test(line))
        .filter(({ line }) => !/ConvertFrom-Json/.test(line)); // state JSON is fine
      return offenders.length
        ? `non-comment markdown read via Get-Content -Raw at line(s) ${offenders.map((o) => o.n).join(', ')}`
        : null;
    },
    why:
      'HAZARD 4: a bare `Get-Content -Raw` decodes by the host codepage; a read-modify-write ' +
      'then makes the mojibake permanent, silently, exit code 0',
    incident: '2026-08-27: destroyed 593 lines of task-448.md',
  },
  {
    id: 'oa-state/journal-reader-is-explicit',
    file: join(SKILL, 'oa-state.ps1'),
    // The positive half of the rule above: it is not enough to avoid the bad call, the dedicated
    // reader must exist and must pin the encoding. Without this, deleting Read-JournalText
    // entirely would satisfy the "no bare raw read" rule vacuously.
    mustMatch: [/function\s+Read-JournalText/i, /ReadAllText/],
    why:
      'the journal read path must be a single, explicitly-UTF-8 function; a vacuous pass is ' +
      'possible if the reader is simply deleted',
    incident: '2026-08-28 reinstall: the reader was absent entirely and every hash became host-dependent',
  },
  {
    id: 'skill/reaper-present',
    file: join(SKILL, 'reap-stale-mcp.ps1'),
    mustMatch: [/./],
    why:
      'stale MCP servers accumulate until the NEXT run\'s servers die on startup, which silently ' +
      'empties the PHASE 0 inbox check',
    incident: '2026-08-26 19:10: PR #151 was merged but never deployed -- every line inert',
  },
  {
    id: 'skill/reaper-wired',
    file: join(SKILL, 'SKILL.md'),
    mustMatch: [/reap-stale-mcp/],
    why:
      'the reaper existing is not the same as SKILL.md invoking it; when the wiring is absent the ' +
      'behaviour survives only via a redundant prose row in user-settings.md',
    incident: '2026-08-26 19:10: installed SKILL.md contained ZERO occurrences of "reap-stale-mcp"',
  },
];

// g3: a manifest that has been emptied or filtered to nothing must fail loudly.
if (!Array.isArray(MANIFEST) || MANIFEST.length === 0) {
  console.log('FINDINGS: capability manifest is empty -- this sweep would certify anything.');
  process.exit(1);
}

const findings = [];
const rows = [];

for (const cap of MANIFEST) {
  // g2: absent target is the strongest failure, never a skip.
  if (!existsSync(cap.file)) {
    const row = { id: cap.id, verdict: 'MISSING-FILE', detail: cap.file };
    rows.push(row);
    findings.push({ ...cap, ...row });
    continue;
  }

  // g1: read the installed bytes. No git, ever.
  const text = readFileSync(cap.file, 'utf8');

  const missing = (cap.mustMatch ?? []).filter((re) => !re.test(text));
  const forbidden = (cap.mustNotMatch ?? []).filter((re) => re.test(text));
  const asserted = cap.assert ? cap.assert(text) : null;

  if (missing.length || forbidden.length || asserted) {
    const detail = [
      ...missing.map((re) => `absent: ${re}`),
      ...forbidden.map((re) => `present but forbidden: ${re}`),
      ...(asserted ? [asserted] : []),
    ].join('; ');
    const row = { id: cap.id, verdict: 'LOST', detail };
    rows.push(row);
    findings.push({ ...cap, ...row });
  } else {
    rows.push({ id: cap.id, verdict: 'OK', detail: '' });
  }
}

// --json exists so capability-floor.ps1 can DERIVE the guarded file list instead of keeping a
// second copy of it. A restore tool with its own hand-maintained list would drift from the
// manifest the moment a capability is added here -- and it would drift silently, restoring an
// out-of-date set while reporting success. Same reason deploy-installed-plugin.ps1 delegates
// classification to the drift sweep rather than reimplementing it.
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        installed: INSTALLED,
        count: MANIFEST.length,
        findings: findings.length,
        capabilities: rows.map((r) => {
          const cap = MANIFEST.find((c) => c.id === r.id);
          return { id: r.id, file: cap.file, verdict: r.verdict, detail: r.detail };
        }),
      },
      null,
      2,
    ),
  );
  process.exit(findings.length ? 1 : 0);
}

console.log(`installed plugin: ${INSTALLED}`);
console.log(`capabilities asserted: ${MANIFEST.length}   (ref-independent: git is never consulted)`);
console.log('');
for (const r of rows) {
  console.log(`  ${r.verdict.padEnd(12)} ${r.id}${r.detail ? `    [${r.detail}]` : ''}`);
}

if (!findings.length) {
  console.log('\nno findings: the running agent retains every required capability.');
  process.exit(0);
}

console.log(`\nFINDINGS: ${findings.length} capability(ies) lost by the running agent`);
for (const f of findings) {
  console.log(`\n  ${f.id}`);
  console.log(`    file:     ${f.file}`);
  console.log(`    why:      ${f.why}`);
  console.log(`    incident: ${f.incident}`);
  console.log(
    '    note:     a matching git ref does NOT clear this. If the fix is not on main, ' +
      'reverting to main loses the capability while drift-sweep still reports MAIN/"fine".',
  );
}
process.exit(1);
