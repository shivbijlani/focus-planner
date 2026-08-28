// mutcheck-live-ask-unstamped.mjs
//
// Mutation check for the UNSTAMPED-TURN recovery added to lib-live-ask.mjs on 2026-08-28.
//
// THE DEFECT
// ----------
// `write-turn.ps1` appends a turn body verbatim; it does not add the
// `<!-- from: overnight-agent -->` provenance marker (it only refuses a STRAY one, guard
// G4). So a turn authored as `## 🌙 Overnight Agent` with the marker omitted is a real,
// delivered agent reply carrying no marker.
//
// The bridge sees it — `latestAgentTurn()` accepts the heading as a turn start, so it
// posts to Telegram normally. `liveAsk` did not: its marker scan saw the user's message as
// the newest thing and returned `userSpokeLast: true, ask: null`. Every consumer keyed on
// liveAsk (~15 sweeps) then skipped the task, because they all begin `if (!ask) continue`.
//
// Measured when found: 5 active non-terminal tasks fully invisible — #323, #422, #446,
// #448 (which carries the top merge asks) and #462. Over all 239 journals the fix gains
// 6 asks, loses 0, and moves 1 (#461) onto its newer turn.
//
// WHAT THIS FILE PINS
// -------------------
// 1. the recovery works, and works for a heading that carries a suffix (the bridge matches
//    with `startsWith`; a line-exact match misses `## 🌙 Overnight Agent — the PARs doc…`);
// 2. every guard is load-bearing — removed, a fixture that is correct today must go wrong;
// 3. the ADDITIVE property, which is the actual safety claim: the change can only ever
//    restore a hidden ask, never remove or reinterpret one that was already reported.
//
// liveAsk is a pure function of the journal text, so this needs no planner sandbox — but
// per the 2026-08-26 04:30 rule it touches no real file either way.

