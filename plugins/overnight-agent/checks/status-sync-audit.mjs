// status-sync-audit.mjs — for every ACTIVE board task where the journal's live
// **Status:** line disagrees with the agent state store, decide WHICH SIDE IS STALE.
//
// SKILL.md holds two invariants that can silently fall out of step:
//   1. "If scan and a journal ever disagree, the JOURNAL PROSE WINS - state is a
//      rebuildable cache."
//   2. "keep the visible **Status:** line human-readable and IN SYNC with it via
//      `oa-state.ps1 mark`."
//
// Those only agree while both are maintained together. A run that appends a turn but
// forgets `mark` leaves state stale; a run that calls `mark` but doesn't restate the
// Status line leaves the line Shiv actually READS stale. The two cases need OPPOSITE
// repairs, so guessing one rule for both is how a status gets corrupted.
//
// Evidence used to break the tie: the date carried ON the status line vs the date of
// the newest turn in the journal vs the state file's `updated` stamp.
// Read-only: prints a recommendation, never writes.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { liveStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('PLANNER_PATH is required'); process.exit(1); }
const journalDir = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');

const activeIds = new Set();
for (const line of readFileSync(path.join(PLANNER, 'planner.md'), 'utf8').split(/\r?\n/)) {
  const m = /^\|\s*(\d+)/.exec(line);
  if (m) activeIds.add(m[1]);
}

const rxDateHeader = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;

const out = [];
for (const f of readdirSync(journalDir)) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  if (!activeIds.has(id)) continue;

  const text = readFileSync(path.join(journalDir, f), 'utf8');
  const live = liveStatus(text);
  if (!live.canonical) continue;

  const sp = path.join(stateDir, `task-${id}.json`);
  if (!existsSync(sp)) continue;
  let st;
  try { st = JSON.parse(readFileSync(sp, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
  if (live.status === st.status) continue;

  // Newest `## YYYY-MM-DD` chat header anywhere in the file.
  const headers = [...text.matchAll(rxDateHeader)].map(x => x[1]).sort();
  const newestTurnDate = headers.length ? headers[headers.length - 1] : null;
  const stateUpdated = st.updated ? String(st.updated).slice(0, 10) : null;

  // Verdict.
  //
  // NOTE: `source: turn-N` is NOT by itself evidence of freshness. A status sitting in
  // turn 6 of 11 is exactly as superseded as one sitting in the block - that is the same
  // wrong-turn trap this library exists to close, and applying it as a blanket rule would
  // reintroduce the bug one level up. Only the NEWEST turn is self-evidently current;
  // everything else has to be dated.
  let verdict, why;
  if (live.turnCount > 0 && live.turnIndex === live.turnCount) {
    verdict = 'FIX STATE';
    why = `status sits in the NEWEST turn (${live.turnIndex}/${live.turnCount}), so it is current by construction`;
  } else if (live.date && newestTurnDate && live.date >= newestTurnDate) {
    verdict = 'FIX STATE';
    why = `status line dated ${live.date} is >= newest turn ${newestTurnDate}, so the line is current`;
  } else if (live.date && newestTurnDate && live.date < newestTurnDate) {
    verdict = 'FIX JOURNAL LINE';
    why = `status line dated ${live.date} predates the newest turn ${newestTurnDate}: the line Shiv reads is stale`;
  } else {
    verdict = 'AMBIGUOUS';
    why = 'no date on the status line and/or no dated turns - do not repair unattended';
  }

  out.push({ id, journal: live.status, state: st.status, source: live.source, turnIndex: live.turnIndex, turnCount: live.turnCount, statusDate: live.date, newestTurnDate, stateUpdated, verdict, why, line: live.line });
}

out.sort((a, b) => a.verdict.localeCompare(b.verdict) || Number(a.id) - Number(b.id));

console.log(`ACTIVE board tasks whose journal status != state status: ${out.length}\n`);
for (const r of out) {
  console.log(`#${r.id}  journal=${r.journal}  state=${r.state}   [${r.verdict}]`);
  console.log(`     via=${r.source} (turn ${r.turnIndex}/${r.turnCount})  statusLineDate=${r.statusDate ?? '-'}  newestTurn=${r.newestTurnDate ?? '-'}  stateUpdated=${r.stateUpdated ?? '-'}`);
  console.log(`     why: ${r.why}`);
  console.log(`     line: ${String(r.line).slice(0, 120)}`);
  console.log('');
}

const counts = out.reduce((a, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {});
console.log('summary: ' + JSON.stringify(counts));

