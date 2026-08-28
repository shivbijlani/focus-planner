// regressive-ask-sweep.mjs — find agent blocks whose ASK regresses on the journal's OWN history.
//
// WHY THIS EXISTS
// ---------------
// Found live 2026-08-26 on #293. Its block (2026-08-23) said:
//
//     "This journal had no agent block, so it never surfaced in the approval queue"
//     "Needs from you: forward the *homewise* conversation ... and confirm which
//      browser slot is signed into the Google account"
//
// while TEN agent turns sat above the sentinel, the homewise thread had been in the
// agent inbox since 2026-06-24, four `task-293-*` deliverables had already been built
// FROM it, and the 06-24 turn already named the slot (MCP Edge bijlanis / CDP 9228).
// Both halves of the ask were dead on arrival, and the task sat blocked for two months.
//
// This is NOT the same as the existing detectors:
//   - body/terminal-header-drift compare the block against the NEWEST turn.
//   - block-newer-scope compares Status-line DATES.
//   - undelivered-plan/reversible-gate ask whether the PLAN was delivered.
// None of them look BACKWARDS from the block into the pre-sentinel history, which is
// exactly where the contradicting evidence lived. A block written from the top-of-file
// user note alone is invisible to every one of them.
//
// Three arms, all mechanical and all self-evidencing (the proof is in the same file):
//   A amnesia    — block claims there is no prior agent history, but there is.
//   B slot re-ask— block asks WHICH browser slot, but history already names one.
//   C stale grab — block asks the user to forward/paste/send source material, but a
//                  pre-sentinel turn already references a deliverable built from it.
//
// Block boundaries are matched LINE-EXACTLY (never indexOf/includes): journals
// legitimately quote their own markers, and the tasks most likely to do so are the
// ones about the format itself. See the 2026-08-26 06:30 addendum.
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';

const TERMINAL = new Set(['done', 'skip', 'complete', 'completed', 'closed']);

function boardIds(file) {
  const set = new Set();
  if (!fs.existsSync(file)) return set;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(\d{1,6})\b/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

// Line-exact block extraction, matching the telegram-bridge's agentBlockText semantics:
//   <!-- from: me -->              -> block is over, ALWAYS
//   <!-- from: overnight-agent --> -> only a real chat entry once a "## <date>" was seen
function splitAtSentinel(text) {
  const lines = text.split('\n');
  let s = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(SENTINEL)) s = i;
  if (s === -1) return null;
  const before = lines.slice(0, s);
  const rest = lines.slice(s);
  const body = [];
  let sawDate = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].trim();
    if (t === USER) break;
    if (t === AGENT && sawDate) break;
    if (/^##\s+\d{4}-\d{2}-\d{2}/.test(t)) sawDate = true;
    body.push(rest[i]);
  }
  return { before: before.join('\n'), block: body.join('\n') };
}

function blockStatus(block) {
  const m = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m.exec(block);
  return m ? m[1].trim().toLowerCase().replace(/[*_`]/g, '').trim() : null;
}

// A block that RETRACTS an amnesia claim necessarily quotes it. Matching the raw text
// therefore flags the fix as the defect -- the same trap as the #267 false positive
// ("your checker must use the parser's own matching semantics"), one level up: here the
// distinction is assertion vs. quotation. An amnesia CLAIM is unquoted prose; a
// retraction sits inside quote marks or a blockquote. So strip those spans first.
function unquoted(text) {
  return text
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n')
    .replace(/[""][\s\S]{0,400}?[""]/g, ' ')
    .replace(/"[^"\n]{0,400}"/g, ' ');
}

function askText(block) {
  const m = /\*\*Needs from you:?\*\*([\s\S]{0,700})/i.exec(block);
  return m ? m[1] : '';
}

const active = boardIds(path.join(PLANNER, 'planner.md'));

const rxAmnesia = /(had no agent block|has no agent block|there was no agent block|never surfaced in the approval queue|no prior agent (?:turns?|history)|first agent turn on this task)/i;
const rxSlotAsk = /(which browser slot|confirm which .{0,30}slot|which .{0,20}slot is signed|which slot is signed)/i;
const rxSlotNamed = /(CDP\s*9\d{3}|MCP\s+(?:Edge|Chrome)\s+[A-Za-z0-9-]+)/i;
const rxGrab = /\b(forward|paste|send me|drop (?:the|a)\b)/i;

let considered = 0;
const flagged = [];

for (const f of fs.readdirSync(JDIR).sort()) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');
  const parts = splitAtSentinel(text);
  if (!parts) continue;

  const status = blockStatus(parts.block) || '';
  const short = status.split(/[\s·|]+/)[0] || '';
  if (TERMINAL.has(short)) continue;            // settled work is not an open ask
  considered++;

  const preTurns = parts.before.split('\n').filter(l => l.trim() === AGENT).length;
  if (preTurns === 0) continue;                 // no history to regress ON

  const ask = askText(parts.block);
  const reasons = [];

  if (rxAmnesia.test(unquoted(parts.block))) {
    reasons.push(`A amnesia: block claims no prior agent history, but ${preTurns} agent turn(s) sit above the sentinel`);
  }
  if (rxSlotAsk.test(ask) && rxSlotNamed.test(parts.before)) {
    const named = rxSlotNamed.exec(parts.before)[0];
    reasons.push(`B slot re-ask: asks which browser slot, but history already names "${named}"`);
  }
  if (rxGrab.test(ask)) {
    // Only a regression if earlier turns already built something from that material.
    const deliverables = fs.readdirSync(JDIR).filter(x => x.startsWith(`task-${id}-`));
    const cited = deliverables.filter(d => parts.before.includes(d));
    if (cited.length) {
      reasons.push(`C stale grab: asks the user to forward/paste source material, but ${cited.length} deliverable(s) already built from it are cited above: ${cited.join(', ')}`);
    }
  }

  if (reasons.length) {
    flagged.push({ id, status: short, onBoard: active.has(id), preTurns, reasons, ask: ask.replace(/\s+/g, ' ').trim().slice(0, 150) });
  }
}

console.log(`considered (has a sentinel block, non-terminal): ${considered}`);
console.log(`FLAGGED — block's ask regresses on the journal's own earlier turns: ${flagged.length}`);
for (const r of flagged.sort((a, b) => Number(a.id) - Number(b.id))) {
  console.log(`\n  #${r.id}${r.onBoard ? ' [board]' : ''}  status=${r.status}  preTurns=${r.preTurns}`);
  for (const why of r.reasons) console.log(`      ${why}`);
  console.log(`      ask: ${r.ask}`);
}
if (flagged.length) process.exit(1);