import fs from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const LIB = path.join(DIR, 'lib-live-ask.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- fixtures
const HEAD = '## \u{1F319} Overnight Agent';

function journal({ suffix = '', ask = '**Needs from you:** one word — **`go`**.', headingAfterUser = true, stampReply = false } = {}) {
  const top = [
    '# Task 999: Fixture',
    '',
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '',
    HEAD,
    '',
    '**Status:** In progress · 2026-08-20',
    '',
    '<!-- from: overnight-agent -->',
    '',
    '### An earlier, properly stamped turn',
    '',
    '**Needs from you:** the OLD ask that must never win.',
    '',
  ];
  const userMsg = ['## 2026-08-28', '', '<!-- from: me -->', 'Do the thing.', ''];
  const reply = [
    ...(stampReply ? ['<!-- from: overnight-agent -->', ''] : []),
    HEAD + suffix,
    '',
    '**Status:** in-progress · 2026-08-28',
    '',
    '### Did the thing',
    '',
    ask,
    '',
  ];
  return headingAfterUser
    ? [...top, ...userMsg, ...reply].join('\n')
    : [...top, ...reply, ...userMsg].join('\n');
}

// Load a (possibly mutated) copy of the library. Mutants are written next to the original
// and removed afterwards; a cache-busting query keeps ESM from returning a stale module.
let seq = 0;
async function load(mutate) {
  if (!mutate) return import(`./lib-live-ask.mjs?v=${seq++}`);
  const src = fs.readFileSync(LIB, 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('mutation was a no-op — the anchor text moved');
  const p = path.join(DIR, `_mut-lla-${process.pid}-${seq}.mjs`);
  fs.writeFileSync(p, out, 'utf8');
  try {
    return await import(`./_mut-lla-${process.pid}-${seq++}.mjs`);
  } finally {
    // deleted after import resolves; the module is already in memory
    setTimeout(() => fs.rmSync(p, { force: true }), 0);
  }
}

// ================================================================ 1. the recovery works
{
  const { liveAsk } = await load();
  const r = liveAsk(journal());
  check('recovers the ask from an unstamped reply', r.ask === 'one word — **`go`**.', JSON.stringify(r.ask));
  check('labels the source `unstamped-turn`', r.source.startsWith('unstamped-turn'), r.source);
  check('no longer claims the user spoke last', r.userSpokeLast === false, String(r.userSpokeLast));
  check('does NOT return the older stamped turn\'s ask', !/OLD ask/.test(r.ask || ''), r.ask || '');
}
{
  // #446's real shape: the heading carries a suffix. The bridge matches with `startsWith`.
  const { liveAsk } = await load();
  const r = liveAsk(journal({ suffix: ' — the PARs doc, and why your comment is mechanically true' }));
  check('heading WITH a suffix is still recognised (bridge parity)', r.source.startsWith('unstamped-turn'), r.source);
}

// ================================================================ 2. guards are load-bearing
{
  // Remove the whole branch: the primary fixture must go blind again.
  const { liveAsk } = await load((s) => s.replace(
    'if (lastUser > lastMarker && lastHead > lastUser) {',
    'if (false) {',
  ));
  const r = liveAsk(journal());
  check('load-bearing: without the branch the ask is hidden again', r.ask === null && r.userSpokeLast === true, `${r.source} / ${r.ask}`);
}
{
  // Line-exact heading match (what markerOffsets does) must MISS the suffixed heading —
  // proving `startsWith` is the load-bearing choice and not incidental.
  const { liveAsk } = await load((s) => s.replace(
    'if (line.startsWith(AGENT_HEADER)) out.push(off);',
    'if (line.trim() === AGENT_HEADER) out.push(off);',
  ));
  const r = liveAsk(journal({ suffix: ' — the PARs doc' }));
  check('load-bearing: line-exact matching loses the suffixed heading', r.ask === null, `${r.source} / ${r.ask}`);
  // control: the UNsuffixed fixture still works under the mutant, so the assertion above
  // isolates the suffix and not some unrelated breakage.
  const ok = liveAsk(journal());
  check('load-bearing control: line-exact still handles a bare heading', ok.source.startsWith('unstamped-turn'), ok.source);
}
{
  // Drop the ordering condition: a heading ABOVE the user's message must not be mistaken
  // for a reply to it.
  const { liveAsk } = await load((s) => s.replace('lastHead > lastUser', 'lastHead > -1'));
  const r = liveAsk(journal({ headingAfterUser: false }));
  check('load-bearing: without the ordering test an older heading wins', r.source.startsWith('unstamped-turn'), r.source);
}

// ================================================================ 3. no behaviour change
{
  const { liveAsk } = await load();
  const r = liveAsk(journal({ headingAfterUser: false }));
  check('unchanged: heading above the user message -> user-spoke-last', r.userSpokeLast === true && r.ask === null, `${r.source} / ${r.ask}`);
}
{
  const { liveAsk } = await load();
  const r = liveAsk(journal({ stampReply: true }));
  check('unchanged: a properly STAMPED reply still resolves as newest-turn', r.source.startsWith('newest-turn'), r.source);
}
{
  // ADDITIVE property: an unstamped reply carrying NO ask must fall through to the
  // original verdict rather than inventing one or silently flipping userSpokeLast.
  const { liveAsk } = await load();
  const r = liveAsk(journal({ ask: 'Nothing further — recorded for the log.' }));
  check('additive: an ask-less unstamped reply keeps the old verdict', r.userSpokeLast === true && r.ask === null, `${r.source} / ${r.ask}`);
}
{
  // ADDITIVE property over the REAL corpus, if it is present: no journal may LOSE an ask.
  // This is the whole safety claim, so it is asserted against live data, read-only.
  //
  // "Before" is derived by REVERSE-MUTATING the live library (disabling the new branch)
  // rather than by keeping a snapshot file around: a snapshot would rot the moment the
  // library changed again, and would sit unregistered in the checks corpus.
  const planner = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
  const jdir = path.join(planner, 'journal');
  if (fs.existsSync(jdir)) {
    const A = await load((s) => s.replace(
      'if (lastUser > lastMarker && lastHead > lastUser) {',
      'if (false) {',
    ));
    const B = await load();
    let lost = 0; let gained = 0; let n = 0;
    for (const f of fs.readdirSync(jdir)) {
      if (!/^task-\d+\.md$/.test(f)) continue;
      const t = fs.readFileSync(path.join(jdir, f), 'utf8');
      n++;
      const a = A.liveAsk(t).ask;
      const b = B.liveAsk(t).ask;
      if (a && !b) lost++;
      if (!a && b) gained++;
    }
    check(`additive on the live corpus: 0 asks lost across ${n} journals`, lost === 0, `lost=${lost}`);
    check('additive on the live corpus: asks were gained', gained > 0, `gained=${gained}`);
  } else {
    console.log('  (skipped live-corpus additivity: no planner journal dir on this machine)');
  }
}

// ================================================================ 4. hygiene
{
  await new Promise((r) => setTimeout(r, 50));
  const strays = fs.readdirSync(DIR).filter((f) => f.startsWith('_mut-lla-'));
  check('hygiene: no mutant files left behind', strays.length === 0, strays.join(', '));
}

console.log(`mutcheck-live-ask-unstamped: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail ? 1 : 0);
