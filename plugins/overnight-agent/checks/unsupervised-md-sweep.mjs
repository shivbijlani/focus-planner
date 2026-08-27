// unsupervised-md-sweep.mjs — run the write-path checks over agent-written markdown
// that lives OUTSIDE `<planner>\journal`.
//
// Established 2026-08-26 08:35 PT. It closes a gap that the 08:00 run measured,
// documented and left open:
//
//     "Rule: agent-written markdown outside the journal folder gets no nightly
//      check at all. When a deliverable lands in a project folder, it is
//      unsupervised."
//
// `lost-interpolation-sweep` reads exactly one directory — `<planner>\journal` —
// non-recursively. Everything the agent writes into a PROJECT folder (career docs,
// analyses, planner-level files) has therefore never been checked by anything. The
// 08:00 run proved that matters by re-running the matcher BY HAND over ~835 files
// and finding two real victims, one of which was `user-settings.md` itself.
//
// A hand re-run that nobody scheduled is not a check. This sweep is the schedule.
//
// TWO ARMS, DELIBERATELY SHARING THE PRODUCERS' CODE
// -----------------------------------------------------------------------------
//   1. `scanText` from `lib-lost-interpolation.mjs` — the eaten-`$`/backtick-escape
//      matcher, byte-identical to the journal sweep. Not re-implemented: a checker
//      must drive the producer's own semantics or it invents bugs (cf. #267).
//   2. `findUndecodedJson` from `lib-unsupervised.mjs` — the raw-JSON-blob defect,
//      which the journal sweep has no arm for at all.
//
// SCOPE: `.md` ONLY — MEASURED, NOT ASSUMED
// -----------------------------------------------------------------------------
// The first cut scanned `.md` AND `.html`, matching the 08:00 hand-run's "835
// .md/.html files". Measured against the live corpus that was 494 files and
// **4 flagged, all four false positives**:
//   Archives\iming\Shiv.html + Shiv1.html — legacy IM transcripts saved as HTML.
//     Old Windows-authored HTML genuinely contains bare CRs between `<br>` tags,
//     which is precisely the signature arm 1 treats as zero-false-positive. That
//     assumption ("no legitimate writer emits a bare CR mid-file") holds for
//     agent-written markdown and is FALSE for browser-saved HTML.
//   MS - ivew.htm, e-Ticket Receipt.htm — embedded JavaScript, where `":\/\/"`
//     and `/\/library\/...\.gif/` are ordinary JS escapes, not eaten values.
// Restricting to `.md`: 407 files considered, **0 flagged, 0 false positives**,
// and BOTH known true positives are retained (the 116 KB JSON blob and
// `user-settings.md` are both `.md`).
//
// Applying a markdown-ESCAPE matcher to HTML+JavaScript is a category error, so
// the fix is scope, not a new guard. ⚠️ ACCEPTED, DOCUMENTED GAP: agent-written
// **HTML** deliverables (e.g. the markdown->HTML conversion on the Send-to-Kindle
// path) are therefore still unchecked. That is the same call the interpolation lib
// made about code spans — a documented blind spot beats a detector that is 100%
// noise. Revisit only with a discriminator that separates agent-written HTML from
// browser-saved HTML; file age does not work (every archived file above reports
// created=2026-04-27, the OneDrive bulk-sync date, not its authorship date).
//
// THE KNOWN, PERMANENT FALSE POSITIVE
// -----------------------------------------------------------------------------
// `user-settings.md` documents this defect class by QUOTING damaged text, so it
// trips arm 1 forever (user-settings.md, 2026-08-26: "Do not 'fix' those
// quotations; they are the evidence"). Suppressing the file would hide a genuine
// new corruption in it — which is exactly what happened on 2026-08-26 — so it is
// reported in its own bucket instead, with a count, and excluded only from the
// EXIT CODE. Growth in that count is still visible to the reader.

import fs from 'node:fs';
import path from 'node:path';
import { scanText } from './lib-lost-interpolation.mjs';
import { findUndecodedJson, unsupervisedRoots } from './lib-unsupervised.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal').toLowerCase();
const JSON_OUT = process.argv.includes('--json');

// Directories that are never agent-written prose.
const SKIP_DIR = new Set(['node_modules', '.git', '.vs', 'dist', 'build', '__pycache__']);
// Trips arm 1 by design — it documents the defect using damaged samples.
const KNOWN_QUOTER = 'user-settings.md';

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir must not abort the sweep
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name.toLowerCase())) continue;
      // The journal folder belongs to `lost-interpolation-sweep`.
      if (full.toLowerCase() === JOURNAL) continue;
      walk(full, out);
    } else if (/\.md$/i.test(e.name)) {
      out.push(full);
    }
  }
}

const files = [];
for (const root of unsupervisedRoots()) {
  if (fs.existsSync(root)) walk(root, files);
}

const findings = [];
const knownQuoter = [];

for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const hits = [...scanText(text), ...findUndecodedJson(text)];
  if (!hits.length) continue;
  hits.sort((a, b) => a.n - b.n);
  const rec = { file: f, hits };
  if (path.basename(f).toLowerCase() === KNOWN_QUOTER) knownQuoter.push(rec);
  else findings.push(rec);
}

findings.sort((a, b) => {
  const as = a.hits.filter((h) => h.strong).length;
  const bs = b.hits.filter((h) => h.strong).length;
  return bs - as || b.hits.length - a.hits.length;
});

const jsonBlobs = findings.filter((r) => r.hits.some((h) => h.kind === 'undecoded-json'));

if (JSON_OUT) {
  console.log(JSON.stringify({ considered: files.length, flagged: findings.length, jsonBlobs: jsonBlobs.length, findings, knownQuoter }, null, 2));
} else {
  console.log(`considered (.md outside <planner>\\journal): ${files.length}`);
  console.log(`FLAGGED: ${findings.length} files  (undecoded-JSON blobs: ${jsonBlobs.length})\n`);
  for (const r of findings) {
    const strong = r.hits.filter((h) => h.strong).length;
    console.log(`${r.file}  (${r.hits.length} line${r.hits.length === 1 ? '' : 's'}${strong ? `, ${strong} strong` : ''})`);
    for (const h of r.hits.slice(0, 6)) {
      console.log(`  ${h.strong ? '!!' : '  '} ${String(h.n).padStart(5)}: [${h.kind}] ${h.line.slice(0, 140)}`);
    }
    if (r.hits.length > 6) console.log(`     ...and ${r.hits.length - 6} more`);
    console.log('');
  }
  const kqLines = knownQuoter.reduce((n, r) => n + r.hits.length, 0);
  console.log(`known permanent FP (documents the defect by quoting it): ${knownQuoter.length} file, ${kqLines} lines - excluded from exit code`);
}

// Exit code is driven ONLY by genuine findings; the self-documenting file must not
// make this sweep read FINDINGS every night forever (that is how board-integrity's
// signal got tuned out).
process.exit(findings.length ? 1 : 0);
