// scan-outside-journal.mjs — one-off scope check (2026-08-26): does the
// backtick/`$` write-path corruption exist in agent-written markdown OUTSIDE the
// journal folder? `lost-interpolation-sweep` only scans `<planner>\journal`, so
// deliverables written into OneDrive project folders would be invisible to it.
import fs from 'node:fs';
import path from 'node:path';
import { scanText } from './lib-lost-interpolation.mjs';

const ROOTS = process.argv.slice(2);
const SKIP = /node_modules|\.git|AppData|\\packages\\/i;

let files = 0;
const flagged = [];

function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (SKIP.test(full)) continue;
    if (e.isDirectory()) walk(full, depth + 1);
    else if (/\.(md|html)$/i.test(e.name)) {
      files++;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const hits = scanText(text);
      if (hits.length) flagged.push({ full, hits });
    }
  }
}

for (const r of ROOTS) walk(r);

flagged.sort((a, b) => b.hits.filter((h) => h.strong).length - a.hits.filter((h) => h.strong).length);
console.log(`scanned ${files} .md/.html files under:\n  ${ROOTS.join('\n  ')}`);
console.log(`FLAGGED: ${flagged.length}\n`);
for (const f of flagged.slice(0, 20)) {
  const strong = f.hits.filter((h) => h.strong).length;
  console.log(`${f.full}  (${f.hits.length} lines, ${strong} strong)`);
  for (const h of f.hits.slice(0, 3)) console.log(`  ${h.strong ? '!!' : '  '} ${String(h.n).padStart(4)}: ${h.line.slice(0, 130)}`);
  console.log('');
}
