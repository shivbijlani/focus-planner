// terminal-header-drift — the direction NOTHING else checks.
//
// Found 2026-08-26 on #448 (the consolidated plannermd + Overnight Agent dev row).
//
// THE SHAPE: the newest agent turn closes the task (`Status: Skip`/`Done`) because the
// user answered ONE sub-thread, while the agent BLOCK HEADER still says in-progress and
// still advertises other, unanswered asks. The task then goes inert -- the OA loop leaves
// `done`/`skip` alone -- and every ask the header was carrying is silently dropped.
//
// WHY THE EXISTING SWEEPS CANNOT SEE IT:
//   * drift-sweep [C] compares state vs the LIVE status, and liveStatus() prefers the
//     newest turn. Turn says skip, state says skip -> agrees -> no drift. The header is
//     never consulted.
//   * body-header-drift returns early (`if (st.status === 'done' || st.status === 'skip')
//     continue`) on exactly these tasks: it only models body-terminal + state-NON-terminal.
//     This is the same bug in the other direction -- cf. the 2026-08-25 22:00 learning.
//
// So this checks: newest TURN terminal + block HEADER non-terminal, and reports the asks
// the header was still carrying as the evidence of scope mismatch.
//
// Read-only. Never writes. Usage:
//   PLANNER_PATH=... node terminal-header-drift.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { liveStatus, normaliseStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }

const JOURNALS = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const SENTINEL = 'OVERNIGHT-AGENT do not edit this line';
const TERMINAL = new Set(['done', 'skip']);

// Accept the External-Ticket cell (`| 448,[176](...) |`) like the other sweeps do.
function boardIds(file) {
  const p = path.join(PLANNER, file);
  if (!existsSync(p)) return new Set();
  const ids = new Set();
  for (const m of readFileSync(p, 'utf8').matchAll(/^\|\s*(\d+)[,\s|]/gm)) ids.add(m[1]);
  return ids;
}

// The header Status line = the first `**Status:**` at or after the LAST sentinel,
// before the first chat turn. That is the line a human reads at the top of the block.
function headerStatus(text) {
  const s = text.lastIndexOf(SENTINEL);
  if (s === -1) return null;
  const after = text.slice(s);
  const stop = after.search(/<!--\s*from:/i);
  const slice = stop === -1 ? after : after.slice(0, stop);
  const m = /^\*\*Status:\*\*\s*(.+)$/im.exec(slice);
  if (!m) return null;
  return { raw: m[1].trim(), status: normaliseStatus(m[1].trim()) };
}

// Asks the HEADER is still advertising -- the thing that gets dropped when the task
// is closed off a narrower reply.
const rxHeaderAsk = [
  /waiting on[^.\n]{0,120}/i,
  /still (?:open|pending)[^.\n]{0,120}/i,
  /needs? (?:from )?you[^.\n]{0,120}/i,
  /awaiting[^.\n]{0,120}/i,
];

const active = boardIds('planner.md');
const rows = [];

for (const f of readdirSync(JOURNALS)) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;                       // only live board rows

  const text = readFileSync(path.join(JOURNALS, f), 'utf8');
  const live = liveStatus(text);
  if (!live || !TERMINAL.has(live.status)) continue;   // newest turn must CLOSE the task
  if (live.source === 'block') continue;               // the header itself is the closer -> consistent

  const hdr = headerStatus(text);
  if (!hdr || !hdr.status) continue;                   // unparseable header -> drift-sweep [E] owns it
  if (TERMINAL.has(hdr.status)) continue;              // header agrees it is closed -> fine

  const asks = [];
  for (const rx of rxHeaderAsk) {
    const hit = rx.exec(hdr.raw);
    if (hit) asks.push(hit[0].replace(/\s+/g, ' ').trim().slice(0, 90));
  }

  let state = null;
  const sf = path.join(stateDir, `task-${id}.json`);
  if (existsSync(sf)) {
    try { state = JSON.parse(readFileSync(sf, 'utf8').replace(/^\uFEFF/, '')).status; } catch { /* ignore */ }
  }

  rows.push({ id, header: hdr.status, headerRaw: hdr.raw.replace(/\s+/g, ' ').slice(0, 110), live: live.status, via: live.source, state, asks });
}

rows.sort((a, b) => Number(a.id) - Number(b.id));

console.log(`active board journals scanned; newest turn CLOSES the task but the block HEADER still says live: ${rows.length}\n`);
for (const r of rows) {
  console.log(`#${r.id}  header=${r.header}  newestTurn=${r.live} (${r.via})  state=${r.state}`);
  console.log(`   header line: ${r.headerRaw}`);
  for (const a of r.asks) console.log(`   header still advertises: "${a}"`);
  console.log('');
}
if (!rows.length) console.log('(none)');
process.exit(rows.length ? 1 : 0);
