// lib-external-surfaces.mjs — recognise the OFF-JOURNAL surfaces an ask can point Shiv at,
// and pull out an identifier concrete enough that a run can actually poll them.
//
// WHY THIS EXISTS
// ---------------
// 2026-08-28 08:45 PT run learning. `oa-state.ps1 scan` hashes JOURNALS. #459 was waiting on
// Shiv leaving one comment on a Google Doc; he left two on 2026-08-27; every signal the agent
// watches (scan / Telegram / agent inbox) read "quiet" for a full day because his input landed
// on a surface none of them look at. That run read the comments by hand and recorded, verbatim:
// "I have not fixed the watching part."
//
// This library is the first half of the fix. It answers one question per journal:
//   "does this task's LIVE ask direct Shiv at something outside the journal, and if so, WHAT
//    exactly do I poll?"
//
// THE PRECISION PROBLEM
// ---------------------
// Almost every agent turn LINKS something — a deliverable doc, a draft PR, a folder. A naive
// "journal contains a docs.google.com URL" scan matches most of the corpus and is worthless.
// Six detectors in this suite have already cried wolf, so this one is narrow by construction:
// a link is evidence of a DELIVERABLE; only the ASK tells you whether Shiv is expected to act
// there. Both halves are required (see external-surface-sweep.mjs for the conjunction).
//
// Quoted spans are stripped before matching, per the #267 lesson: a block that QUOTES an old
// request would otherwise be scored as still making it.

// ---- surface identifiers ----------------------------------------------------
// Ordered most-specific first; Google's /d/<id>/ shape is shared across four products, so the
// product segment is what discriminates them.
const PATTERNS = [
  { kind: 'gdoc', poll: 'list_document_comments',
    rx: /https?:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/g },
  { kind: 'gsheet', poll: 'read_sheet_values',
    rx: /https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/g },
  { kind: 'gslides', poll: 'get_presentation',
    rx: /https?:\/\/docs\.google\.com\/presentation\/d\/([A-Za-z0-9_-]{20,})/g },
  { kind: 'gform', poll: 'list_form_responses',
    rx: /https?:\/\/docs\.google\.com\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]{20,})/g },
  { kind: 'gdrive', poll: 'list_drive_items',
    rx: /https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{20,})/g },
  { kind: 'gcal', poll: 'get_events',
    rx: /https?:\/\/(?:www\.)?google\.com\/calendar\/event\?eid=([A-Za-z0-9_=-]{10,})/g },
  { kind: 'github-pr', poll: 'gh pr view --comments',
    rx: /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g },
  { kind: 'github-issue', poll: 'gh issue view --comments',
    rx: /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g },
];

/**
 * Every pollable surface referenced in `text`, de-duplicated, in first-seen order.
 * Returns [{ kind, id, url, poll }].
 */
