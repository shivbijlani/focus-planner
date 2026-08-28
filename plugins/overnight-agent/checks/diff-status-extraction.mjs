// diff-status-extraction.mjs — differential: bridge `agentBlockStatus` (what drift-sweep
// uses today) vs `lib-live-status.liveStatus` (newest turn that carries a Status line,
// with dialect normalisation).
//
// Reported in BOTH directions, because a wrong NEGATIVE is the expensive one: losing a
// real drift row is worse than adding a noisy one. Read-only.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { liveStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
const SRC = process.env.BRIDGE_SRC;
if (!PLANNER || !SRC) { console.error('set PLANNER_PATH and BRIDGE_SRC'); process.exit(1); }
const { agentBlockText, agentBlockStatus } = await import(`${SRC}/journal.js`);

const journalDir = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');

function boardIds(file) {
  const p = path.join(PLANNER, file);
  if (!existsSync(p)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(\d+)/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}
const active = boardIds('planner.md');
const completed = boardIds('planner-completed.md');
const TERMINAL = new Set(['done', 'skip', 'skipped', 'complete', 'completed']);

const rows = [];
for (const f of readdirSync(journalDir)) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  const text = readFileSync(path.join(journalDir, f), 'utf8');
  const old = agentBlockStatus(agentBlockText(text));
  const live = liveStatus(text);
  let sStatus = null;
  const sp = path.join(stateDir, `task-${id}.json`);
  if (existsSync(sp)) {
    try { sStatus = JSON.parse(readFileSync(sp, 'utf8').replace(/^\uFEFF/, '')).status; } catch { }
  }
  rows.push({ id, old, live, sStatus, onActive: active.has(id), onCompleted: completed.has(id) });
}

const oldDrift = rows.filter(r => r.old !== r.sStatus);
// New drift only counts CANONICAL readings: a non-canonical status is "unreadable",
// not "different", and must not be reported as a disagreement.
const newDrift = rows.filter(r => r.live.canonical && r.live.status !== r.sStatus);

console.log(`journals=${rows.length}  activeBoard=${active.size}  completedBoard=${completed.size}`);
console.log(`\ndrift count:  BEFORE=${oldDrift.length}   AFTER=${newDrift.length}`);

const oldIds = new Set(oldDrift.map(r => r.id));
const newIds = new Set(newDrift.map(r => r.id));

const resolved = oldDrift.filter(r => !newIds.has(r.id));
console.log(`\n[-] rows that STOP being drift (parser artefacts): ${resolved.length}`);
for (const r of resolved) {
  console.log(`   #${r.id.padEnd(4)} old=${String(r.old).padEnd(10)} live=${String(r.live.status ?? '(non-canonical: ' + r.live.raw + ')').padEnd(28)} state=${r.sStatus}`);
}

const added = newDrift.filter(r => !oldIds.has(r.id));
console.log(`\n[+] rows NEWLY reported as drift (must be justified): ${added.length}`);
for (const r of added) {
  console.log(`   #${r.id.padEnd(4)} old=${String(r.old).padEnd(10)} live=${String(r.live.status).padEnd(12)} state=${String(r.sStatus).padEnd(12)} via=${r.live.source}`);
}

console.log(`\n[=] rows that remain drift under BOTH: ${newDrift.filter(r => oldIds.has(r.id)).length}`);
for (const r of newDrift.filter(r => oldIds.has(r.id))) {
  const where = r.onActive ? 'ACTIVE' : r.onCompleted ? 'completed' : 'orphan';
  console.log(`   #${r.id.padEnd(4)} live=${String(r.live.status).padEnd(12)} state=${String(r.sStatus).padEnd(12)} via=${String(r.live.source).padEnd(8)} [${where}]`);
}

// The decision-changing subset: does terminal-ness flip on an ACTIVE row?
const flips = rows.filter(r => r.onActive && r.live.canonical &&
  TERMINAL.has(r.old) !== TERMINAL.has(r.live.status));
console.log(`\n[!] ACTIVE rows where terminal-ness FLIPS between parsers: ${flips.length}`);
for (const r of flips) console.log(`   #${r.id} old=${r.old} live=${r.live.status} state=${r.sStatus}`);

// Non-canonical readings: honest "unreadable", previously silently truncated.
const nonCanon = rows.filter(r => !r.live.canonical && r.live.source !== 'none');
console.log(`\n[?] status present but NON-CANONICAL (was silently truncated before): ${nonCanon.length}`);
for (const r of nonCanon) console.log(`   #${r.id.padEnd(4)} old=${String(r.old).padEnd(10)} raw="${r.live.raw}"${r.onActive ? '  (ACTIVE)' : ''}`);
