// lib-issue-comments.mjs — which GitHub issue comment is the agent's, and what it may edit.
//
// WHY THIS FILE EXISTS (GH #453)
// ------------------------------
// The operating contract for issue work carries two rules that both depend on telling an agent
// comment from a human one:
//
//     "Exactly one agentic comment per issue, and it is the catch-up doc." On later passes,
//     "edit that one comment in place rather than adding another."
//     "Never touch human comments."
//
// Neither was enforceable. The agent posts through Shiv's GitHub identity and stamped nothing, so
// measured live on 2026-09-03 every agentic comment came back `user.login = shivbijlani` with no
// provenance marker of any kind. The contract was satisfied **by counting**: there happened to be
// exactly one comment, so "the agentic comment" was unambiguous.
//
// That is a property of the data, not of the system. The moment Shiv comments on one of those
// issues there are two comments, both authored `shivbijlani`, and an agent told to "edit that one
// comment in place" has no sound way to choose. The failure is silent and destructive: it can
// **overwrite his comment**, breaking the second rule by using the first as the mechanism.
//
// WHY #422's FIX DOES NOT TRANSFER, AND WHAT REPLACES IT
// -----------------------------------------------------
// The Google Docs half of this defect was resolved by INVERSION (#451): the agent never authors a
// doc comment at all, so every comment there is provably Shiv's. That trick is unavailable here,
// because this contract REQUIRES the agent to post exactly one comment. "Never posts" is not on
// the table, so this surface takes the opposite invariant: **always stamps**.
//
// The two surfaces therefore end up with opposite, independently checkable rules. That asymmetry
// is the reason this is safe to fix on its own rather than waiting on a shared posting identity.
//
// THE FAIL DIRECTION IS THE WHOLE DESIGN
// --------------------------------------
// Losing an agent comment is cheap — the next pass posts a new one and the write-up is still in
// front of Shiv. Overwriting one of his comments destroys something only he can reproduce. So
// every ambiguity here resolves AWAY from editing:
//
//   0 marked  -> POST a new comment. Never "edit the most recent one" as a fallback; that
//                fallback IS the defect, since the most recent comment is very often his reply.
//   1 marked  -> EDIT it. The only case where editing is sound.
//   2+ marked -> REFUSE. Two marked comments means an earlier invariant already broke, and
//                guessing which to keep is how one of them gets silently discarded.
//
// ⚠️ NOTHING HERE READS THE COMMENT BODY FOR AUTHORSHIP EXCEPT THE MARKER.
// All five pre-existing comments share an opening signature (`📄 **[Catch-up doc — Task N](…`),
// and reaching for it as the identifying rule is the obvious move. It is deliberately ABSENT from
// this module. "Starts with the doc-link prefix, therefore agent-authored" is the same inference
// this file exists to eliminate, merely inverted — Shiv can paste that prefix into a comment of
// his own and it becomes adoptable and overwritable, which is the exact data-loss path above
// reintroduced BY ITS OWN FIX. The pre-existing comments are adopted by explicit ID below, so the
// prefix is never needed and never consulted.

// Deliberately identical to the journal turn convention that `write-turn.ps1` guard G7 already
// enforces, so there is ONE provenance string across the agent's surfaces rather than a second
// convention invented for this one.
export const ISSUE_AGENT_MARKER = '<!-- from: overnight-agent -->'

// Anchored to the FIRST non-empty line, and it must be the whole line. A marker appearing later
// in a body is NOT a stamp: that is what a human quoting or replying to the agent's comment looks
// like, and treating it as a stamp would make his comment editable — the destructive direction.
const MARKER_RE = /^[ \t]*<!--[ \t]*from:[ \t]*overnight-agent[ \t]*-->[ \t]*$/

/**
 * The comments that existed before stamping did, adopted by EXPLICIT ID.
 *
 * Verified 2026-09-03 via `gh api`: every one authored `shivbijlani`, every one unmarked. They
 * are listed because rule "refuse to edit an unmarked comment" would otherwise strand them —
 * every existing catch-up comment would be duplicated on the next pass rather than updated.
 *
 * This is a ONE-TIME bootstrap, not a mechanism. Once these are stamped the list is inert, and
 * nothing consults it to decide authorship — `resolveAgenticComment` never looks at it.
 */
export const BACKFILL_COMMENT_IDS = Object.freeze([
  { issue: 261, id: 5535544915 },
  { issue: 422, id: 5530190335 },
  { issue: 421, id: 5533727007 },
  { issue: 424, id: 5531015978 },
  { issue: 442, id: 5535563840 },
])

/** True when the body's FIRST non-empty line is the provenance marker. */
export function isAgentComment(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    return MARKER_RE.test(line)
  }
  return false
}

/**
 * Add the marker. Idempotent, and it goes at the TOP so it is the first thing every reader —
 * human, API or guard — encounters, and so appending to the body can never displace it.
 */
export function stampIssueComment(body) {
  const text = String(body ?? '').replace(/^\s+/, '')
  if (isAgentComment(text)) return text
  return `${ISSUE_AGENT_MARKER}\n${text}`
}

/** Strip a leading marker, so a stamped body can be shown or compared without it. */
export function unstampIssueComment(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i < lines.length && MARKER_RE.test(lines[i])) {
    return lines.slice(i + 1).join('\n').replace(/^\n+/, '')
  }
  return String(body ?? '')
}

/**
 * Decide what the agent may do with an issue's comments.
 *
 * `comments` is whatever `gh issue view --json comments` returns: objects with `body`, and an
 * `id`/`databaseId` used only to report WHICH comment to edit. The `author` field is ignored
 * entirely — it says `shivbijlani` for both halves of the conversation, which is the defect.
 *
 * Returns `{ action, commentId, marked, unmarked, reason }` where action is one of:
 *   'edit'   — exactly one marked comment; `commentId` is safe to update in place
 *   'post'   — no marked comment; add a new one (NEVER edit an unmarked comment instead)
 *   'refuse' — more than one marked comment; a human has to look
 */
export function resolveAgenticComment(comments) {
  const rows = (comments ?? []).map((c, i) => ({
    index: i,
    id: c && (c.id ?? c.databaseId ?? null),
    marked: isAgentComment(c && c.body),
  }))
  const marked = rows.filter((r) => r.marked)
  const unmarked = rows.filter((r) => !r.marked)

  if (marked.length === 1) {
    return { action: 'edit', commentId: marked[0].id, marked, unmarked, reason: 'one-marked-comment' }
  }
  if (marked.length === 0) {
    return { action: 'post', commentId: null, marked, unmarked, reason: 'no-marked-comment' }
  }
  return { action: 'refuse', commentId: null, marked, unmarked, reason: 'multiple-marked-comments' }
}
