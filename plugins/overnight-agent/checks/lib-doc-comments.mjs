// lib-doc-comments.mjs — who wrote a Google Doc comment, and what that does NOT authorise.
//
// WHY THIS FILE EXISTS (GH #422, prerequisite for #421)
// ----------------------------------------------------
// Shiv wants Google Doc comments to be the primary reply channel for a task. That needs one
// question answered every wake: which comments are his, and which are the agent's own replies?
//
// Today it cannot be answered at all. The agent posts through Shiv's Google identity, so the
// Docs/Drive API stamps BOTH halves of the conversation with the same author. Measured live on
// the one catch-up doc that exists (task #228, doc 16F7lGso...), 2026-09-03:
//
//     top-level comments : 8  -> all `Author: Shiv Bijlani`
//     replies (all agent): 8  -> all `Author: Shiv Bijlani`
//     distinct authors   : 1
//
// e.g. comment AAACAbx8RrM reads `Skip` (Shiv) and its reply AAACGdxf9QA reads
// `Done — History section removed.` (the agent). Identical attribution.
//
// THE TWO READERS HAVE OPPOSITE DEFAULTS, AND THAT IS THE WHOLE DESIGN
// -------------------------------------------------------------------
// This module deliberately exposes two readers over the same attribution, because "did someone
// speak?" and "did someone authorise this?" are different questions whose safe failure directions
// are opposite. Collapsing them into one reader is exactly the #227 hole, in a new channel.
//
//   readingView()  — fail-OPEN.  Anything not provably the agent's is offered as a possible
//                    instruction. Missing one of Shiv's instructions is the cost of a false
//                    negative here, and it is a bad one, so we over-offer.
//
//   consentView()  — fail-CLOSED. An affirmative authorises nothing unless it is POSITIVELY
//                    attributed to a human. Unknown is not human.
//
// WHY consentView() CURRENTLY REFUSES EVERYTHING (this is the finding, not a stub)
// -------------------------------------------------------------------------------
// It is tempting to argue: the agent always stamps itself, therefore an UNSTAMPED comment must be
// human, therefore absence of the marker is proof of a human. That inference is what #422 exists
// to refuse, and the issue says so in as many words: "Absence of the agent marker is NOT proof of
// a human — a mail-merge of that mistake is exactly the #227 hole."
//
// The chain only holds while the invariant "the agent never posts unmarked" holds for all time —
// across crashes mid-write, sibling skills, and any future refactor of the poster. This repo has
// measured that class of convention failing: 114 of 238 journals lack the turn stamp the journal
// reader was once assumed to always have. A consent gate resting on a convention is not a gate.
//
// So: `human` is a value this module can REPRESENT but will never INFER. It is produced only by an
// author-separated channel (a distinct posting identity), which does not exist yet and is #421's
// job to introduce. Until then `consentView()` returns consent_ok:false with the reason
// `no-human-attribution-channel`, and that is the correct, honest answer — comments provably
// cannot approve. This is strictly better than the journal, where unstamped text at least reads as
// `unknown`; here the API asserts a POSITIVE human attribution that is false, so the reader must
// discard the API's author field entirely rather than believe it.
//
// WHAT MAKES A COMMENT PROVABLY THE AGENT'S
// -----------------------------------------
// Two independent signals, either sufficient, deliberately belt-and-braces:
//
//   1. THE MARKER, written atomically as part of the POST body. There is no window in which an
//      agent comment exists without it, because it is not a second write.
//   2. THE LEDGER, the comment id returned by the API at create time, recorded locally. This
//      survives a body edit, and it cannot be forged by anything written INTO a doc — which
//      matters because a human who pastes the marker (quoting the agent) would otherwise have
//      their own text read as the agent's, and that is the direction that loses an instruction.
//
// The marker covers what the ledger cannot (a lost/rebuilt ledger, another machine); the ledger
// covers what the marker cannot (a human quoting it back). Neither alone is enough.

const MARKER_VERSION = 'v1'

