// orphan-liveness-sweep.mjs
//
// WHY: on 2026-08-26 the clock-0 fix (#280 / GH #176) was found sitting unbuilt
// for 22 days with a live, non-terminal plan — while `reversible-gate-sweep`,
// the detector built specifically to catch "the agent gated its own reversible
// work", reported 0 findings.
//
// It reported 0 because of one line:
//     if (!active.has(id)) continue;
// #280 has no row on planner.md. It is one of 69 orphan journals. Five sweeps
// carry that same active-board gate, so every one of them is blind to the whole
// orphan set:
//     self-answerable-sweep, reversible-gate-sweep, undelivered-plan-sweep,
//     declared-unblocked-sweep, terminal-header-drift
//
// Most orphans are deliberate — Shiv deleted ~29 dev tasks on 2026-08-24 and
// folded them into #448, and 67 of 69 are tombstoned. The gate is therefore
// right to skip *settled* orphans. What it must NOT skip is an orphan that is
// still NON-TERMINAL and still carrying a live ask: that task believes it is
// waiting on Shiv, while no board row shows it to him and no sweep can see it.
// It is invisible on every surface at once — the exact condition #445 recorded
// for #308 ("unreachable on every surface") and #228.
//
// This sweep is the complement of the gate, not a replacement for it: it looks
// ONLY at journals with no board row, and reports the ones that are still live.
//
// CRYING WOLF IS THE FAILURE MODE HERE, so it classifies rather than accuses.
// Most orphans were deleted ON PURPOSE and carry a tombstone in the board's
// sidecar. #445 measured that: "67 of 69 orphans are tombstoned, so the cleanup
// is genuinely just housekeeping", and "of the two real casualties, #228 is the
// one with a clock on it". A tombstone is therefore the signal that separates
// "retired deliberately" from "fell off the board silently". Only the
// untombstoned ones are reported as findings.
//
// Read-only. Run via run-sweeps.ps1.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';
import { liveStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const STATE = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip', 'skipped', 'complete', 'completed']);

function boardIds(file) {
  const ids = new Set();
  let raw = '';
  try { raw = fs.readFileSync(path.join(PLANNER, file), 'utf8'); } catch { return ids; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*[,|]/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// Ids the sync sidecars record as deliberately deleted. Read from both boards:
// a task retired from the active board tombstones there.
function tombstonedIds() {
  const out = new Set();
  for (const f of ['planner.md.sync.json', 'planner-completed.md.sync.json']) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(PLANNER, f), 'utf8'); } catch { continue; }
    let entries;
    try { entries = JSON.parse(raw).entries ?? {}; } catch { continue; }
    for (const [id, m] of Object.entries(entries)) if (m?.deleted) out.add(id);
  }
  return out;
}

// A journal is an orphan only if it appears on NEITHER board. A row that moved
// to planner-completed.md is settled, not orphaned.
const onActive = boardIds('planner.md');
const onCompleted = boardIds('planner-completed.md');
const tombstoned = tombstonedIds();

const orphans = [];
for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (onActive.has(id) || onCompleted.has(id)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');

  let sStatus = null;
  try {
    // oa-state.ps1 writes UTF-8 *with BOM*; JSON.parse throws without stripping it.
    const raw = fs.readFileSync(path.join(STATE, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    sStatus = JSON.parse(raw).status;
  } catch { /* untracked */ }

  const jStatus = liveStatus(text)?.status ?? null;
  // Terminal on EITHER side counts as settled. Deliberately generous: the point
  // is to surface the few that are unambiguously still live, not to relitigate
  // status drift, which drift-sweep already owns.
  if (TERMINAL.has(sStatus) || TERMINAL.has(jStatus)) continue;

  const { ask } = liveAsk(text);
  const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  const ageDays = last
    ? Math.round((new Date(new Date().toISOString().slice(0, 10)) - new Date(last)) / 86400000)
    : null;
  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 66);

  orphans.push({
    id, sStatus, jStatus, ask, ageDays, title,
    hasAsk: !!ask,
    retired: tombstoned.has(id),
  });
}

// A finding is an orphan that is non-terminal, still asking for something, and
// was NEVER deliberately deleted. Everything else is housekeeping.
const live = orphans.filter((o) => o.hasAsk && !o.retired);
const retired = orphans.filter((o) => o.hasAsk && o.retired);
live.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

console.log(`journals with no row on either board, non-terminal: ${orphans.length}`);
console.log(`  deliberately retired (tombstoned in a board sidecar): ${retired.length}`);
console.log(`FLAGGED - live ask, never deleted: invisible to the 5 board-gated sweeps AND to Shiv: ${live.length}\n`);

for (const o of live) {
  console.log(`#${o.id.padEnd(4)} ${String(o.ageDays ?? '?').padStart(4)}d  state=${String(o.sStatus).padEnd(11)} journal=${String(o.jStatus).padEnd(11)} ${o.title}`);
  console.log(`      ask: ${String(o.ask).replace(/\s+/g, ' ').slice(0, 150)}\n`);
}

const quiet = orphans.filter((o) => !o.hasAsk).map((o) => `#${o.id}`);
if (quiet.length) console.log(`non-terminal orphans with no readable ask (reported, not a finding): ${quiet.join(' ')}`);

process.exit(live.length ? 1 : 0);
