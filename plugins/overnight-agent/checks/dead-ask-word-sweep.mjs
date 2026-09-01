// dead-ask-word-sweep.mjs
//
// WHY: a defect class measured live on 2026-09-01 — `an ask nobody can answer`.
//
// The agent ends a turn by handing Shiv a command token to reply with:
//
//     **Needs from you:** one word — **repair board** — for the six mangled rows
//     and the two lost wake dates. #327 is due Thursday and will not fire without it.
//
// For anything on SKILL.md's ⛔ list the run is FORBIDDEN from acting on its own reading
// of that reply. It must ask `oa-state.ps1 consent`, and consent recognises approval only
// via one closed vocabulary — `$script:ConsentAffirmRe` (approve/yes/go ahead/go/lgtm/
// ship it/do it/vibe it/send it/make it so/proceed).
//
// `repair board` is not in it. So Shiv can read the ask, type exactly the word he was
// told to type, and the run still reads `human-spoke-but-no-affirmative` and refuses to
// act. The ask is dead on arrival, and nothing anywhere says so:
//
//   * to Shiv it looks answered — he replied;
//   * to the run it looks unanswered — no affirmative;
//   * to every sweep it looks like a normal open ask, because it IS a normal open ask.
//
// MEASURED COST when this was written: task #463 carried `repair board` across **eight
// consecutive nightly turns**. Two of the things it gates are wake dates that were
// destroyed by an earlier board rewrite — task #327 was set to resurface on 2026-09-04
// and will simply never fire. The ask had been re-issued, verbatim and unanswerable,
// every night since 2026-08-30. Three sibling tasks carried the same shape at the same
// time: #280 (`clean the rest`), #368 (`brief 206`), #399 (`build 127`).
//
// This is the same family as `reversible-gate-sweep` (asking for something that needed no
// approval) but the opposite failure: here approval genuinely IS needed, and the channel
// for granting it was closed by the agent's own choice of word.
//
// ---------------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH — the vocabulary is READ FROM THE CHECKER, never restated
// ---------------------------------------------------------------------------------
// The one thing that could make this sweep worse than useless is drifting from the
// checker it models: it would keep printing a confident `0` while the real gate rejected
// words this file believed were fine. That is the silent-degradation failure
// `reversible-gate-sweep`'s own header warns about ("a vocabulary matcher degrades
// SILENTLY: it keeps printing 0, and that 0 is indistinguishable from a clean night").
//
// So the affirmative pattern is PARSED OUT OF `oa-state.ps1` at run time. If it cannot be
// found, this sweep EXITS 1 WITH AN ERROR rather than falling back to a hard-coded copy —
// a guard that cannot verify its own premise must fail loudly, not guess.
//
// ---------------------------------------------------------------------------------
// TWO SEVERITIES, because not every non-affirmative token is a deadlock
// ---------------------------------------------------------------------------------
// `consent` is only consulted for ⛔ actions. When the ask gates something REVERSIBLE the
// run reads the prose itself and an odd word like `brief 206` is understood fine. Calling
// those a deadlock would cry wolf, and three checkers in this suite already have.
//
//   DEADLOCK — the ask names an irreversible action, so consent WILL be consulted, and
//              the instructed word cannot satisfy it. Shiv cannot approve this task.
//   soft     — reversible; prose reading still works. Reported, not failed on.
//
// Only DEADLOCK rows set the exit code.
//
// THE FIX, when this fires: keep the descriptive phrase and add a real affirmative to it
// — `reply **yes** (or **repair board**)`. Costs three characters and re-opens the channel.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');

// ---------------------------------------------------------------------------------
// Resolve the LIVE checker. Prefer the installed copy — that is the one that actually
// decides tonight — then the repo copy, so the sweep is runnable in CI off a checkout.
// ---------------------------------------------------------------------------------
function findConsentSource() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const candidates = [
    process.env.OA_STATE_PS1,
    path.join(process.env.LOCALAPPDATA || '', 'overnight-agent', 'oa-state.ps1'),
    path.join(
      process.env.USERPROFILE || '',
      '.copilot', 'installed-plugins', 'focus-planner',
      'overnight-agent', 'skills', 'overnight-agent', 'oa-state.ps1',
    ),
    path.resolve(here, '..', 'skills', 'overnight-agent', 'oa-state.ps1'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return { file: c, text: fs.readFileSync(c, 'utf8') };
    } catch { /* keep looking */ }
  }
  return null;
}

