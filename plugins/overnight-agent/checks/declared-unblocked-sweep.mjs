// declared-unblocked-sweep.mjs
//
// The 17:00 run (2026-08-25) established this as a standing check after #163 sat 72 days
// behind an ask whose own text said "optional":
//   "grep the backlog for `Needs from you:.*optional` — by construction every hit is a task
//    that declared itself unblocked and was parked anyway."
//
// This generalises it to none / nothing / optional, and — critically — SCOPES it to tasks
// that are still open (active board, non-terminal state) and were not written today.
// An unscoped grep returns ~119 hits and is useless; scoping is what makes it actionable.
//
// Reports evidence, not verdicts. "Needs from you: none" is legitimate when the task is
// genuinely waiting on an approval decision, so the age column is the real signal.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);
const MIN_AGE = Number(process.env.OA_MIN_AGE || 30); // days parked before it is interesting

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);
const rows = [];

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;

  let status = '?';
  try {
    // oa-state.ps1 writes UTF-8 with BOM.
    status = JSON.parse(
      fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, ''),
    ).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');
  const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).filter((d) => d <= TODAY).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  if (!last || last === TODAY) continue;
  const ageDays = Math.round((new Date(TODAY) - new Date(last)) / 86400000);
  if (ageDays < MIN_AGE) continue;

  // The LIVE ask only - see lib-live-ask.mjs. Taking the last `Needs from you:` anywhere
  // in the file silently lifted the ask out of a superseded turn (12 of 49 active tasks,
  // up to 10 turns stale; #283 was the casualty, 2026-08-25).
  const { ask: liveAskText, source } = liveAsk(text);
  if (!liveAskText) continue;
  const ask = liveAskText;

  // Does the ask open by declaring itself unnecessary?
  if (!/^(none|nothing|no\b|optional)/i.test(ask) && !/\boptional\b/i.test(ask.slice(0, 90))) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 60);
  rows.push({ id, status, ageDays, title, source, ask: ask.slice(0, 165) });
}

rows.sort((a, b) => b.ageDays - a.ageDays);
console.log(`FLAGGED — open, parked >=${MIN_AGE}d, own ask says none/nothing/optional: ${rows.length}\n`);
for (const r of rows) {
  console.log(`#${r.id.padEnd(4)} ${String(r.ageDays).padStart(3)}d  ${r.status.padEnd(11)} ${r.title}`);
  console.log(`      ask [${r.source}]: ${r.ask}\n`);
}
