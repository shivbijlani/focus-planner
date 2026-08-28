// lib-live-status.mjs — shared "what is this task's LIVE status?" extractor.
//
// WHY THIS EXISTS (found 2026-08-25 21:00 PT, the status twin of lib-live-ask)
// ---------------------------------------------------------------------------
// The 21:00 run fixed six sweeps that read a task's ASK from the wrong TURN, and
// recorded the meta-rule: *a checker that extracts "the current X" must first decide
// which turn owns it.* The 21:30 addendum then added the standing rule: *grep for the
// defect pattern across every sibling file before declaring a class of bug fixed.*
//
// Doing exactly that turned up a SECOND dimension nobody had checked: STATUS.
// `drift-sweep` (and anything else calling the bridge's `agentBlockStatus`) reads:
//
//     agentBlockStatus(agentBlockText(text))
//
// and `agentBlockText()` splits at the FIRST sentinel and stops at the first date
// header — so on a bottom-appended chat journal it returns TURN 1, forever. Measured
// live over 235 journals: 3 tasks where the newest turn's status differs from the
// block's (#234 on the active board), and — the bigger effect — a DIALECT bug:
//
//     agentBlockStatus's `([A-Za-z-]+)` capture turns "In progress" into `in`.
//
// 14 active-board journals write the human dialect "In progress" (with a space), so
// they parse to the bare token `in`, which equals no canonical status at all. That is
// why `drift-sweep` reported `drift=31` while `[C]`/`[D]` were near-empty: most of that
// "drift" was the parser disagreeing with itself, not the data disagreeing.
//
// SEMANTICS
// ---------
// Status is read from the NEWEST agent turn that actually carries a `**Status:**` line
// (turns routinely omit it), falling back to the agent BLOCK — where SKILL.md's template
// puts it — and never to "last match anywhere". The captured phrase is normalised onto
// the canonical vocabulary; a phrase that does not map is reported as non-canonical with
// its raw text preserved, rather than silently truncated to its first word.
//
// CORRECTION 2026-08-25 22:00 PT — "newest turn" was not the same as "newest".
// ---------------------------------------------------------------------------
// The rule above preferred a Status-bearing TURN over the BLOCK *unconditionally*, and
// only fell back to the block when NO turn carried one. But SKILL.md's loop rewrites the
// **block's** Status line every run, while a turn only sometimes restates it. So a run
// that updated the block and appended a turn WITHOUT a Status line left the newest
// Status-bearing turn stale — and this function then reported that stale turn as "live".
//
// That is the wrong-turn bug of 21:00, reintroduced one level up: turn-vs-block is itself
// a "which one owns it?" question, and it must be settled by DATE, not by position.
// Measured live over 235 journals: 10 verdicts were decided the wrong way, 6 of them real
// status flips — #376 (board), #255/#292/#349 (already on the COMPLETED board, whose
// blocks correctly said `done` while a superseded turn said blocked/in-progress), #308 and
// #400. Those 4 completed/orphan cases are exactly the `[A]`/`[D]` rows `drift-sweep` had
// been printing every run.
//
// Arbitration: a turn's effective date is its Status line's date, else the `## YYYY-MM-DD`
// header it sits under (a journal is a chat thread, so every turn has one). The block's is
// its Status line's date. Strictly-newer wins; a tie keeps the turn (it is positionally
// later, and a same-run block+turn pair should agree anyway); undatable keeps the turn, so
// the previous behaviour is the fallback rather than the default.

const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';
const SENTINEL = '<!-- OVERNIGHT-AGENT';

// Capture the status PHRASE: everything after `Status:` up to the first separator.
// Separators seen live: `·` (middot), `|`, an em/en dash, or end of line.
const rxStatusLine = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m;
// Global twin of the above, so a slice can be scanned for EVERY Status line rather than
// just the first. Kept derived from one source so the two can never diverge.
const rxStatusLineG = new RegExp(rxStatusLine.source, 'gm');
const rxDate = /(\d{4}-\d{2}-\d{2})/;
const rxHeader = /^##[ \t]+(\d{4}-\d{2}-\d{2})/gm;

export const CANONICAL = ['proposed', 'approved', 'revise', 'in-progress', 'blocked', 'done', 'skip'];

