// Armed-trigger detector: the LIVE ask is what a one-word reply actually executes. Only
// triggers in THAT ask are armed; trigger words buried in Run-log history are inert.
//
// ⚠️ Until 2026-08-25 21:20 PT this took the last `Needs from you:` / `Your call:` line
// ANYWHERE in the file and called it "the live ask" - so whenever the newest turn asked
// via another dialect it scanned a SUPERSEDED turn instead. On the sweep that answers
// "which irreversible, money-spending one-word replies are currently armed?", that could
// both invent an armed trigger and, worse, MISS a live one. Now scoped via lib-live-ask.
import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH;
const JOURNALS = path.join(PLANNER, 'journal');

const rxTrigger = /\b(buy it|buy them|place the order|order it|order them|purchase it|book it|send it|ship it|pay it|checkout|merge it|approve memos|submit it|post it)\b/i;

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const activeIds = [...board.matchAll(/^\|\s*(\d+)[,\s|]/gm)].map(m => m[1]);
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');

const armed = [];
for (const id of activeIds) {
  const sf = path.join(stateDir, `task-${id}.json`);
  if (!fs.existsSync(sf)) continue;
  let st;
  try { st = JSON.parse(fs.readFileSync(sf, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error(`PARSE FAIL ${id}: ${e.message}`); continue; }
  if (st.status === 'done' || st.status === 'skip') continue;

  const jf = path.join(JOURNALS, `task-${id}.md`);
  if (!fs.existsSync(jf)) continue;

  // The live ask plus its wrapped continuation, scoped to the newest turn.
  const { ask, source, context } = liveAsk(fs.readFileSync(jf, 'utf8'));
  if (!ask) continue;

  const hit = rxTrigger.exec(context || ask);
  if (!hit) continue;
  armed.push({ id, status: st.status, trigger: hit[0], source, ask: ask.slice(0, 150) });
}

console.log(`ARMED irreversible triggers in the live ask: ${armed.length}\n`);
for (const a of armed) {
  console.log(`#${a.id} [${a.status}]  trigger="${a.trigger}"  (${a.source})`);
  console.log(`     ask: ${a.ask}\n`);
}
