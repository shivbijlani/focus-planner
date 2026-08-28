// diff-ask-extraction.mjs — old vs new ask extraction, BOTH directions.
//
// The fix removes false positives (a superseded ask reported as live). The dangerous
// direction is the other one: could the new, correctly-scoped ask cause a sweep to STOP
// flagging something it should flag, or START flagging something spurious?
//
// This prints every task where the dismissive verdict CHANGES, so the effect is measured
// rather than assumed.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);

const rxNeeds = /^\s*\*{0,2}Needs from you\b[^:]*:\*{0,2}\s*(.*)$/i;
const rxDismissive = /^\s*(none|nothing|n\/a|no)\b/i;

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const m of board.matchAll(/^\|\s*(\d+)[,\s|]/gm)) active.add(m[1]);

// OLD semantics: last `Needs from you:` line anywhere in the file.
function oldAsk(text) {
  let ask = null;
  for (const line of text.split(/\r?\n/)) {
    const m = rxNeeds.exec(line);
    if (m) ask = m[1].trim();
  }
  return ask;
}

const gainedFlag = [];
const lostFlag = [];
let examined = 0;

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
  examined++;

  const o = oldAsk(text);
  const n = liveAsk(text).ask;

  const oDis = o !== null && rxDismissive.test(o);
  const nDis = n !== null && rxDismissive.test(n);
  if (oDis === nDis) continue;

  const row = { id, status, old: (o ?? '(null)').slice(0, 78), neu: (n ?? '(null)').slice(0, 78) };
  if (nDis && !oDis) gainedFlag.push(row);
  else lostFlag.push(row);
}

console.log(`active non-terminal tasks examined: ${examined}\n`);

console.log(`--- verdict LOST (was "declares itself unblocked", now correctly not) : ${lostFlag.length} ---`);
for (const r of lostFlag) {
  console.log(`#${r.id.padEnd(4)} ${r.status}`);
  console.log(`   old (stale): ${r.old}`);
  console.log(`   new (live) : ${r.neu}\n`);
}

console.log(`--- verdict GAINED (newly declares itself unblocked - must be justified) : ${gainedFlag.length} ---`);
for (const r of gainedFlag) {
  console.log(`#${r.id.padEnd(4)} ${r.status}`);
  console.log(`   old (stale): ${r.old}`);
  console.log(`   new (live) : ${r.neu}\n`);
}
