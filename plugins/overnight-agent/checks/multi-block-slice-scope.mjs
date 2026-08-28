// multi-block-slice-scope.mjs — how many journals have MORE THAN ONE `**Status:**`
// line inside the single slice lib-live-status picks, i.e. how many are exposed to
// the "first Status in the slice wins" defect. Read-only measurement.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { liveStatus, normaliseStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('PLANNER_PATH is required'); process.exit(1); }
const journalDir = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');

const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';
const SENTINEL = '<!-- OVERNIGHT-AGENT';
const rxStatusG = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/gm;

function allIndexes(hay, needle) {
  const out = []; let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
}

const activeIds = new Set();
for (const line of readFileSync(path.join(PLANNER, 'planner.md'), 'utf8').split(/\r?\n/)) {
  const m = /^\|\s*(\d+)/.exec(line); if (m) activeIds.add(m[1]);
}

let scanned = 0, multi = 0, changes = 0, activeChanges = 0;
const rows = [];

for (const f of readdirSync(journalDir)) {
  const m = /^task-(\d+)\.md$/.exec(f); if (!m) continue;
  const id = m[1];
  const text = readFileSync(path.join(journalDir, f), 'utf8');
  scanned++;

  // Rebuild the exact slice lib-live-status would choose.
  const turns = allIndexes(text, AGENT), users = allIndexes(text, USER);
  let start = null, src = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    let end = text.length;
    for (const idx of [...turns, ...users]) if (idx > turns[i] && idx < end) end = idx;
    if (/^[ \t]*\*{0,2}Status:?\*{0,2}/m.test(text.slice(turns[i], end))) { start = turns[i]; src = `turn-${i + 1}`; break; }
  }
  if (start === null) {
    const s = text.lastIndexOf(SENTINEL);
    if (s === -1) continue;
    start = s; src = 'block';
  }
  let end = text.length;
  for (const idx of [...turns, ...users]) if (idx > start && idx < end) end = idx;
  const slice = text.slice(start, end);

  rxStatusG.lastIndex = 0;
  const hits = [...slice.matchAll(rxStatusG)];
  if (hits.length < 2) continue;
  multi++;

  const firstLine = slice.slice(hits[0].index).split(/\r?\n/)[0].trim();
  const lastLine = slice.slice(hits[hits.length - 1].index).split(/\r?\n/)[0].trim();
  const first = normaliseStatus(hits[0][1].trim());
  const last = normaliseStatus(hits[hits.length - 1][1].trim());
  if (first === last) continue;
  changes++;
  const active = activeIds.has(id);
  if (active) activeChanges++;

  const sp = path.join(stateDir, `task-${id}.json`);
  let stState = '-';
  if (existsSync(sp)) { try { stState = JSON.parse(readFileSync(sp, 'utf8').replace(/^\uFEFF/, '')).status; } catch { } }
  rows.push({ id, active, src, n: hits.length, first, last, stState, firstLine, lastLine });
}

rows.sort((a, b) => (b.active - a.active) || Number(a.id) - Number(b.id));
console.log(`journals scanned: ${scanned}`);
console.log(`slices holding >1 Status line: ${multi}`);
console.log(`...where first != last (status actually MISREAD): ${changes}  (active board: ${activeChanges})\n`);
for (const r of rows) {
  console.log(`#${r.id}${r.active ? '  [ACTIVE]' : '  (not on board)'}  via=${r.src}  statusLinesInSlice=${r.n}`);
  console.log(`     reads as : ${r.first}   <- ${r.firstLine.slice(0, 90)}`);
  console.log(`     truth    : ${r.last}   <- ${r.lastLine.slice(0, 90)}`);
  console.log(`     state    : ${r.stState}`);
  console.log('');
}