// Lift `$script:ConsentAffirmRe = '(?i)(...)'` and convert the PowerShell literal to a JS
// RegExp. Only the inline `(?i)` needs translating; lookbehind is native in Node 18+.
function affirmativeRegex(psText) {
  const m = psText.match(/\$script:ConsentAffirmRe\s*=\s*'((?:[^']|'')*)'/);
  if (!m) return null;
  const literal = m[1].replace(/''/g, "'");          // PowerShell doubles single quotes
  const body = literal.replace(/^\(\?i\)/, '');       // inline flag -> JS flag
  try {
    return { re: new RegExp(body, 'i'), literal };
  } catch {
    return null;
  }
}

const src = findConsentSource();
if (!src) {
  console.error('dead-ask-word-sweep: FATAL - could not locate oa-state.ps1 to read the');
  console.error('  affirmative vocabulary from. Refusing to guess: a hard-coded copy would');
  console.error('  drift from the real gate and report a false clean night.');
  console.error('  Set OA_STATE_PS1 to the checker you want modelled.');
  process.exit(1);
}
const affirm = affirmativeRegex(src.text);
if (!affirm) {
  console.error(`dead-ask-word-sweep: FATAL - found ${src.file} but could not parse`);
  console.error('  $script:ConsentAffirmRe out of it. The checker\'s shape changed; this');
  console.error('  sweep must be re-pointed rather than left silently reporting 0.');
  process.exit(1);
}

// ---------------------------------------------------------------------------------
// What the user is TOLD TO TYPE.
//
// Deliberately requires an instruction verb ("reply", "say", "type", "answer") governing
// the token, so an ordinary backticked identifier in prose is not mistaken for a command.
// `liveAsk` normalises the imperative dialect to ``Reply `x` ``, which this also matches.
// ---------------------------------------------------------------------------------
const INSTRUCTED = new RegExp(
  String.raw`\b(?:reply|replying|say|saying|type|answer|respond)\b(?:\s+(?:with|back|me))?` +
  String.raw`[^.\n]{0,48}?` +
  String.raw`(?:` +
    String.raw`\*\*\s*` + '`' + String.raw`([^` + '`' + String.raw`\n]{1,40})` + '`' + String.raw`\s*\*\*` +  // **`x`**
    String.raw`|` + '`' + String.raw`([^` + '`' + String.raw`\n]{1,40})` + '`' +                              // `x`
    String.raw`|\*\*([^*\n]{1,40})\*\*` +                                                                     // **x**
  String.raw`)`,
  'ig',
);

// Journal furniture that is never a command token.
const FURNITURE = /^(needs from you|your call|next|status|context|deliverables?|risks?)\b/i;

