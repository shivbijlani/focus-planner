// Sweep: open board plans whose agent block contains an IRREVERSIBLE trigger AND a date
// already in the past. Established 2026-08-25 10:45 PT (#328 would have bought shoes for a
// wedding a fortnight gone). Victims so far: #445, #432, #328, #423.
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
const JOURNALS = path.join(PLANNER, 'journal');
// ⚠️ Derived at run time, never hardcoded — see the parked-age.mjs note (2026-08-26).
const TODAY = new Date((process.env.OA_TODAY || new Date().toISOString().slice(0, 10)) + 'T00:00:00-07:00');

const rxTrigger = /\b(buy it|place the order|order it|purchase it|book it|send it|ship it|pay it|checkout|check out|merge it|approve memos)\b/gi;
const rxDate = /\b(20\d\d)-(\d{2})-(\d{2})\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b/gi;

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const activeIds = [...board.matchAll(/^\|\s*(\d+)[,\s|]/gm)].map(m => m[1]);

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const results = [];

for (const id of activeIds) {
  const sf = path.join(stateDir, `task-${id}.json`);
  if (!fs.existsSync(sf)) continue;
  let st;
  try { st = JSON.parse(fs.readFileSync(sf, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error(`PARSE FAIL ${id}: ${e.message}`); continue; }
  if (st.status === 'done' || st.status === 'skip') continue;

  const jf = path.join(JOURNALS, `task-${id}.md`);
  if (!fs.existsSync(jf)) continue;
  const text = fs.readFileSync(jf, 'utf8');

  // agent block only: from the sentinel to EOF
  const si = text.indexOf('OVERNIGHT-AGENT do not edit this line');
  const block = si >= 0 ? text.slice(si) : text;

  const triggers = [...block.matchAll(rxTrigger)].map(m => m[0].toLowerCase());
  if (!triggers.length) continue;

  const pastDates = [];
  for (const m of block.matchAll(rxDate)) {
    let d;
    if (m[1]) d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00-07:00`);
    else {
      const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
        .indexOf(m[4].slice(0, 3).toLowerCase());
      if (mon < 0) continue;
      d = new Date(2026, mon, Number(m[5]));
    }
    if (!isNaN(d) && d < TODAY) pastDates.push(m[0]);
  }
  if (!pastDates.length) continue;

  results.push({
    id, status: st.status,
    nTrig: triggers.length, nPast: new Set(pastDates).size,
    trig: [...new Set(triggers)].slice(0, 4).join(', '),
    dates: [...new Set(pastDates)].slice(0, 5).join(', '),
  });
}

results.sort((a, b) => (b.nTrig * b.nPast) - (a.nTrig * a.nPast));
console.log(`open board plans scanned; flagged ${results.length}\n`);
for (const r of results) {
  console.log(`#${r.id} [${r.status}] triggers=${r.nTrig} pastDates=${r.nPast}`);
  console.log(`     trig: ${r.trig}`);
  console.log(`     past: ${r.dates}`);
}
