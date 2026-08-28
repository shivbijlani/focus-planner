// block-newer-scope.mjs — measure how often lib-live-status returns a TURN status
// that is strictly OLDER than the agent BLOCK's own Status line.
//
// lib-live-status walks turns newest->oldest and takes the first with a Status line,
// falling back to the block only when NO turn has one. It never compares dates. But
// SKILL.md's template puts the live status in the BLOCK, and a run that rewrites the
// block without restating status in its turn leaves the newest Status-bearing turn
// stale. Then liveStatus() reports that stale turn as "live".
import fs from 'node:fs';
import path from 'node:path';
import { liveStatus, normaliseStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';
const rxStatusLine = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m;
const rxDate = /(\d{4}-\d{2}-\d{2})/;

function blockStatus(text) {
  const s = text.lastIndexOf(SENTINEL);
  if (s === -1) return null;
  let end = text.length;
  for (const m of [AGENT, USER]) {
    let i = text.indexOf(m, s);
    if (i !== -1 && i < end) end = i;
  }
  const slice = text.slice(s, end);
  const m = rxStatusLine.exec(slice);
  if (!m) return null;
  const line = slice.slice(m.index).split(/\r?\n/)[0].trim();
  const d = rxDate.exec(line);
  return { status: normaliseStatus(m[1].trim()), raw: m[1].trim(), line, date: d ? d[1] : null };
}

// Board membership so we can separate active rows from the archive.
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

const rows = [];
for (const f of fs.readdirSync(JDIR)) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');
  const live = liveStatus(text);
  const blk = blockStatus(text);
  if (!blk || !blk.date) continue;                 // need a dated block line to compare
  if (!live || !String(live.source).startsWith('turn-')) continue;
  if (!live.date) {
    rows.push({ id, kind: 'turn-undated', live, blk, onBoard: active.has(id) });
    continue;
  }
  if (blk.date > live.date) {
    rows.push({ id, kind: 'block-newer', live, blk, onBoard: active.has(id) });
  }
}

const newer = rows.filter(r => r.kind === 'block-newer');
const undated = rows.filter(r => r.kind === 'turn-undated');

function show(list, title) {
  console.log(`\n${title}: ${list.length}`);
  for (const r of list.sort((a, b) => Number(a.id) - Number(b.id))) {
    const flip = r.live.status !== r.blk.status ? '  *** STATUS DIFFERS ***' : '  (same status)';
    console.log(`  #${r.id}${r.onBoard ? ' [board]' : ''}  live=${r.live.status} via=${r.live.source} (${r.live.date || 'no date'})  block=${r.blk.status} (${r.blk.date})${flip}`);
    if (r.live.status !== r.blk.status) {
      console.log(`        turn : ${r.live.line.slice(0, 110)}`);
      console.log(`        block: ${r.blk.line.slice(0, 110)}`);
    }
  }
}

show(newer, 'BLOCK Status line is strictly NEWER than the turn liveStatus() used');
show(undated, 'turn Status line has NO date, block does (cannot order them)');

const boardFlips = newer.filter(r => r.onBoard && r.live.status !== r.blk.status);
console.log(`\nsummary: block-newer=${newer.length} (status differs: ${newer.filter(r => r.live.status !== r.blk.status).length}, of which on active board: ${boardFlips.length}); turn-undated=${undated.length}`);
