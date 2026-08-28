// journal-encoding-invariant.mjs
//
// GUARDS: marking a task must never re-encode its journal.
//
// WHY THIS EXISTS (and why the existing checks structurally cannot cover it):
//
// These journals are UTF-8 with no BOM. `powershell` (5.1) -- what every documented
// command resolves to -- decodes a no-BOM file as the ANSI codepage (cp1252 on this
// box), while `pwsh` (7) decodes it as UTF-8. Measured 2026-08-27:
//
//     read ANSI -> write ANSI       moon intact = TRUE    (lossless: cp1252 is a
//                                                          byte-bijection, so a
//                                                          symmetric round-trip is safe)
//     read ANSI -> write UTF-8      moon intact = FALSE   <-- DESTRUCTIVE
//     read ANSI -> WriteAllText8    moon intact = FALSE   <-- DESTRUCTIVE
//
// So the defect is NOT "reads with Get-Content -Raw" on its own, and it is NOT
// "differs from origin/main". It is specifically the ASYMMETRIC PAIR: an ANSI read
// combined with a UTF-8 write, in the same read-modify-write. That is what cost 593
// lines of task-448.md on 2026-08-27.
//
// Neither existing check sees this:
//   * installed-skill-drift-sweep compares the installed file to a git ref. Measured
//     2026-08-27: origin/main has NO journal write path at all (its only write targets
//     the state JSON), so reverting to main is the SAFE direction -- it degrades hash
//     stability, not data. Drift is therefore a poor proxy: it fires on a safe state
//     and would stay silent on a dangerous one.
//   * lost-interpolation / doubled-apostrophe sweeps read the journals AFTER the fact.
//     They are forensics, not prevention, and by then the bytes are already gone.
//
// The dangerous state is a journal WRITE path present WITHOUT the UTF-8 decoder --
// exactly what a partial hand-copy into installed-plugins produces, since that
// directory is written by hand. Nothing asserts that invariant today.
//
// This sweep is BEHAVIOURAL first: it runs the *installed* oa-state.ps1 against an
// isolated synthetic journal (own -JournalDir/-StateDir; live state untouched) and
// asserts the bytes survive. It cannot be fooled by the source merely mentioning a fix.
//
// exit 1 = findings.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT =
  process.env.OA_STATE_PS1 ||
  'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent\\oa-state.ps1';

const findings = [];
const notes = [];

// Characters that actually appear in these journals and that cp1252 round-tripping destroys.
const MOON = '\u{1F319}';   // the agent-block heading glyph
const TARGET = '\u{1F3AF}'; // the board urgency glyph
const EMDASH = '\u2014';
const LSQUO = '\u2018';
const RSQUO = '\u2019';
const LDQUO = '\u201C';
const RDQUO = '\u201D';

const MARKERS = [MOON, TARGET, EMDASH, LSQUO, RSQUO, LDQUO, RDQUO];

// The double-encoding fingerprints named in user-settings.md HAZARD 4.
const FP_EMOJI = Buffer.from([0xc3, 0xb0, 0xc5, 0xb8]);
const FP_PUNCT = Buffer.from([0xc3, 0xa2]);

function journalFixture(id) {
  return [
    `# Task ${id}: encoding invariant fixture`,
    '',
    `Shiv's own note ${EMDASH} with ${LDQUO}curly quotes${RDQUO} and an ${LSQUO}apostrophe${RSQUO}.`,
    '',
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '',
    `## ${MOON} Overnight Agent`,
    '',
    `**Status:** In-progress ${EMDASH} plan v1 ${EMDASH} 2026-08-27`,
    '',
    `A ${TARGET} urgency glyph and an em-dash ${EMDASH} in the body.`,
    '',
  ].join('\n');
}

function runPs(args) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

const tmp = mkdtempSync(join(tmpdir(), 'oa-enc-'));
const jdir = join(tmp, 'journal');
const sdir = join(tmp, 'state');
mkdirSync(jdir);
mkdirSync(sdir);

const ID = '999001';
const jpath = join(jdir, `task-${ID}.md`);

