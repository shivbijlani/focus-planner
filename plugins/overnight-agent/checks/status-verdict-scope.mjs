// status-verdict-scope.mjs — measure what #202 actually changes on the live corpus.
//
// A `*-scope.mjs` measurement, not a guard: it prints, it never fails a run, and it is
// not registered in run-sweeps.ps1. Its job is to answer "how many tasks does this move,
// and in which direction" with journal ids, so the change can be reviewed against real
// data rather than against fixtures.
//
// Reports three populations, because only the first is the intended effect and the other
// two are how you find out you over-corrected:
//   LEAVES  — was non-terminal, now terminal. Finished tasks freed from the queue.
//   ENTERS  — was terminal, now non-terminal. Tasks whose frozen header said `done`
//             while the agent had since picked them back up.
//   parse   — terminal-ness unchanged; the dialect fault corrected (`in` -> `in-progress`).
//
// Read-only. Usage: PLANNER_PATH=... BRIDGE_SRC=... node status-verdict-scope.mjs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = process.env.BRIDGE_SRC;
const PLANNER = process.env.PLANNER_PATH;
const { agentBlockText, agentBlockStatus } = await import(`${SRC}/journal.js`);
const { digestStatus } = await import(`${SRC}/liveStatus.js`);

const TERMINAL = new Set(['done', 'skip', 'skipped', 'complete', 'completed']);
const dir = path.join(PLANNER, 'journal');

const rows = [];
for (const f of readdirSync(dir)) {
  if (!/^task-(\d+)\.md$/.test(f)) continue;
  const id = /^task-(\d+)\.md$/.exec(f)[1];
  const text = readFileSync(path.join(dir, f), 'utf8');
  const before = agentBlockStatus(agentBlockText(text));
  const after = digestStatus(text, before);
  if (before === after) continue;
  rows.push({
    id,
    before,
    after,
    beforeTerminal: TERMINAL.has(before),
    afterTerminal: TERMINAL.has(after),
  });
}

const leaves = rows.filter((r) => !r.beforeTerminal && r.afterTerminal);
const enters = rows.filter((r) => r.beforeTerminal && !r.afterTerminal);
const cosmetic = rows.filter((r) => r.beforeTerminal === r.afterTerminal);

console.log(`journals with a changed verdict: ${rows.length}`);
console.log(`\nLEAVES the queue (was non-terminal, now terminal): ${leaves.length}`);
for (const r of leaves) console.log(`  task ${r.id}: ${r.before} -> ${r.after}`);
console.log(`\nENTERS the queue (was terminal, now non-terminal): ${enters.length}`);
for (const r of enters) console.log(`  task ${r.id}: ${r.before} -> ${r.after}`);
console.log(`\nsame terminal-ness, parse corrected only: ${cosmetic.length}`);
const byPair = {};
for (const r of cosmetic) {
  const k = `${r.before} -> ${r.after}`;
  byPair[k] = (byPair[k] || 0) + 1;
}
for (const [k, v] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
