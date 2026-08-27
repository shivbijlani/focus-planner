// mutcheck-live-ask.mjs — mutation check for lib-live-ask.mjs
//
// Standing rule from the run learnings: "a checker that parses a hand-written format must
// accept every dialect that format actually appears in - and must be measured against live
// data before it is trusted." So this harness mixes SYNTHETIC cases (one per branch) with
// LITERAL strings pulled from the live backlog, and asserts both directions:
//   positives - the live ask is found, from the newest turn
//   negatives - a superseded ask is NEVER returned

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const A = '<!-- from: overnight-agent -->';
const U = '<!-- from: me -->';
const S = '---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  <- ${detail}` : ''}`); }
};

console.log('SYNTHETIC — one per branch\n');

// 1. Newest turn uses Needs from you: -> that wins.
check('newest-turn:needs',
  (() => {
    const r = liveAsk(`${A}\n**Needs from you:** old thing\n\n${A}\n**Needs from you:** new thing\n`);
    return r.ask === 'new thing' && r.source === 'newest-turn:needs';
  })());

// 2. THE BUG: newest turn asks via Next:, an older turn used Needs from you:.
check('older Needs is NOT lifted when newest turn uses Next:',
  (() => {
    const r = liveAsk(`${A}\n**Needs from you:** nothing - approve and I'll run it\n\n${A}\n**Next:** reply "lock it"\n`);
    return r.ask === 'reply "lock it"' && r.source === 'newest-turn:next';
  })(),
  'this is exactly #283');

// 3. Imperative Reply `x` outranks Next:.
check('newest-turn:reply outranks next',
  (() => {
    const r = liveAsk(`${A}\nSomething. Reply \`merge 168\` when ready.\n**Next:** I proceed\n`);
    return r.source === 'newest-turn:reply' && r.ask === 'Reply `merge 168`';
  })());

// 4. Your call: is the last-resort dialect.
check('newest-turn:yourcall is last resort',
  (() => {
    const r = liveAsk(`${A}\n**Your call:** approve / revise / skip\n`);
    return r.source === 'newest-turn:yourcall';
  })());

// 5. User spoke after the newest agent turn -> agent owes a reply, not an ask.
check('user-spoke-last suppresses the ask',
  (() => {
    const r = liveAsk(`${A}\n**Needs from you:** a decision\n\n## 2026-08-25\n${U}\ngo ahead\n`);
    return r.ask === null && r.source === 'user-spoke-last' && r.userSpokeLast === true;
  })());

// 6. No turn markers at all -> fall back to the block.
check('block fallback when there are no turn markers',
  (() => {
    const r = liveAsk(`# Task 1: x\n${S}\n**Status:** proposed\n**Needs from you:** the block ask\n`);
    return r.ask === 'the block ask' && r.source === 'block:needs';
  })());

// 7. Newest turn has no ask in any dialect -> block fallback, NOT the older turn.
check('empty newest turn falls back to block, never to an older turn',
  (() => {
    const r = liveAsk(`${S}\n**Needs from you:** block ask\n\n${A}\n**Needs from you:** stale turn ask\n\n${A}\njust prose, no ask marker\n`);
    return r.ask === 'block ask' && r.source === 'block:needs';
  })(),
  'must not return "stale turn ask"');

// 8. Dismissive text is returned verbatim (the CALLER decides what dismissal means, per #163).
check('dismissive ask returned verbatim, not swallowed',
  (() => {
    const r = liveAsk(`${A}\n**Needs from you:** none - but tell me if you'd rather I draft questions.\n`);
    return r.ask.startsWith('none -');
  })());

// 9. Empty marker value must not win over a real later dialect.
check('empty Needs value does not beat a real Next:',
  (() => {
    const r = liveAsk(`${A}\n**Needs from you:**\n**Next:** the real ask\n`);
    return r.ask === 'the real ask';
  })());

// 10. Nothing anywhere -> none.
check('no ask anywhere -> source none',
  (() => liveAsk('# Task 9: x\n\nsome prose\n').source === 'none')());

console.log('\nLIVE — real journals from the backlog\n');

const JOURNAL = path.join(
  process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner',
  'journal',
);
const read = (id) => fs.readFileSync(path.join(JOURNAL, `task-${id}.md`), 'utf8');

// #283 - the task that exposed the bug. Its ONLY `Needs from you:` is in turn 1 of 8.
{
  const r = liveAsk(read('283'));
  check('#283 does NOT report the turn-1 v1 ask',
    !/^nothing\s*[-—]\s*approve and I'll run it next overnight/i.test(r.ask || ''),
    `got: ${(r.ask || '').slice(0, 70)}`);
  check('#283 reports an ask from the NEWEST turn',
    r.source.startsWith('newest-turn') && r.turnIndex === r.turnCount,
    `source=${r.source} turn=${r.turnIndex}/${r.turnCount}`);
  // Phrasing is asserted loosely on purpose: the journal is live and gains turns, so a
  // brittle exact-string test would fail every time the task is worked. What must hold is
  // (a) it is NOT the stale v1 ask and (b) it comes from the newest turn.
  check('#283 live ask is about locking the humble version',
    /lock\s+(the\s+)?humble/i.test(r.ask || ''),
    `got: ${(r.ask || '').slice(0, 90)}`);
}

// #419 - turn 1 of 11 said "none. Drop media into ..."; that must not be reported as live.
{
  const r = liveAsk(read('419'));
  check('#419 does NOT report the turn-1 "none. Drop media" ask',
    !/^none\.\s*Drop media into the appropriate OneDrive route folder/i.test(r.ask || ''),
    `got: ${(r.ask || '').slice(0, 70)}`);
}

// #276 - ask was being lifted from turn 30 of 40.
{
  const r = liveAsk(read('276'));
  check('#276 ask comes from its newest turn (or is honestly null)',
    r.source === 'none' || r.source === 'user-spoke-last' || r.turnIndex === r.turnCount,
    `source=${r.source} turn=${r.turnIndex}/${r.turnCount}`);
}

// Corpus-wide invariant: never attribute an ask to a superseded turn.
{
  let bad = 0;
  let examined = 0;
  for (const f of fs.readdirSync(JOURNAL)) {
    if (!/^task-\d+\.md$/.test(f)) continue;
    const r = liveAsk(fs.readFileSync(path.join(JOURNAL, f), 'utf8'));
    examined++;
    if (r.source.startsWith('newest-turn') && r.turnIndex !== r.turnCount) bad++;
  }
  check(`corpus invariant: 0 asks attributed to a superseded turn (${examined} journals)`,
    bad === 0, `${bad} violations`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
