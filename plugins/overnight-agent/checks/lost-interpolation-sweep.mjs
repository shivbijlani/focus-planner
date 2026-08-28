// lost-interpolation-sweep.mjs — find journal/deliverable text where a value was
// SILENTLY DELETED by shell interpolation before it was ever written to disk.
//
// Established 2026-08-26 08:00 PT. The matcher lives in `lib-lost-interpolation.mjs`
// so this sweep and `mutcheck-lost-interpolation.mjs` drive the SAME code.
//
// WHY THIS BUCKET IS DIFFERENT FROM EVERY OTHER SWEEP
// -----------------------------------------------------------------------------
// Every other detector in this suite asks "is the agent's REASONING wrong?" — a
// stale ask, a gated reversible plan, a status that drifted. This one asks whether
// the text on disk is what the agent actually wrote. It is the only check on the
// WRITE PATH, and the only defect class where the journal reads as complete,
// confident, well-formatted prose that is missing the one thing it exists to say.
//
// A run that writes markdown through a PowerShell double-quoted string has every
// `$token` expanded. `$150` is not a defined variable, so PowerShell expands it to
// the empty string and the write succeeds. No error, no warning.
//
//   intended  "Would you take **\$95 shipped**?"  ->  on disk  "Would you take **\ shipped**?"
//
// Shiv was asked to approve sending that message. The price was gone.
//
// Live blast radius when this sweep was written (see the run learnings):
//   #247  RKLB investment research — price, market cap, 52-week range, analyst
//         targets and the revenue ramp all reduced to `~\`.
//   #320  lodging comparison — every nightly and total rate in the table.
//   #234  eight YNAB transaction amounts (the cents survived: `\.92`).
//   #377  FB Marketplace shortlist — all five listing prices AND the offer price.
//   #297 #335 #249 #412 #213 — rental quotes, comp bands, savings, materials.
//
// Run it EVERY RUN. The damage is unrecoverable once the source context is gone,
// so the value is in catching it the same night it is written.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { scanText } from './lib-lost-interpolation.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const JSON_OUT = process.argv.includes('--json');
const UPDATE = process.argv.includes('--update-baseline');
const BASELINE =
  process.env.LI_BASELINE || path.join(HERE, 'lost-interpolation-baseline.json');

// WHY A BASELINE — and why it is CONTENT-ADDRESSED
// -----------------------------------------------------------------------------
// This defect deletes the value before it ever reaches disk, so for most of the
// backlog there is nothing left to recover: the number exists only in the intent
// of a run that finished weeks ago. Those lines therefore flag on EVERY run,
// forever. That is corrosive, because this sweep's whole stated value is
// "catch it the same night it is written" — and a genuinely new corruption
// appearing as item 9 in a list of 8 familiar ones is a finding nobody reads.
// It already started: the 08:00 and 09:35 runs both recorded "12 flagged, none
// written this run" and moved on, reasoning it out by hand each time.
//
// So known-unrecoverable occurrences are acknowledged here and reported apart
// from findings. The key is a hash of file + EXACT line text + kind, never the
// filename, so the baseline can only ever silence the precise damaged line it
// was minted for. A new corruption elsewhere in an already-listed file, or a
// CHANGE to a baselined line, produces a different key and fires normally.
// Verified by mutcheck-li-baseline.mjs.

const keyOf = (file, hit) =>
  crypto.createHash('sha1').update(`${file}|${hit.kind}|${hit.line.trim()}`).digest('hex').slice(0, 16);

let baseline = { note: '', entries: {} };
if (fs.existsSync(BASELINE)) {
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch {
    console.error(`baseline at ${BASELINE} is unreadable - treating every hit as NEW`);
  }
}
const known = baseline.entries || {};

let considered = 0;
const report = [];

for (const f of fs.readdirSync(JOURNAL)) {
  if (!f.endsWith('.md')) continue;
  considered++;
  const hits = scanText(fs.readFileSync(path.join(JOURNAL, f), 'utf8'));
  if (hits.length) report.push({ file: f, hits });
}

// Split every hit into NEW (actionable) vs acknowledged.
const seen = new Set();
for (const r of report) {
  for (const h of r.hits) {
    h.key = keyOf(r.file, h);
    h.known = Object.prototype.hasOwnProperty.call(known, h.key);
    seen.add(h.key);
  }
  r.newHits = r.hits.filter((h) => !h.known);
}
const fresh = report.filter((r) => r.newHits.length);
// A baseline entry whose line no longer exists: the damage was repaired, or the
// text moved. Surface it so the file self-cleans instead of rotting.
const stale = Object.keys(known).filter((k) => !seen.has(k));

if (UPDATE) {
  const entries = {};
  for (const r of report) {
    for (const h of r.hits) {
      entries[h.key] = { file: r.file, line: h.n, kind: h.kind, text: h.line.trim().slice(0, 200) };
    }
  }
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note:
          'Known lost-interpolation damage whose values are UNRECOVERABLE (deleted before reaching disk). ' +
          'Keyed by sha1(file|kind|exact line text) so it can only silence the precise line it was minted for. ' +
          'Regenerate with: node lost-interpolation-sweep.mjs --update-baseline',
        generated: new Date().toISOString(),
        entries,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`baseline written: ${Object.keys(entries).length} acknowledged occurrence(s) -> ${BASELINE}`);
  process.exit(0);
}

report.sort((a, b) => {
  const as = a.hits.filter((h) => h.strong).length;
  const bs = b.hits.filter((h) => h.strong).length;
  return bs - as || b.hits.length - a.hits.length;
});

const strongFiles = report.filter((r) => r.hits.some((h) => h.strong)).length;
const knownCount = report.reduce((n, r) => n + r.hits.filter((h) => h.known).length, 0);
const newCount = report.reduce((n, r) => n + r.newHits.length, 0);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { considered, flagged: report.length, strongFiles, newCount, knownCount, stale, report },
      null,
      2,
    ),
  );
} else {
  console.log(`considered (journal + deliverable .md): ${considered}`);
  console.log(
    `NEW - corruption not previously acknowledged: ${newCount} line(s) in ${fresh.length} file(s)`,
  );
  console.log(
    `known - acknowledged as unrecoverable in the baseline: ${knownCount} line(s) in ${report.length - fresh.length} file(s)\n`,
  );

  for (const r of fresh) {
    const strong = r.newHits.filter((h) => h.strong).length;
    console.log(`NEW  ${r.file}  (${r.newHits.length} line${r.newHits.length === 1 ? '' : 's'}${strong ? `, ${strong} strong` : ''})`);
    for (const h of r.newHits.slice(0, 6)) {
      console.log(`  ${h.strong ? '!!' : '  '} ${String(h.n).padStart(4)}: ${h.line.slice(0, 150)}`);
    }
    if (r.newHits.length > 6) console.log(`     …and ${r.newHits.length - 6} more`);
    console.log('');
  }

  if (!fresh.length) {
    console.log('No new corruption. The acknowledged backlog is unrecoverable by design -');
    console.log('the values were deleted before they ever reached disk. See the baseline file.\n');
  }
  if (stale.length) {
    console.log(`${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} no longer match any line`);
    console.log('(repaired or edited). Re-run with --update-baseline to prune.\n');
  }
}

process.exit(fresh.length ? 1 : 0);
