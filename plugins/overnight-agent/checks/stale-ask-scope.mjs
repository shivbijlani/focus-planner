// stale-ask-scope.mjs
//
// Measures a defect found 2026-08-25 21:00 PT on #283.
//
// `declared-unblocked-sweep` and `inprogress-stall-sweep` both extract "the task's ask"
// by taking the LAST `**Needs from you:**` match ANYWHERE in the journal. A journal is a
// bottom-appended chat thread of many agent turns, and a turn may legitimately ask via a
// different dialect (`Next:` / `Your call:` / an imperative `Reply \`x\``). So when the
// NEWEST turn does not use the `Needs from you:` dialect, that "last match" is silently
// lifted out of an OLDER, superseded turn and reported as the live ask.
//
// This script quantifies it: for every active, non-terminal task, does the last
// `Needs from you:` marker sit BEFORE the start of the newest agent turn?
//
// Read-only. Prints evidence, not verdicts.

import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';

const stale = [];
const fine = [];
const noMarker = [];

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;

  let status = '?';
  try {
    status = JSON.parse(
      fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, ''),
    ).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');

  // Start of the newest agent turn.
  const turns = [...text.matchAll(new RegExp(AGENT, 'g'))].map((x) => x.index);
  if (!turns.length) continue;
  const newestTurn = turns[turns.length - 1];

  // If the user spoke after that turn, the newest turn is the user's - out of scope here.
  const users = [...text.matchAll(new RegExp(USER, 'g'))].map((x) => x.index);
  const lastUser = users.length ? users[users.length - 1] : -1;
  if (lastUser > newestTurn) continue;

  const needs = [...text.matchAll(/\*\*Needs from you[^:]*:\*\*\s*(.+)/g)];
  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 52);

  if (!needs.length) {
    noMarker.push({ id, status, title });
    continue;
  }

  const lastNeeds = needs[needs.length - 1];
  const turnIdx = turns.filter((t) => t <= lastNeeds.index).length; // 1-based turn owning the ask

  if (lastNeeds.index < newestTurn) {
    stale.push({
      id,
      status,
      title,
      turnIdx,
      turnCount: turns.length,
      reported: lastNeeds[1].trim().slice(0, 100),
    });
  } else {
    fine.push(id);
  }
}

stale.sort((a, b) => (b.turnCount - b.turnIdx) - (a.turnCount - a.turnIdx));

console.log(`active non-terminal tasks examined : ${stale.length + fine.length + noMarker.length}`);
console.log(`  ask marker in the NEWEST turn (ok): ${fine.length}`);
console.log(`  no 'Needs from you:' marker at all: ${noMarker.length}`);
console.log(`  ** ask lifted from an OLDER turn **: ${stale.length}\n`);

console.log('--- MIS-ATTRIBUTED: the sweeps report an ask from a superseded turn ---');
for (const r of stale) {
  const behind = r.turnCount - r.turnIdx;
  console.log(
    `#${r.id.padEnd(4)} ${r.status.padEnd(11)} ask is from turn ${r.turnIdx}/${r.turnCount} ` +
    `(${behind} turn${behind === 1 ? '' : 's'} stale)  ${r.title}`,
  );
  console.log(`      reported ask: ${r.reported}`);
}