// ASCII only, on purpose. This string round-trips through the Docs API, a JSON ledger, a
// PowerShell wrapper and a git diff. Every non-ASCII byte on that path is a chance to arrive
// re-encoded and stop matching — and a marker that silently stops matching fails OPEN for
// reading (an agent reply gets re-read as an instruction and answered again, GH #170's defect).
export const AGENT_MARKER = `-- overnight-agent [oa-comment:${MARKER_VERSION}]`

// Anchored to the END of the body, and only the final non-empty line counts. A marker mid-body
// is NOT a stamp: that is what a human quoting the agent's reply looks like, and treating it as a
// stamp would silently drop their message.
const MARKER_RE = /^[ \t]*--[ \t]*overnight-agent[ \t]*\[oa-comment:v1\][ \t]*$/

export const AUTHOR = Object.freeze({
  AGENT: 'agent',
  HUMAN: 'human',
  UNKNOWN: 'unknown',
})

// Kept identical to $script:ConsentAffirmRe in oa-state.ps1. It is duplicated rather than
// imported only because that is PowerShell; `mutcheck-consent-vocab-drift.ps1` already pins the
// vocabulary against SKILL.md, and arm H below pins THIS copy against the same list, so the three
// cannot drift apart silently.
export const CONSENT_AFFIRM_RE =
  /(?<![\w-])(approved?|approve it|yes|yep|yeah|go ahead|go for it|go|lgtm|ship it|do it|vibe it|send it|make it so|proceed|merge[ \t]+#?\d+)(?![\w-])/i

/** Append the provenance marker to a comment body. Idempotent. */
export function stampAgentBody(body) {
  const text = String(body ?? '').replace(/\s+$/, '')
  if (isStamped(text)) return text
  return `${text}\n\n${AGENT_MARKER}`
}

/** True when the body's LAST non-empty line is the agent marker. */
export function isStamped(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue
    return MARKER_RE.test(lines[i])
  }
  return false
}

/** Strip a trailing marker so a stamped body can be shown/compared without it. */
export function unstampBody(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  if (end > 0 && MARKER_RE.test(lines[end - 1])) end--
  return lines.slice(0, end).join('\n').replace(/\s+$/, '')
}

/**
 * Parse the text dump emitted by the Google Workspace MCP's `list_document_comments`.
 *
 * Parsing a formatted dump is not the preferred input — pass structured objects when the caller
 * has them — but it is what the MCP hands back today, and a reader that cannot read the live
 * surface is a reader nobody runs.
 */
export function parseCommentDump(text) {
  const out = []
  const lines = String(text ?? '').split(/\r?\n/)
  let cur = null
  const push = () => {
    if (cur) {
      cur.content = cur.content.replace(/\s+$/, '')
      out.push(cur)
    }
    cur = null
  }
  for (const raw of lines) {
    let m
    if ((m = /^\s*Comment ID:\s*(\S+)\s*$/.exec(raw))) {
      push()
      cur = { id: m[1], kind: 'comment', parentId: null, author: null, created: null, quoted: null, content: '' }
      continue
    }
    if ((m = /^\s*Reply ID:\s*(\S+)\s*$/.exec(raw))) {
      const parent = out.length ? out[out.length - 1] : null
      const parentId = cur ? cur.id : parent && parent.kind === 'comment' ? parent.id : null
      push()
      cur = { id: m[1], kind: 'reply', parentId, author: null, created: null, quoted: null, content: '' }
      continue
    }
    if (!cur) continue
    if ((m = /^\s*Author:\s*(.*)$/.exec(raw))) { cur.author = m[1].trim(); continue }
    if ((m = /^\s*Created:\s*(.*)$/.exec(raw))) { cur.created = m[1].trim(); continue }
    if ((m = /^\s*Quoted text:\s*(.*)$/.exec(raw))) { cur.quoted = m[1].trim(); continue }
    if ((m = /^\s*Replies\s*\(\d+\):\s*$/.exec(raw))) { continue }
    if ((m = /^\s*Content:\s*([\s\S]*)$/.exec(raw))) { cur.content = m[1]; continue }
    if (cur.content !== '') cur.content += `\n${raw.replace(/^\s{0,4}/, '')}`
  }
  push()
  return out
}