/**
 * The STAMP date of a Status line — the date the line asserts about itself, as opposed to
 * a date it merely mentions in prose.
 *
 * Taking the first date on the line is wrong (#352: `Done — shipped 2026-07-18 …;
 * postmortem written 2026-08-22. — 2026-08-22`), and so is taking the last
 * (#320: `Done · 2026-08-23 — trip completed 2026-08-01`). The structural cue is
 * POSITION, not order: SKILL.md's template writes the stamp as its own `·`-delimited
 * segment (`**Status:** Proposed · plan v1 · <YYYY-MM-DD>`), while a mentioned date is
 * always embedded in a clause. So: split on `·` and em/en dashes, and take the LAST
 * segment that is nothing but a date. Fall back to the first date when no segment
 * qualifies, which preserves the previous behaviour for ordinary one-date lines.
 */
export function statusStampDate(line) {
  if (!line) return null;
  const segments = String(line).split(/[\u00b7|\u2014\u2013]|(?:\s-\s)/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const bare = segments[i].replace(/[*_`()[\]{}.,;:"']/g, ' ').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(bare)) return bare;
  }
  const m = rxDate.exec(String(line));
  return m ? m[1] : null;
}

/**
 * Map a free-text status phrase onto the canonical vocabulary.
 * Returns null when the phrase does not name a canonical status.
 */
export function normaliseStatus(phrase) {
  if (!phrase) return null;
  // Strip markdown emphasis and any trailing prose after a dash separator.
  let s = String(phrase).replace(/[*_`]/g, '').trim().toLowerCase();
  s = s.replace(/\s*[\u2014\u2013]\s.*$/, '').trim();  // " — waiting on you"
  if (!s) return null;
  if (/^in[\s-]?progress/.test(s)) return 'in-progress';
  if (/^(done|complete[d]?)\b/.test(s)) return 'done';
  if (/^skip(ped)?\b/.test(s)) return 'skip';
  if (/^propos/.test(s)) return 'proposed';
  if (/^approv/.test(s)) return 'approved';
  if (/^revis/.test(s)) return 'revise';
  if (/^block/.test(s)) return 'blocked';
  return null;
}

function allIndexes(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
}

/**
 * CORRECTION 2026-08-27 — one slice can hold MORE THAN ONE agent block.
 * ---------------------------------------------------------------------
 * This took the FIRST `**Status:**` in the slice. But SKILL.md's loop appends further
 * `## 🌙 Overnight Agent` blocks without necessarily emitting a new `from:` marker, so
 * consecutive blocks pile up inside the SAME turn/block slice. First-match therefore
 * returned whichever status happened to sit highest — the wrong-turn bug of 21:00,
 * recurring a third level down (turn -> block -> blocks-within-a-slice).
 *
 * Measured live over 239 journals: 10 slices held >1 Status line and 7 were misread,
 * 6 on the active board — #232 read `blocked` when its newest block says
 * `Done · 2026-08-27`; #426/#460/#461 read `proposed` when they are `in-progress`;
 * #292 read `blocked` when it is `done`. `status-sync-audit` turned two of those into
 * `[FIX STATE]` recommendations, i.e. it would have REGRESSED correct state and pushed
 * a finished, question-free task back into Shiv's approval queue.
 *
 * TWO REJECTED RULES, both falsified by the corpus rather than by argument:
 *
 *  1. "Take the last." The journal is bottom-appended, so later looks newer. But #239
 *     and #254 follow their real status line with an italic prose note that also opens
 *     with the word Status (`*Status line corrected 2026-08-25: …*`), which normalises
 *     to nothing — last-wins turns two canonical statuses into null.
 *  2. "Take the last CANONICAL one." This is still POSITION, and position is not time.
 *     #362 disproves it: its top block carries `… · 2026-08-21` because SKILL.md
 *     rewrites the block's Status line in place every run, while a *historical*
 *     `### 🌙 Overnight Agent — 2026-07-17` sub-block sits BELOW it. Last-canonical
 *     picked the July line and walked the task back a month. Caught by
 *     mutcheck-status-arbitration's corpus invariant.
 *
 * So arbitrate within the slice the same way this file already arbitrates turn-vs-block
 * (the 2026-08-25 22:00 rule): BY DATE, NOT BY POSITION. Newest stamp wins; a tie keeps
 * the positionally later line (a same-date pair should agree anyway, and later is the
 * one just written); when no candidate carries a stamp, fall back to the last canonical,
 * which is the bottom-appended default. Slices with a single Status line — the
 * overwhelming majority — are bit-for-bit unaffected.
 */
function statusFromSlice(slice, sourcePrefix) {
  rxStatusLineG.lastIndex = 0;
  const cands = [];
  let lastAny = null, m;
  while ((m = rxStatusLineG.exec(slice)) !== null) {
    lastAny = m;
    const raw = m[1].trim();
    if (normaliseStatus(raw) !== null) {
      const line = slice.slice(m.index).split(/\r?\n/)[0].trim();
      cands.push({ m, line, date: statusStampDate(line) });
    }
    if (m.index === rxStatusLineG.lastIndex) rxStatusLineG.lastIndex++;  // zero-width guard
  }

  let hit = null;
  if (cands.length) {
    const dated = cands.filter(c => c.date);
    // `>=` so that among equal dates the positionally later line wins.
    hit = dated.length
      ? dated.reduce((best, c) => (c.date >= best.date ? c : best)).m
      : cands[cands.length - 1].m;
  }
  if (!hit) hit = lastAny;
  if (!hit) return null;
  const raw = hit[1].trim();
  const line = slice.slice(hit.index).split(/\r?\n/)[0].trim();
  return {
    status: normaliseStatus(raw),
    raw,
    line,
    date: statusStampDate(line),
    source: sourcePrefix,
  };
}

/**
 * Offsets of every `## YYYY-MM-DD` chat header, so an undated turn can still be dated.
 */
function headerDates(text) {
  const out = [];
  rxHeader.lastIndex = 0;
  let m;
  while ((m = rxHeader.exec(text)) !== null) out.push({ off: m.index, date: m[1] });
  return out;
}

/** The date of the nearest `## YYYY-MM-DD` header at or above `off`. */
function headerDateFor(headers, off) {
  let best = null;
  for (const h of headers) { if (h.off <= off) best = h.date; else break; }
  return best;
}

/**
 * @param {string} text raw journal markdown
 * @returns {{status:string|null, raw:string|null, line:string|null, date:string|null,
 *            source:string, canonical:boolean, turnIndex:number, turnCount:number,
 *            effDate:string|null, arbitration:string}}
 */
export function liveStatus(text) {
  const turns = allIndexes(text, AGENT);
  const users = allIndexes(text, USER);
  const turnCount = turns.length;
  const headers = headerDates(text);
  const none = {
    status: null, raw: null, line: null, date: null,
    source: 'none', canonical: false, turnIndex: turnCount, turnCount,
    effDate: null, arbitration: 'none',
  };

  // Newest agent turn that carries a Status line.
  let turnHit = null;
  for (let i = turnCount - 1; i >= 0; i--) {
    const start = turns[i];
    // A turn ends at the next `from:` marker of either kind.
    let end = text.length;
    for (const idx of [...turns, ...users]) if (idx > start && idx < end) end = idx;
    const hit = statusFromSlice(text.slice(start, end), `turn-${i + 1}`);
    if (hit) {
      turnHit = {
        ...hit, canonical: hit.status !== null, turnIndex: i + 1, turnCount,
        effDate: hit.date || headerDateFor(headers, start),
      };
      break;
    }
  }

  // The agent block (SKILL.md's template writes Status there, and rewrites it every run).
  let blockHit = null;
  const s = text.lastIndexOf(SENTINEL);
  if (s !== -1) {
    let end = text.length;
    for (const idx of [...turns, ...users]) if (idx > s && idx < end) end = idx;
    const hit = statusFromSlice(text.slice(s, end), 'block');
    if (hit) {
      blockHit = { ...hit, canonical: hit.status !== null, turnIndex: 0, turnCount, effDate: hit.date };
    }
  }

  // Arbitrate by DATE, not by position: whichever line is strictly newer is the live one.
  if (turnHit && blockHit) {
    if (turnHit.effDate && blockHit.effDate) {
      if (blockHit.effDate > turnHit.effDate) return { ...blockHit, arbitration: 'block-newer' };
      return { ...turnHit, arbitration: blockHit.effDate === turnHit.effDate ? 'same-date-turn' : 'turn-newer' };
    }
    return { ...turnHit, arbitration: 'undatable-turn' };
  }
  if (turnHit) return { ...turnHit, arbitration: 'turn-only' };
  if (blockHit) return { ...blockHit, arbitration: 'block-only' };

  return none;
}
