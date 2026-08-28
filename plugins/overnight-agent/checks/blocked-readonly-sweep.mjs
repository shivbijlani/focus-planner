// Sweep: `blocked`/gated tasks whose OWN ask says nothing is needed from Shiv.
// Established 2026-08-25 11:45 PT after 4 independent instances (#236, #423, #376, #427).
// Uses the bridge's real NEEDS_RE so the checker is not stricter than the parser.
import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH;
const JOURNALS = path.join(PLANNER, 'journal');

// EXACT copy of the bridge's NEEDS_RE (digest.js) - do not tighten.
const rxNeeds = /^\s*\*{0,2}Needs from you\b[^:]*:\*{0,2}\s*(.*)$/i;
const rxDismissive = /^\s*(none|nothing|n\/a|no)\b/i;

// active board ids
const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const activeIds = new Set();
for (const m of board.matchAll(/^\|\s*(\d+)[,\s|]/gm)) activeIds.add(m[1]);

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const rows = [];
for (const f of fs.readdirSync(stateDir)) {
  const m = /^task-(\d+)\.json$/.exec(f);
  if (!m) continue;
  const id = m[1];
  if (!activeIds.has(id)) continue;
  // oa-state.ps1 writes these with a UTF-8 BOM; JSON.parse rejects it. Strip it, and
  // NEVER swallow the error - a silent catch here reports "0 blocked" as good news.
  let st;
  const raw = fs.readFileSync(path.join(stateDir, f), 'utf8').replace(/^\uFEFF/, '');
  try { st = JSON.parse(raw); } catch (e) { console.error(`PARSE FAIL ${f}: ${e.message}`); continue; }
  if (st.status !== 'blocked') continue;

  const jf = path.join(JOURNALS, `task-${id}.md`);
  if (!fs.existsSync(jf)) { rows.push({ id, ask: '(no journal)', flag: '?' }); continue; }
  // The LIVE ask only - see lib-live-ask.mjs. "Last Needs-from-you line in the file"
  // lifted asks out of superseded turns, and an EMPTY marker line anywhere could blank
  // the ask entirely (which is what produced #219's puzzling blank on 2026-08-25).
  const { ask, source } = liveAsk(fs.readFileSync(jf, 'utf8'));
  if (ask === null) { rows.push({ id, ask: `NO LIVE ASK (${source})`, flag: '!' }); continue; }
  const dismissive = rxDismissive.test(ask);
  rows.push({ id, ask: `[${source}] ${ask.slice(0, 110)}`, flag: dismissive ? 'FLAG' : '' });
}

rows.sort((a, b) => Number(a.id) - Number(b.id));
console.log(`blocked tasks on active board: ${rows.length}`);
for (const r of rows) console.log(`  ${r.flag.padEnd(4)} #${r.id}  ${r.ask}`);
console.log(`\nFLAGGED (own ask says nothing needed -> read-only half is being suppressed): ` +
  rows.filter(r => r.flag === 'FLAG').map(r => '#' + r.id).join(', ') || '(none)');
