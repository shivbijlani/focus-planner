// artifact-index.mjs — the registry of everything this agent created OUTSIDE the planner folder,
// plus the cheap lookup a run does BEFORE asking Shiv for a date, a destination or a decision.
//
// Usage:
//   node artifact-index.mjs build            -> writes artifact-index.json, prints a summary
//   node artifact-index.mjs query dubai nov  -> artifacts matching ALL terms (entity/context/date)
//   node artifact-index.mjs task 310         -> everything task #310 created outside the planner
//
// See lib-external-artifacts.mjs for why this exists (#228 asked for two months about a date that
// #310 had already put on Shiv's calendar).
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './lib-external-artifacts.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');
const OUT = path.join(process.env.LOCALAPPDATA || '.', 'overnight-agent', 'artifact-index.json');

const cmd = process.argv[2] || 'build';
const args = process.argv.slice(3).map(s => s.toLowerCase());

function load() {
  if (fs.existsSync(OUT)) {
    try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).artifacts; } catch { /* rebuild */ }
  }
  return buildIndex(JDIR);
}

if (cmd === 'build') {
  const artifacts = buildIndex(JDIR);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), artifacts }, null, 2));
  const byKind = {};
  const tasks = new Set();
  for (const a of artifacts) { byKind[a.kind] = (byKind[a.kind] || 0) + 1; tasks.add(a.task); }
  console.log(`indexed ${artifacts.length} external artifacts from ${tasks.size} tasks`);
  for (const [k, n] of Object.entries(byKind).sort()) console.log(`  ${k.padEnd(10)} ${n}`);
  const dated = artifacts.filter(a => a.dates.length);
  console.log(`  (${dated.length} carry at least one date)`);
  console.log(`\nwritten to ${OUT}`);
  process.exit(0);
}

if (cmd === 'task') {
  const id = args[0];
  const hits = load().filter(a => a.task === String(id));
  console.log(`#${id} created ${hits.length} external artifact(s):`);
  for (const a of hits) console.log(`  [${a.kind}] ${a.url}\n      ${a.context}`);
  process.exit(0);
}

if (cmd === 'query') {
  if (!args.length) { console.error('usage: artifact-index.mjs query <term> [term...]'); process.exit(1); }
  const hits = load().filter(a => {
    const hay = `${a.context} ${a.entities.join(' ')} ${a.dates.join(' ')}`.toLowerCase();
    return args.every(t => hay.includes(t));
  });
  console.log(`query [${args.join(' ')}] -> ${hits.length} artifact(s)`);
  for (const a of hits.sort((x, y) => Number(x.task) - Number(y.task))) {
    console.log(`\n  #${a.task} [${a.kind}]${a.dates.length ? '  dates: ' + a.dates.join(', ') : ''}`);
    console.log(`      ${a.context}`);
    console.log(`      ${a.url}`);
  }
  process.exit(hits.length ? 0 : 0);
}

console.error(`unknown command: ${cmd}`);
process.exit(1);