function norm(t) {
  return t.trim().replace(/^["'`]+|["'`.,!]+$/g, '').toLowerCase();
}

function instructedTokens(scope) {
  const out = [];
  for (const m of scope.matchAll(INSTRUCTED)) {
    const t = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!t) continue;
    if (FURNITURE.test(t)) continue;
    if (t.split(/\s+/).length > 5) continue;   // a sentence, not a token
    out.push(t);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------
// CARRIED ASKS — the second signal, and the one that catches the case this file is named
// after. Added immediately after the first live run, which reported a confident 3 and
// MISSED #463, the eight-night deadlock that motivated the sweep.
//
// Why it missed: an ask only carries its instruction verb the FIRST time. Once a turn has
// said "Reply **repair board** and it is done in the next run", every later turn shortens
// to a back-reference:
//
//     **Needs from you:** unchanged - **repair board**, for the six mangled rows ...
//
// There is no "reply" in that sentence, so a verb-governed matcher sees no command - and
// prints 0 for the longest-running deadlock on the board. That is precisely the silent
// degradation this file's own header warns about, reproduced on its first run.
//
// Reading bold spans out of the live ask instead is not the answer either: that same ask
// bolds `task #327's` and `Thursday`, which are facts, not commands. Guessing which bold
// span is imperative means a verb vocabulary, and the agent's word choice is free.
//
// So key on a FACT rather than on wording: a token is a command if THIS JOURNAL HAS
// ACTUALLY INSTRUCTED IT at some point ("reply/say/type X"), and the live ask still names
// it. The instruction is evidence the agent itself created; the recurrence is evidence the
// ask is still live. Neither is a guess about English.
const BOLD_OR_TICK = /\*\*\s*`([^`\n]{1,40})`\s*\*\*|`([^`\n]{1,40})`|\*\*([^*\n]{1,40})\*\*/g;

function namedTokens(scope) {
  const out = [];
  for (const m of scope.matchAll(BOLD_OR_TICK)) {
    const t = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!t) continue;
    if (FURNITURE.test(t)) continue;
    if (t.split(/\s+/).length > 5) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

// Every token this journal has ever explicitly told Shiv to reply with.
function everInstructed(text) {
  return new Set(instructedTokens(text).map(norm));
}

// Does this ask gate something on the ⛔ list? Only then is `consent` consulted, and only
// then is a non-affirmative token an actual deadlock. Board/file rewrites are included
// because the live agent-gate floor names "outcome can result in permanent data loss".
const IRREVERSIBLE = new RegExp(
  String.raw`\b(merge|merging|deploy|publish|release|push\s+to\s+main|force-?push` +
  String.raw`|send|sending|email|submit|post|buy|order|purchase|pay|spend` +
  String.raw`|delete|deleting|destroy|remove|repair\s+(?:the\s+)?board|rewrite|overwrite` +
  String.raw`|restore|migrate|wake\s+dates?|planner\.md|both\s+boards?)\b`,
  'i',
);

// ---------------------------------------------------------------------------------
const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const active = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) active.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA || '', 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);
const deadlocks = [];
const soft = [];
let considered = 0;

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!active.has(id)) continue;

  let status = '?';
  try {
    // oa-state.ps1 writes UTF-8 *with BOM*; JSON.parse throws without stripping it.
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    status = JSON.parse(raw).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');

  // The LIVE ask only - a superseded ask is not what Shiv is looking at.
  const { ask, context } = liveAsk(text);
  if (!ask) continue;
  considered++;

  const scope = context && context.length > ask.length ? context : ask;

  // SIGNAL 1 - the live ask itself instructs a word.
  const direct = instructedTokens(scope);
  // SIGNAL 2 - the live ask names a word this journal has previously instructed.
  const carriedSet = everInstructed(text);
  const carried = namedTokens(scope).filter((t) => carriedSet.has(norm(t)));

  const tokens = [...new Set([...direct, ...carried])];
  if (!tokens.length) continue;                       // no word was prescribed

  // If ANY prescribed token carries an affirmative, the channel is open.
  if (tokens.some((t) => affirm.re.test(t))) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 58);
  const via = direct.length ? (carried.length ? 'instructed+carried' : 'instructed') : 'carried';
  const row = { id, status, title, tokens, via, ask: ask.slice(0, 170) };
  if (IRREVERSIBLE.test(scope)) deadlocks.push(row); else soft.push(row);
}

const byId = (a, b) => Number(a.id) - Number(b.id);
deadlocks.sort(byId);
soft.sort(byId);

console.log(`vocabulary read from: ${src.file}`);
console.log(`affirmatives: ${affirm.literal.replace(/^\(\?i\)/, '').slice(0, 120)}`);
console.log(`considered (active, non-terminal, live ask): ${considered}`);
console.log(`DEADLOCK - ask gates an irreversible action with a word consent rejects: ${deadlocks.length}`);
console.log(`soft     - non-affirmative token, but the action is reversible: ${soft.length}\n`);

for (const h of deadlocks) {
  console.log(`#${h.id.padEnd(4)} ${h.status.padEnd(11)} ${h.title}`);
  console.log(`      told to reply: ${h.tokens.map((t) => `\`${t}\``).join(', ')}  <- none is an affirmative  [${h.via}]`);
  console.log(`      ask  : ${h.ask}`);
  console.log('      fix  : keep the phrase, add a real affirmative - reply **yes** (or **' + h.tokens[0] + '**)\n');
}
if (soft.length) {
  console.log('soft (reported, not failed on - prose reading still resolves these):');
  for (const h of soft) {
    console.log(`  #${h.id.padEnd(4)} ${h.tokens.map((t) => `\`${t}\``).join(', ')}  ${h.title}`);
  }
  console.log('');
}

process.exit(deadlocks.length ? 1 : 0);
