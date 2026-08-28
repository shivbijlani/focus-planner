// turn-header-date-scope.mjs — can we order a turn's Status line against the block's
// when the turn's line carries no date? Yes: a journal is a chat thread, so every turn
// sits under a `## YYYY-MM-DD` header. Use that as the turn's effective date.
//
// This measures what changes if liveStatus() compared (turn effective date) vs
// (block Status-line date) instead of preferring the turn unconditionally.
import fs from 'node:fs';
import path from 'node:path';
import { normaliseStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';
const rxStatusLine = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m;
const rxDate = /(\d{4}-\d{2}-\d{2})/;
const rxHeader = /^##[ \t]+(\d{4}-\d{2}-\d{2})/gm;

function headerDatesWithOffset(text) {
  const out = [];
  rxHeader.lastIndex = 0;
  let m;
  while ((m = rxHeader.exec(text)) !== null) out.push({ off: m.index, date: m[1] });
  return out;
}
function headerDateFor(headers, off) {
  let best = null;
  for (const h of headers) { if (h.off <= off) best = h.date; else break; }
  return best;
}
function allIndexes(hay, needle) {
  const out = []; let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
}
function statusFromSlice(slice) {
  const m = rxStatusLine.exec(slice);
  if (!m) return null;
  const line = slice.slice(m.index).split(/\r?\n/)[0].trim();
  const d = rxDate.exec(line);
  return { status: normaliseStatus(m[1].trim()), raw: m[1].trim(), line, date: d ? d[1] : null };
}

function analyse(text) {
  const turns = allIndexes(text, AGENT);
  const users = allIndexes(text, USER);
  const headers = headerDatesWithOffset(text);

  let turnHit = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const start = turns[i];
    let end = text.length;
    for (const idx of [...turns, ...users]) if (idx > start && idx < end) end = idx;
    const hit = statusFromSlice(text.slice(start, end));
    if (hit) {
      turnHit = { ...hit, turnIndex: i + 1, turnCount: turns.length,
                  effDate: hit.date || headerDateFor(headers, start), off: start };
      break;
    }
  }

  let blockHit = null;
  const s = text.lastIndexOf(SENTINEL);
  if (s !== -1) {
    let end = text.length;
    for (const idx of [...turns, ...users]) if (idx > s && idx < end) end = idx;
    const hit = statusFromSlice(text.slice(s, end));
    if (hit) blockHit = { ...hit, effDate: hit.date, off: s };
  }
  return { turnHit, blockHit, turnCount: turns.length };
}

function boardIds(file) {
  const set = new Set();
  if (!fs.existsSync(file)) return set;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(\d{1,6})\b/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}
const active = boardIds(path.join(PLANNER, 'planner.md'));
const completed = boardIds(path.join(PLANNER, 'planner-completed.md'));

const changed = [];
let considered = 0, sameVerdict = 0, noBasis = 0;

for (const f of fs.readdirSync(JDIR)) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');
  const { turnHit, blockHit } = analyse(text);
  if (!turnHit || !blockHit) continue;          // nothing to arbitrate
  considered++;

  const oldWinner = 'turn';                      // current lib behaviour
  let newWinner = 'turn';
  let basis = 'tie->turn';
  if (turnHit.effDate && blockHit.effDate) {
    if (blockHit.effDate > turnHit.effDate) { newWinner = 'block'; basis = 'block-newer'; }
    else basis = blockHit.effDate === turnHit.effDate ? 'same-date->turn' : 'turn-newer';
  } else { noBasis++; basis = 'undatable->turn'; }

  if (newWinner !== oldWinner) {
    const oldS = turnHit.status, newS = blockHit.status;
    changed.push({ id, oldS, newS, turnHit, blockHit, basis,
                   where: active.has(id) ? 'board' : (completed.has(id) ? 'completed' : 'orphan') });
  } else sameVerdict++;
}

console.log(`considered (journals with BOTH a turn status and a block status): ${considered}`);
console.log(`verdict unchanged: ${sameVerdict}   undatable (kept turn): ${noBasis}`);
console.log(`\nVERDICT CHANGES (block would win): ${changed.length}`);
for (const c of changed.sort((a, b) => Number(a.id) - Number(b.id))) {
  const flip = c.oldS !== c.newS ? 'STATUS FLIPS' : 'same status';
  console.log(`\n  #${c.id} [${c.where}]  ${c.oldS} -> ${c.newS}   (${flip}; ${c.basis})`);
  console.log(`     turn ${c.turnHit.turnIndex}/${c.turnHit.turnCount} eff=${c.turnHit.effDate}: ${c.turnHit.line.slice(0, 105)}`);
  console.log(`     block            eff=${c.blockHit.effDate}: ${c.blockHit.line.slice(0, 105)}`);
}
const flips = changed.filter(c => c.oldS !== c.newS);
console.log(`\nsummary: changes=${changed.length}, of which real status flips=${flips.length} (board: ${flips.filter(c => c.where === 'board').length}, completed: ${flips.filter(c => c.where === 'completed').length}, orphan: ${flips.filter(c => c.where === 'orphan').length})`);
