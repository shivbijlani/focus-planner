// Urgency x staleness: which active-board tasks are marked urgent but have not moved?
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
const JOURNALS = path.join(PLANNER, 'journal');
// ⚠️ Derived at run time, never hardcoded — see the parked-age.mjs note (2026-08-26).
const NOW = new Date((process.env.OA_TODAY || new Date().toISOString().slice(0, 10)) + 'T12:00:00-07:00');

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');

const rows = [];
let section = '';
for (const line of board.split(/\r?\n/)) {
  const sm = /^##\s+(.+)$/.exec(line);
  if (sm) { section = sm[1].trim(); continue; }
  const m = /^\|\s*(\d+)[^|]*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
  if (!m) continue;
  const [, id, icon, title, prio, added] = m;
  const sf = path.join(stateDir, `task-${id}.json`);
  let st = { status: '?' };
  if (fs.existsSync(sf)) {
    try { st = JSON.parse(fs.readFileSync(sf, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { console.error(`PARSE FAIL ${id}: ${e.message}`); }
  }
  if (st.status === 'done' || st.status === 'skip') continue;

  const jf = path.join(JOURNALS, `task-${id}.md`);
  const mtime = fs.existsSync(jf) ? fs.statSync(jf).mtime : null;
  const idleDays = mtime ? Math.floor((NOW - mtime) / 86400000) : null;
  const ageDays = added ? Math.floor((NOW - new Date(added + 'T00:00:00-07:00')) / 86400000) : null;

  rows.push({ id, icon, section, title: title.slice(0, 70), status: st.status, idleDays, ageDays });
}

const urgent = rows.filter(r => r.icon.includes('🔴'));
console.log(`=== 🔴 URGENT, still open: ${urgent.length} ===`);
urgent.sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0));
for (const r of urgent)
  console.log(`  #${r.id} [${r.status}] idle=${r.idleDays}d age=${r.ageDays}d  ${r.title}`);

console.log(`\n=== longest-idle open tasks (any urgency), top 15 ===`);
rows.sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0));
for (const r of rows.slice(0, 15))
  console.log(`  ${r.icon} #${r.id} [${r.status}] idle=${r.idleDays}d age=${r.ageDays}d  ${r.title}`);