/**
 * Attribute each entry.
 *
 * NOTE the API's own `author` field is READ BUT NEVER TRUSTED. It is carried through as
 * `apiAuthor` for display and audit only. Believing it is the defect.
 */
export function attribute(entries, ledger = {}) {
  const known = new Set(ledgerIds(ledger))
  return (entries ?? []).map((e) => {
    const stamped = isStamped(e.content)
    const inLedger = known.has(e.id)
    const author = stamped || inLedger ? AUTHOR.AGENT : AUTHOR.UNKNOWN
    return {
      ...e,
      apiAuthor: e.author ?? null,
      author,
      evidence: author === AUTHOR.AGENT ? (inLedger ? (stamped ? 'ledger+marker' : 'ledger') : 'marker') : 'none',
      body: unstampBody(e.content),
    }
  })
}

function ledgerIds(ledger) {
  if (!ledger) return []
  if (Array.isArray(ledger)) return ledger.map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean)
  if (Array.isArray(ledger.comments)) return ledger.comments.map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean)
  return Object.keys(ledger)
}

/**
 * Read the ledger for one document out of a ledger FILE (the on-disk `{ docs: { <id>: … } }`
 * shape used by doc-comment-ledger-backfill.json and by the live per-run ledger).
 *
 * Returns an empty ledger for an unknown doc rather than throwing. That is the safe direction:
 * an unknown doc yields no agent attributions, so every comment reads as `unknown` — which the
 * reading view still offers and the consent view still refuses. A missing ledger degrades to
 * "less is provably the agent's", never to "more is provably human".
 */
export function ledgerForDoc(ledgerFile, docId) {
  const docs = ledgerFile && ledgerFile.docs
  const entry = docs && docs[docId]
  if (!entry) return { comments: [] }
  return { comments: Array.isArray(entry.comments) ? entry.comments : [] }
}

/** Union of several ledgers for the same doc (e.g. the committed backfill + the live one). */
export function mergeLedgers(...ledgers) {
  const seen = new Map()
  for (const l of ledgers) {
    for (const id of ledgerIds(l)) if (!seen.has(id)) seen.set(id, { id })
  }
  return { comments: [...seen.values()] }
}

/**
 * FAIL-OPEN reader for instructions. Anything not provably the agent's is offered.
 *
 * `treatAsInstruction` is intentionally true for UNKNOWN. Over-offering costs a re-read;
 * under-offering silently drops one of Shiv's instructions, which is the #170 failure.
 */
export function readingView(entries, ledger = {}) {
  return attribute(entries, ledger).map((e) => ({
    ...e,
    treatAsInstruction: e.author !== AUTHOR.AGENT,
  }))
}

/**
 * FAIL-CLOSED reader for consent. See the header: `human` is never inferred, so today this
 * always refuses. It reports WHICH affirmative it refused, so a run can tell "nobody approved"
 * from "something approved and it was not provably you" — the second is worth surfacing.
 */
export function consentView(entries, ledger = {}) {
  const rows = attribute(entries, ledger)
  const result = {
    consent_ok: false,
    human_comments: 0,
    affirmative_phrase: null,
    affirmative_author: null,
    affirmative_unattributed: false,
    reason: 'no-comments',
  }
  if (!rows.length) return result

  result.human_comments = rows.filter((r) => r.author === AUTHOR.HUMAN).length

  for (const r of rows) {
    const m = CONSENT_AFFIRM_RE.exec(r.body)
    if (!m) continue
    if (r.author === AUTHOR.HUMAN) {
      result.consent_ok = true
      result.affirmative_phrase = m[0]
      result.affirmative_author = r.author
      result.reason = 'human-authored-affirmative'
      return result
    }
    if (!result.affirmative_unattributed) {
      result.affirmative_unattributed = true
      result.affirmative_phrase = m[0]
      result.affirmative_author = r.author
    }
  }

  result.reason = result.affirmative_unattributed
    ? 'affirmative-not-attributable-to-human'
    : result.human_comments > 0
      ? 'human-spoke-but-no-affirmative'
      : 'no-human-attribution-channel'
  return result
}
