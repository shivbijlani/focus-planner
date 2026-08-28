// parked-age.mjs — rank non-terminal tasks by how long they have been parked.
// Age = most recent date found in the journal (## YYYY-MM-DD heading, Status line, or Run log date).
// Only considers tasks that are on the ACTIVE board (planner.md), so completed work is excluded.
import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const activeIds = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*(?:,|\|)/) || line.match(/^\|\s*(\d+)\s*\|/);
  if (m) activeIds.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const stateOf = (id) => {
  try {
    // oa-state.ps1 writes UTF-8 *with BOM* — strip it or JSON.parse throws.
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch { return null; }
};

const TERMINAL = new Set(['done', 'skip']);
// ⚠️ `today` is DERIVED AT RUN TIME, never hardcoded (fixed 2026-08-26 08:00 PT).
// This file used to say `new Date('2026-08-25T00:00:00Z')` with a matching
// `.filter(d => d <= '2026-08-25')`. Once the clock rolled past that date the sweep
// silently reported a stale world: every age was a day low, and any journal written
// "today" had its own newest date filtered out — so a freshly-written task fell back
// to the `9999` no-date sentinel and sorted to the TOP of the parked list as the
// most-neglected task on the board. #192, #213, #215 and #263 all did exactly that.
// A hardcoded date is a silent inversion waiting for the clock to roll.
const TODAY_STR = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);
const today = new Date(TODAY_STR + 'T00:00:00Z');
const rows = [];

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!activeIds.has(id)) continue;
  const st = stateOf(id);
  const status = st?.status || '?';
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');
  const dates = [...text.matchAll(/(20\d\d)-(\d\d)-(\d\d)/g)]
    .map((d) => `${d[1]}-${d[2]}-${d[3]}`)
    .filter((d) => d <= TODAY_STR)
    .sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  const ageDays = last ? Math.round((today - new Date(last + 'T00:00:00Z')) / 86400000) : 9999;

  // the LIVE ask (newest turn), not the last marker anywhere in the file
  const { ask: liveAskText } = liveAsk(text);
  const ask = liveAskText ? liveAskText.slice(0, 150) : '(no ask marker)';
  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 70);

  rows.push({ id, status, ageDays, last, title, ask });
}

rows.sort((a, b) => b.ageDays - a.ageDays);
console.log(`active non-terminal tasks: ${rows.length}\n`);
for (const r of rows) {
  console.log(`#${r.id.padEnd(4)} ${String(r.ageDays).padStart(3)}d  ${r.status.padEnd(11)} ${r.title}`);
  console.log(`      ask: ${r.ask}`);
}
