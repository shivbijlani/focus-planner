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
// EXACT copy of the bridge's AGENT_HEADER (journal.js:8). `latestAgentTurn()` accepts
// this heading as a turn start "whichever appears later", so to the bridge an unstamped
// turn IS a turn. See the unstamped-turn note in liveAskImpl for why that matters here.
const AGENT_HEADER = '## \u{1F319} Overnight Agent';

// EXACT copies of the bridge's markers - do not tighten.
const rxNeeds = /^\s*\*{0,2}Needs from you\b[^:]*:\*{0,2}\s*(.*)$/i;
const rxNext = /^\s*[-*]?\s*\*{0,2}Next:\*{0,2}\s*(.*)$/i;
const rxYourCall = /^\s*\*{0,2}Your call:\*{0,2}\s*(.*)$/i;
const rxReplyImperative = /(?:^|\s)Reply\s+`([^`]+)`/i;

// Marker offsets, matched LINE-EXACTLY: the marker must be the entire trimmed line.
//
// FIXED 2026-08-27. This used raw `indexOf`, so a marker QUOTED in prose — `` `<!-- from:
// me -->` `` inside a sentence explaining the journal format — counted as a real chat
// entry. Two live consequences, both silent:
//   * a quoted USER marker below the newest agent turn made `liveAsk` return
//     `userSpokeLast: true, ask: null`, hiding that task's ask from EVERY consumer.
//     Measured on the live corpus: 6 journals quote a user marker and 2 of them flip the
//     verdict — #448 (which carries the top three merge asks) and #267.
//   * a quoted AGENT marker manufactures a phantom turn, shifting every turn boundary
//     after it: 6 journals, incl. #349, #434 and #448 — the ask hubs.
//
// `regressive-ask-sweep` already learned exactly this ("journals legitimately quote their
// own markers, and the tasks most likely to do so are the ones about the format itself")
// and matches line-exactly. The shared library never got the same fix, so every caller
// inherited the bug. #267 — the task that produced the rule "your checker must use the
// parser's own matching semantics" — is one of the two victims.
function markerOffsets(text, marker) {
  const out = [];
  let off = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === marker) out.push(off);
    off += line.length + 1;
  }
  return out;
}

// Offsets of agent-block headings. Matched with `startsWith`, which is EXACTLY what the
// bridge's latestAgentTurn() does (journal.js:127) — headings legitimately carry a suffix
// (`## 🌙 Overnight Agent — the PARs doc, and why …`), and a line-exact match would miss
// those. Same rule as everywhere else in this file: model the parser, don't re-invent it.
function headerOffsets(text) {
  const out = [];
  let off = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(AGENT_HEADER)) out.push(off);
    off += line.length + 1;
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
  return liveAskImpl(text);
}

/**
 * Every agent turn in the journal, oldest first, as {index, offset, slice}.
 *
 * ADDITIVE (2026-08-27). `liveAsk` answers "what is the ask NOW"; a caller asking
 * "was this ask ever carried, and did it stop?" needs the same extraction applied to
 * each HISTORICAL turn. Re-deriving turn boundaries in the caller is how detectors
 * drift from the parser they are meant to model, so the boundaries live here.
 *
 * The final slice runs to end-of-file; earlier slices stop at the next agent marker.
 * A user entry does NOT end a slice: `askFromSlice` scans line-wise and the digest's
 * own dialects are agent-authored, so a quoted user reply inside the span is inert.
 */
export function agentTurnSlices(text) {
  const turns = markerOffsets(text, AGENT);
  return turns.map((offset, i) => ({
    index: i,
    offset,
    slice: text.slice(offset, i + 1 < turns.length ? turns[i + 1] : text.length),
  }));
}

/**
 * The ask carried by ONE slice, using the digest's exact dialect priority.
 * Returns null when that turn carried no ask in any dialect.
 */
export function askInSlice(slice, sourcePrefix = 'turn') {
  return askFromSlice(slice, sourcePrefix);
}

function liveAskImpl(text) {
  const turns = markerOffsets(text, AGENT);
  const users = markerOffsets(text, USER);
  const lastUser = users.length ? users[users.length - 1] : -1;
  const turnCount = turns.length;
  const lastMarker = turnCount ? turns[turnCount - 1] : -1;

  // UNSTAMPED TURN (found 2026-08-28, measured on 5 live tasks incl. #448, #446, #462)
  // ---------------------------------------------------------------------------------
  // `write-turn.ps1` appends the turn body verbatim and does not add the provenance
  // marker — it only refuses a STRAY one. So a turn authored as `## 🌙 Overnight Agent`
  // with the marker omitted is a real, delivered agent reply that carries no marker.
  //
  // To the BRIDGE that turn exists: latestAgentTurn() accepts the heading as a turn start,
  // so it posts to Telegram normally. To THIS function it did not exist — the marker scan
  // saw the user's message as the newest thing and returned `userSpokeLast: true,
  // ask: null`. Every consumer keyed on liveAsk (~15 sweeps) then skipped the task
  // entirely, because they all begin `if (!ask) continue`.
  //
  // Measured impact when found: 5 active non-terminal tasks invisible, including #448 —
  // which carries the top merge asks — #446 (🔴) and #462. This is the same OUTCOME as the
  // quoted-marker bug recorded above (an ask hidden from every consumer at once) reached
  // by a different cause, and it is exactly the divergence this file's own header warns
  // about: "re-deriving turn boundaries in the caller is how detectors drift from the
  // parser they are meant to model."
  //
  // Deliberately ADDITIVE: this only fires when an unstamped turn sits below the user's
  // last message AND that turn actually carries an ask. If it carries none we fall through
  // to the original `user-spoke-last` verdict, so the change can only ever restore a
  // hidden ask — never remove or reinterpret one that was already being reported.
  const heads = headerOffsets(text);
  const lastHead = heads.length ? heads[heads.length - 1] : -1;
  if (lastUser > lastMarker && lastHead > lastUser) {
    const hit = askFromSlice(text.slice(lastHead), 'unstamped-turn');
    if (hit) return { ...hit, turnIndex: turnCount, turnCount, userSpokeLast: false };
  }

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
