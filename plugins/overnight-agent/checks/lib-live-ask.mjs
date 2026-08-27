// lib-live-ask.mjs — shared "what is this task's LIVE ask?" extractor.
//
// WHY THIS EXISTS (found 2026-08-25 21:00 PT on #283)
// --------------------------------------------------
// `declared-unblocked-sweep` and `inprogress-stall-sweep` both answered "what is this
// task asking for?" with:
//
//     const ask = [...text.matchAll(/\*\*Needs from you.*:\*\*\s*(.+)/g)].pop()
//
// i.e. the LAST `Needs from you:` marker ANYWHERE in the file. A journal is a
// bottom-appended chat thread of many agent turns, and a turn may legitimately ask via a
// different dialect (`Next:`, `Your call:`, an imperative ``Reply `x` ``). So whenever the
// NEWEST turn does not happen to use the `Needs from you:` dialect, that "last match" is
// silently lifted out of an OLDER, superseded turn and reported as if it were live.
//
// Measured over the live backlog: 12 of 49 active non-terminal tasks (24.5%) were
// mis-attributed, up to 10 turns stale. #283 was the visible casualty — its v1 ask from
// 2026-06-16 ("nothing - approve and I'll run it next overnight") was reported as live
// while the real turn-8 ask is "reply **lock the humble version**". Both sweeps therefore
// concluded "the agent owes the move and needs nothing from Shiv" about a task that is
// genuinely waiting on his decision.
//
// This is the SAME "stale operative line" pattern that has repeatedly bitten task work —
// only here the victims were the checkers themselves.
//
// SEMANTICS
// ---------
// The ask is read from the NEWEST agent turn only, using the Telegram digest's own
// priority order (`Needs from you:` -> imperative ``Reply `x` `` -> `Next:` -> `Your call:`).
// If the newest turn carries no ask in any dialect, we fall back to the agent BLOCK
// (the sentinel region, where SKILL.md's template puts `Needs from you:`) and say so.
// We deliberately never fall back to "last match anywhere": reporting "no live ask" is
// more honest than reporting a superseded one, and a wrong negative here is cheap
// (it removes a row from a report) while a wrong positive is expensive (it tells a run
// the agent owes a move it does not owe).

const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';
const SENTINEL = '<!-- OVERNIGHT-AGENT';

// EXACT copies of the bridge's markers - do not tighten.
const rxNeeds = /^\s*\*{0,2}Needs from you\b[^:]*:\*{0,2}\s*(.*)$/i;
const rxNext = /^\s*[-*]?\s*\*{0,2}Next:\*{0,2}\s*(.*)$/i;
const rxYourCall = /^\s*\*{0,2}Your call:\*{0,2}\s*(.*)$/i;
const rxReplyImperative = /(?:^|\s)Reply\s+`([^`]+)`/i;

function allIndexes(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

// Pull the best ask out of one slice of text, in the digest's priority order.
// Returns the ask, its source, and its CONTEXT (the ask line plus a few following lines
// from the SAME slice) - asks routinely wrap, and a caller scanning for trigger words
// needs the continuation without being allowed to wander into an older turn.
function askFromSlice(slice, sourcePrefix) {
  const lines = slice.split(/\r?\n/);
  const ctx = (i) => lines.slice(i, i + 4).join(' ').trim();

  let needs = null; let needsAt = -1;
  let next = null; let nextAt = -1;
  let yourCall = null; let callAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = rxNeeds.exec(line)) && m[1].trim()) { needs = m[1].trim(); needsAt = i; }
    else if ((m = rxYourCall.exec(line)) && m[1].trim()) { yourCall = m[1].trim(); callAt = i; }
    else if ((m = rxNext.exec(line)) && m[1].trim()) { next = m[1].trim(); nextAt = i; }
  }
  if (needs) return { ask: needs, source: `${sourcePrefix}:needs`, context: ctx(needsAt) };

  const imp = rxReplyImperative.exec(slice);
  if (imp) {
    const at = lines.findIndex((l) => rxReplyImperative.test(l));
    return {
      ask: `Reply \`${imp[1]}\``,
      source: `${sourcePrefix}:reply`,
      context: at >= 0 ? ctx(at) : slice.slice(0, 400),
    };
  }

  if (next) return { ask: next, source: `${sourcePrefix}:next`, context: ctx(nextAt) };
  if (yourCall) return { ask: yourCall, source: `${sourcePrefix}:yourcall`, context: ctx(callAt) };
  return null;
}

/**
 * @param {string} text raw journal markdown
 * @returns {{ask:string|null, source:string, context:string, turnIndex:number,
 *            turnCount:number, userSpokeLast:boolean}}
 */
export function liveAsk(text) {
  const turns = allIndexes(text, AGENT);
  const users = allIndexes(text, USER);
  const lastUser = users.length ? users[users.length - 1] : -1;
  const turnCount = turns.length;

  // The user spoke after the agent's last turn: the agent owes a REPLY, not an ask.
  if (turnCount && lastUser > turns[turnCount - 1]) {
    return {
      ask: null, source: 'user-spoke-last', context: '',
      turnIndex: turnCount, turnCount, userSpokeLast: true,
    };
  }

  if (turnCount) {
    const slice = text.slice(turns[turnCount - 1]);
    const hit = askFromSlice(slice, 'newest-turn');
    if (hit) return { ...hit, turnIndex: turnCount, turnCount, userSpokeLast: false };
  }

  // Fallback: the agent block itself (SKILL.md's template writes the ask there, and a
  // journal may have a block but no `from:` turn markers at all). Mirrors the digest's
  // own agent-block fallback (#162).
  const s = text.lastIndexOf(SENTINEL);
  if (s !== -1) {
    // Stop at the first chat entry below the block so we don't re-enter older turns.
    let end = text.length;
    for (const idx of [...turns, ...users]) if (idx > s && idx < end) end = idx;
    const hit = askFromSlice(text.slice(s, end), 'block');
    if (hit) return { ...hit, turnIndex: 0, turnCount, userSpokeLast: false };
  }

  return { ask: null, source: 'none', context: '', turnIndex: turnCount, turnCount, userSpokeLast: false };
}
