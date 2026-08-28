// Measures how many tasks are held in the approval digest purely because their
// latest turn ends with a terminal "Next:" line (e.g. "Next: complete") that
// extractAskEntry() classifies as a STRONG ask and therefore honours on any status.
// Context: GH #174 (strong ask on a terminal block).
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
const SRC = process.env.BRIDGE_SRC;
if (!PLANNER || !SRC) {
  console.error('Set PLANNER_PATH and BRIDGE_SRC (file:/// URL to telegram-bridge/src)');
  process.exit(1);
}

const journalMod = await import(`${SRC}/journal.js`);
const digestMod = await import(`${SRC}/digest.js`);
const { latestAgentTurn, agentBlockStatus, agentBlockText } = journalMod;
const { extractAskEntry } = digestMod;
for (const [n, fn] of Object.entries({ latestAgentTurn, agentBlockStatus, agentBlockText, extractAskEntry })) {
  if (typeof fn !== 'function') throw new Error(`import failed: ${n} is ${typeof fn}`);
}

const TERMINAL_STATUS = new Set(['done', 'skip', 'complete', 'completed', 'closed']);
// Words that mean "there is nothing left to do", not "here is what I need from you".
const TERMINAL_ASK = /^[\s*_.:-]*(complete|completed|done|none|nothing|n\/a)\b[\s*_.!]*$/i;

const dir = path.join(PLANNER, 'journal');
const files = fs.readdirSync(dir).filter(f => /^task-\d+\.md$/.test(f));

const rows = [];
for (const f of files) {
  const id = f.match(/^task-(\d+)\.md$/)[1];
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  let status = null, turn = null, ask = null;
  const block = agentBlockText(text);
  if (!block) continue;
  status = agentBlockStatus(block);
  turn = latestAgentTurn(text);
  ask = turn ? extractAskEntry(turn) : null;
  if (!ask && block) ask = extractAskEntry(block); // mirror syncDigest()'s block fallback
  if (!ask || !ask.text) continue;
  const isTerminalStatus = TERMINAL_STATUS.has(String(status || '').toLowerCase());
  const asksNothing = TERMINAL_ASK.test(ask.text);
  if (asksNothing) {
    rows.push({
      id, status: status || '<null>', source: ask.source,
      weak: !!ask.weak, text: ask.text.trim().slice(0, 40), terminalStatus: isTerminalStatus
    });
  }
}

rows.sort((a, b) => Number(a.id) - Number(b.id));
console.log(`journals scanned                  : ${files.length}`);
console.log(`asks that actually ask for NOTHING: ${rows.length}`);
const onTerminal = rows.filter(r => r.terminalStatus);
console.log(`  ...of those, on a TERMINAL block: ${onTerminal.length}  <-- settled work still in the queue`);
console.log(`  ...on a non-terminal block      : ${rows.length - onTerminal.length}`);
console.log('');
console.log('id    status        weak   source  ask text');
for (const r of rows) {
  const flag = r.terminalStatus ? '*' : ' ';
  console.log(`${flag}${r.id.padEnd(5)} ${String(r.status).padEnd(13)} ${String(r.weak).padEnd(6)} ${String(r.source).padEnd(7)} ${JSON.stringify(r.text)}`);
}
console.log('');
console.log('* = terminal status: these are finished tasks whose only "ask" is the word "complete".');
