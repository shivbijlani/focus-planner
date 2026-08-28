// Read-only measurement: how far has each journal's BLOCK HEADER Status line drifted
// from the task's LIVE status (newest Status-bearing turn, arbitrated by date)?
//
// terminal-header-drift only fires on the narrow case (newest turn terminal + header
// non-terminal + row on the active board). This measures the whole corpus so we can
// tell whether #232 is a one-off or a class.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { liveStatus, normaliseStatus, statusStampDate } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JOURNALS = path.join(PLANNER, 'journal');
const SENTINEL = 'OVERNIGHT-AGENT do not edit this line';

function boardIds(file) {
  const p = path.join(PLANNER, file);
  if (!existsSync(p)) return new Set();
  const ids = new Set();
  for (const m of readFileSync(p, 'utf8').matchAll(/^\|\s*(\d+)[,\s|]/gm)) ids.add(m[1]);
  return ids;
}

// Same definition terminal-header-drift uses: the header a human reads at the top of
// the block = first `**Status:**` at/after the LAST sentinel, before the first chat marker.
function headerStatus(text) {
  const s = text.lastIndexOf(SENTINEL);
  if (s === -1) return null;
  const after = text.slice(s);
  const stop = after.search(/<!--\s*from:/i);
  const slice = stop === -1 ? after : after.slice(0, stop);
  const m = /^\*\*Status:\*\*\s*(.+)$/im.exec(slice);
  if (!m) return null;
  const line = m[0].trim();
  return { raw: m[1].trim(), status: normaliseStatus(m[1].trim()), date: statusStampDate(line) };
}

const active = boardIds('planner.md');
const completed = boardIds('planner-completed.md');

const rows = [];
let scanned = 0, noSentinel = 0, noHeader = 0, agree = 0;

for (const f of readdirSync(JOURNALS)) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  scanned++;
  const text = readFileSync(path.join(JOURNALS, f), 'utf8');
  if (!text.includes(SENTINEL)) { noSentinel++; continue; }
  const hdr = headerStatus(text);
  if (!hdr || !hdr.status) { noHeader++; continue; }
  const live = liveStatus(text);
  if (!live || !live.status) continue;
  if (live.source === 'block') { agree++; continue; }   // header IS the live line
  if (hdr.status === live.status) { agree++; continue; }

  const days = (hdr.date && live.effDate)
    ? Math.round((Date.parse(live.effDate) - Date.parse(hdr.date)) / 86400000)
    : null;

  rows.push({
    id,
    where: active.has(id) ? 'ACTIVE' : (completed.has(id) ? 'completed' : 'orphan'),
    header: hdr.status,
    headerDate: hdr.date,
    live: live.status,
    liveDate: live.effDate,
    via: live.source,
    staleDays: days,
    headerRaw: hdr.raw.replace(/\s+/g, ' ').slice(0, 80),
  });
}

rows.sort((a, b) => (b.staleDays ?? -1) - (a.staleDays ?? -1));

console.log(`journals scanned: ${scanned}`);
console.log(`  no sentinel/block: ${noSentinel}   header unparseable: ${noHeader}`);
console.log(`  header AGREES with live status: ${agree}`);
console.log(`  header DISAGREES with live status: ${rows.length}\n`);

const byWhere = {};
for (const r of rows) byWhere[r.where] = (byWhere[r.where] || 0) + 1;
console.log('by board:', JSON.stringify(byWhere), '\n');

for (const r of rows) {
  console.log(
    `#${r.id.padEnd(4)} ${r.where.padEnd(9)} header=${String(r.header).padEnd(11)} (${r.headerDate ?? '?'})  ` +
    `live=${String(r.live).padEnd(11)} (${r.liveDate ?? '?'}, ${r.via})  stale=${r.staleDays ?? '?'}d`);
  console.log(`      header line: ${r.headerRaw}`);
}