export function surfacesIn(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const p of PATTERNS) {
    p.rx.lastIndex = 0;
    for (const m of text.matchAll(p.rx)) {
      // GitHub carries two capture groups (repo, number); Google carries one (file id).
      const id = m[2] ? `${m[1]}#${m[2]}` : m[1];
      const key = `${p.kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: p.kind, id, url: m[0], poll: p.poll });
    }
  }
  return out;
}

// ---- is Shiv being asked to ACT there? --------------------------------------
// The verb has to be one that leaves a trace ON the surface — that is the whole point, because
// a trace on the surface is invisible to `scan`. "Read the doc" leaves nothing behind and needs
// no watching; "comment on the doc" does.
const RX_SURFACE_ACTION = new RegExp(
  [
    // comment / annotate
    String.raw`\bcomment(s|ing|ed)?\b`,
    String.raw`\bleave\s+(a\s+)?(comment|note|reply)`,
    String.raw`\bannotate\b`,
    String.raw`\bmark\s+(it\s+)?up\b`,
    // review / approve in-place
    String.raw`\breview\s+(it|the|this)\b`,
    String.raw`\bapprove\s+(it\s+)?(on|in|via)\b`,
    String.raw`\bsign\b`,
    // fill / submit / upload
    String.raw`\bfill\s+(it\s+)?(in|out)\b`,
    String.raw`\bsubmit\b`,
    String.raw`\bupload\b`,
    String.raw`\bdrop\s+(it|them|the|a)\b`,
    String.raw`\badd\s+(it|them)?\s*to\s+the\s+(sheet|doc|folder|form)\b`,
    // explicit "go there" phrasing
    String.raw`\bopen\s+(the|it|that)\b`,
    String.raw`\breply\s+(on|in|under)\b`,
  ].join('|'),
  'i'
);

// The surface has to be NAMED in the ask, not merely linked somewhere in the turn. Without this
// an ask like "one word - merge or drip" would pair with any doc the turn happens to link.
//
// The noun also does double duty as a TYPE FILTER. A turn commonly links several artifacts —
// #446's newest turn carries four Google Docs, a Drive folder and a PR — while its ask says
// "comment on the doc". Emitting all six is the flooding failure this suite has hit six times;
// the noun says which KIND Shiv was pointed at, so only that kind can be the answer surface.
const NOUN_KINDS = [
  [/\b(docs?|document)\b/i, ['gdoc']],
  [/\b(sheet|spreadsheet)\b/i, ['gsheet']],
  [/\b(slide deck|slides|presentation|deck)\b/i, ['gslides']],
  [/\bform\b/i, ['gform']],
  [/\b(folder|drive|gallery)\b/i, ['gdrive']],
  [/\bcalendar\b/i, ['gcal']],
  [/\b(pr|pull request)\b/i, ['github-pr']],
  [/\bissue\b/i, ['github-issue']],
];

/** The surface kinds an ask actually names, or [] if it names none. */
export function surfaceKindsNamed(ask) {
  const a = unquoted(ask || '');
  const kinds = new Set();
  for (const [rx, ks] of NOUN_KINDS) if (rx.test(a)) ks.forEach(k => kinds.add(k));
  return [...kinds];
}

/**
 * Does this ask direct Shiv to leave a trace on an off-journal surface?
 * Requires BOTH an action that writes to a surface AND the surface being named.
 */
export function asksForSurfaceAction(ask) {
  if (!ask) return false;
  const a = unquoted(ask);
  if (!a.trim()) return false;
  return RX_SURFACE_ACTION.test(a) && surfaceKindsNamed(a).length > 0;
}

/**
 * Strip blockquotes and quoted spans so a QUOTED past request is not read as a live one.
 * (#267: a checker must use the parser's own semantics or it invents bugs.)
 *
 * ⚠️ TWO non-obvious things here, both found by mutcheck-external-surface against a real fixture.
 *
 * 1. The ASCII-quote arm deliberately differs from the copy in external-artifact-sweep.mjs, which
 *    uses `[^"\n]` and therefore CANNOT strip a quote that wraps across a line break — while the
 *    smart-quote arm beside it uses `[\s\S]` and handles wrapping fine. Newlines are allowed here
 *    but a BLANK line is not, so an unbalanced quote cannot swallow a following paragraph.
 *
 * 2. `liveAsk` is LINE-SCOPED: it returns only the first line of a multi-line ask. So a wrapped
 *    quote reaches a caller already truncated — `... My earlier ask, "open the doc and leave a` —
 *    with its closing quote cut off. No balanced-pair regex can ever match that, which is why the
 *    trailing-unbalanced-quote sweep below exists: past an odd-numbered quote mark, the remainder
 *    of a truncated ask IS quoted material.
 */
export function unquoted(text) {
  const stripped = String(text || '')
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n')
    .replace(/[\u201c\u201d][\s\S]{0,400}?[\u201c\u201d]/g, ' ')
    .replace(/"(?:[^"\n]|\n(?!\s*\n)){0,400}"/g, ' ');
  const open = stripped.lastIndexOf('"');
  if (open !== -1 && (stripped.match(/"/g) || []).length % 2 === 1) {
    return `${stripped.slice(0, open)} `;
  }
  return stripped;
}

// A dismissive opener means the block wants nothing from Shiv. Per the #163 lesson the
// dismissal dismisses ONLY ITSELF: text after a clause break can still carry a real ask, so
// this returns true only when nothing survives the break.
const RX_DISMISSIVE = /^\s*\**\s*(none|nothing|no\s+action|n\/a)\b/i;

export function isDismissive(ask) {
  if (!ask) return true;
  const a = unquoted(ask);
  if (!RX_DISMISSIVE.test(a)) return false;
  const rest = a.replace(/^[\s\S]{0,80}?[.;:\u2014\u2013]\s/, '');
  if (rest === a) return true;
  return !RX_SURFACE_ACTION.test(rest);
}
