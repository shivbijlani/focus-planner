// Body-vs-header drift: drift-sweep's [D] bucket parses only the agent block HEADER,
// so a journal whose BODY concludes "done" while its header still says in-progress is
// structurally invisible to it. That is how #371 sat wrong for 34 days (2026-08-25 11:00).
// This checks the body's own terminal conclusions against oa-state.
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
const JOURNALS = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const activeIds = [...board.matchAll(/^\|\s*(\d+)[,\s|]/gm)].map(m => m[1]);

// Phrases that mean the AGENT concluded the task is finished.
const rxTerminalBody = [
  /^\s*[-*]?\s*(?:\*\*)?Next(?:\*\*)?\s*:\s*(?:\*\*)?\s*(complete|completed|done|nothing further|no further)/im,
  /Marking\s+(?:it\s+)?\*{0,2}(done|complete|closed)\*{0,2}/i,
  /###?\s*Status:\s*closed/i,
  /\bstays closed\b/i,
  /\bthis task is (now )?(complete|done|closed)\b/i,
];

const rows = [];
for (const id of activeIds) {
  const sf = path.join(stateDir, `task-${id}.json`);
  if (!fs.existsSync(sf)) continue;
  let st;
  try { st = JSON.parse(fs.readFileSync(sf, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error(`PARSE FAIL ${id}: ${e.message}`); continue; }
  if (st.status === 'done' || st.status === 'skip') continue;   // header already terminal

  const jf = path.join(JOURNALS, `task-${id}.md`);
  if (!fs.existsSync(jf)) continue;
  const text = fs.readFileSync(jf, 'utf8');
  const si = text.indexOf('OVERNIGHT-AGENT do not edit this line');
  const block = si >= 0 ? text.slice(si) : text;

  // Scope to the NEWEST Run-log entry only. Matching the whole block false-positives on
  // tasks that legitimately concluded once and were then reopened with more scope
  // (verified 2026-08-25 on #422 and #393 - both clean, both flagged by the loose version).
  const entries = [...block.matchAll(/^\*\*\d{4}-\d{2}-\d{2}\b.*$/gm)];
  const scope = entries.length
    ? block.slice(entries[entries.length - 1].index)
    : block;

  const hits = [];
  for (const rx of rxTerminalBody) {
    const m = rx.exec(scope);
    if (m) hits.push(m[0].replace(/\s+/g, ' ').trim().slice(0, 60));
  }
  if (!hits.length) continue;

  // Header line as recorded in the journal, for the comparison.
  const hm = /^\*\*Status:\*\*\s*(.+)$/im.exec(block);
  rows.push({ id, state: st.status, header: hm ? hm[1].slice(0, 60) : '(none)', hits });
}

console.log(`open board tasks with a TERMINAL conclusion in the body but a non-terminal header/state: ${rows.length}\n`);
for (const r of rows) {
  console.log(`#${r.id}  state=${r.state}`);
  console.log(`   header: ${r.header}`);
  for (const h of r.hits) console.log(`   body:   "${h}"`);
  console.log('');
}