try {
  // --- ARM 1 (behavioural): does `mark` preserve the journal's bytes? ---
  const original = journalFixture(ID);
  writeFileSync(jpath, Buffer.from(original, 'utf8')); // UTF-8, no BOM, like the real ones
  const before = readFileSync(jpath);

  runPs(['seed', '-Force', '-JournalDir', jdir, '-StateDir', sdir]);
  runPs(['mark', '-Id', ID, '-Status', 'done', '-JournalDir', jdir, '-StateDir', sdir]);

  const after = readFileSync(jpath);
  const decoded = after.toString('utf8');

  const lost = MARKERS.filter((c) => original.includes(c) && !decoded.includes(c));
  if (lost.length) {
    findings.push(
      `mark() re-encoded the journal: ${lost.length} character class(es) destroyed ` +
        `(${lost.map((c) => JSON.stringify(c)).join(', ')}). This is the ANSI-read/UTF8-write pair.`
    );
  }
  if (after.includes(FP_EMOJI)) {
    findings.push('mark() left the double-encoded EMOJI fingerprint (C3 B0 C5 B8) in the journal.');
  }
  if (after.includes(FP_PUNCT) && !before.includes(FP_PUNCT)) {
    findings.push('mark() introduced the double-encoded PUNCTUATION fingerprint (C3 A2) in the journal.');
  }

  // Appending the turn-end marker is legitimate; touching anything ABOVE it is not.
  // So assert byte-exact prefix equality rather than a size threshold: a re-encode
  // rewrites characters in place, which breaks the prefix immediately and precisely.
  const keptPrefix = Buffer.from(original.replace(/\s+$/, ''), 'utf8');
  if (!after.subarray(0, keptPrefix.length).equals(keptPrefix)) {
    findings.push(
      'mark() altered bytes ABOVE the turn-end marker. The pre-existing journal content must be ' +
        'preserved byte-for-byte; only the terminator may be appended.'
    );
  } else {
    const appended = after.subarray(keptPrefix.length).toString('utf8');
    const legit = /^\r?\n\r?\n<!-- \/overnight-agent turn-end -->\r?\n?$/.test(appended);
    if (!legit && appended.length > 0) {
      findings.push(
        `mark() appended unexpected trailing bytes: ${JSON.stringify(appended)}. Only the ` +
          `turn-end marker is allowed.`
      );
    } else {
      notes.push(`prefix preserved byte-for-byte; appended ${appended.length} byte(s) of terminator`);
    }
  }

  // --- ARM 2 (behavioural): is the hash stable, or does it self-reopen? ---
  const scanOut = runPs(['scan', '-JournalDir', jdir, '-StateDir', sdir]);
  let row = null;
  try {
    const parsed = JSON.parse(scanOut);
    row = (Array.isArray(parsed) ? parsed : [parsed]).find((r) => String(r.id) === ID);
  } catch {
    findings.push('scan did not emit parseable JSON for the isolated fixture.');
  }
  if (row && row.reopened === true) {
    findings.push(
      'scan reports reopened=true immediately after mark() on an untouched journal. The hash is ' +
        'host-dependent, so every run will re-answer settled tasks.'
    );
  } else if (row) {
    notes.push('hash stable across mark -> scan (no self-reopen)');
  }

  // --- ARM 3 (textual): the dangerous partial-copy shape ---
  const src = readFileSync(SCRIPT, 'utf8');
  const writesJournals = /WriteAllText\(\s*\$path/.test(src) || /Set-Content[^\r\n]*\$path/.test(src);
  const ansiReads = (src.match(/Get-Content\s+-Raw\s+-Path\s+\$path/g) || []).length;
  const hasUtf8Decoder = /function\s+Read-JournalText/.test(src);

  if (writesJournals && ansiReads > 0) {
    findings.push(
      `oa-state.ps1 has a journal WRITE path and ${ansiReads} bare \`Get-Content -Raw -Path $path\` ` +
        `read(s). That is the destructive asymmetric pair.`
    );
  }
  if (writesJournals && !hasUtf8Decoder) {
    findings.push(
      'oa-state.ps1 writes journals but has no Read-JournalText UTF-8 decoder. A partial hand-copy ' +
        'into installed-plugins produces exactly this shape.'
    );
  }
  if (!writesJournals) {
    notes.push('no journal write path present (read-only build: safe direction)');
  }

  console.log(`script      : ${SCRIPT}`);
  console.log(`write path  : ${writesJournals}`);
  console.log(`utf8 decoder: ${hasUtf8Decoder}`);
  console.log(`ansi reads  : ${ansiReads}`);
  for (const n of notes) console.log(`  ok: ${n}`);

  if (findings.length) {
    console.log(`\nFINDINGS: ${findings.length}`);
    for (const f of findings) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nno findings: marking a task preserves its journal byte-for-byte.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
