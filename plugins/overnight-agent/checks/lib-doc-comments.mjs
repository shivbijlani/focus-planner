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
 *
 * DOUBLE-ESCAPED NEWLINES (GH #529)
 * ---------------------------------
 * The MCP does not hand back a bare dump. It returns the dump inside a JSON envelope, and its
 * newlines survive as the two literal characters `\` `n`. Splitting on /\r?\n/ then yields ONE
 * line, no `Comment ID:` ever matches, and this returned an empty array — which is
 * indistinguishable from a document the user has not commented on. Measured on the live dump for
 * task #468: 0 parsed as-is, 18 after un-escaping.
 *
 * Un-escaping is applied on a BEHAVIOURAL condition — parse first, and only re-parse when the
 * first attempt found nothing while the text plainly names comments — rather than on "the text
 * has no real newlines". That guard would be wrong: a real dump contains BOTH escaped separators
 * and real newlines inside comment bodies, so keying on their absence declines to un-escape
 * exactly the input that needs it. Fails toward re-reading a comment, never toward silence.
 */
export function parseCommentDump(text) {
  const src = String(text ?? '')
  let rows = parseCommentLines(src)
  if (rows.length === 0 && /Comment ID:|Reply ID:/.test(src)) {
    rows = parseCommentLines(src.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n'))
  }
  // De-duplicate by id, keeping the first occurrence. The MCP envelope carries the SAME dump
  // TWICE -- once in `content[].text` and again in `structuredContent.result` -- so a caller that
  // hands over the whole envelope sees every comment twice. Measured on the live task #468 dump:
  // 18 entries for 9 real comments. Reading both copies and de-duplicating is strictly safer than
  // picking one and being wrong about which is populated, which is how this reader went blind in
  // the first place.
  const seen = new Set()
  return rows.filter((r) => r && r.id && !seen.has(r.id) && seen.add(r.id))
}

/**
 * Did this text fail to PARSE, as opposed to describing a document with no comments?
 *
 * `parseCommentDump` returning `[]` answers "how many comments are in this text", and cannot
 * answer "was this text a successful listing" — a transport error, a truncated file and a
 * genuinely empty document all yield zero entries. Reporting that as `0` is the #346 defect on
 * the channel Shiv designated primary, where a dropped message is an instruction he believes
 * arrived.
 *
 * So zero is only trustworthy alongside POSITIVE evidence that a listing happened: the MCP's own
 * summary line, which is present even for an empty document. Bytes that name comments but parse
 * to nothing are a parse failure; bytes that say nothing at all are not a reading.
 */
export function isUnparsedDump(text, parsed) {
  if (Array.isArray(parsed) && parsed.length > 0) return false
  const src = String(text ?? '')
  if (/Comment ID:|Reply ID:/.test(src)) return true
  if (/^\s*Found\s+\d+\s+comments?\b/im.test(src)) return false
  return src.trim().length > 0
}

function parseCommentLines(text) {
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

// ── THE NEVER-COMMENT RULE ────────────────────────────────────────────────────────────────────
//
// Shiv, on this module's own catch-up doc, 2026-09-04:
//
//     "I don't expect you to reply to any of my comments. […] you never comment on the document
//      you update the document with the answer […] Dissolves the issue about whose comment is it
//      mine or yours […] So then if I approve something in the document you know it's coming
//      from me"
//
// This does not SOLVE the attribution problem described in the header. It REMOVES ITS PREMISE.
// The header's problem is that two authors share one identity, so neither can be told apart. If
// only one author ever writes, there is nothing to tell apart: every comment is his, positively,
// and not by the "unmarked therefore human" inference that #422 rightly refuses.
//
// WHY THIS IS STRONGER THAN THE INFERENCE IT REPLACES, AND WHERE IT STILL IS NOT
// ------------------------------------------------------------------------------
// The rejected inference rests on "the agent never posts UNMARKED", which is unobservable: an
// unmarked agent comment is indistinguishable from a human one, which is the whole defect. The
// rule rests on "the agent never posts AT ALL", and the violating case of that — an agent comment
// that DOES exist — is observable by exactly the attribution this module already computes. A
// convention you can audit is a different object from one you cannot.
//
// It is still not free. Two residuals, stated rather than buried:
//
//   1. Enforcement, not intent. `ok` below is computed against the live comment list every time
//      it is consulted. It is never cached and never assumed — that is the difference between a
//      gate and a promise, and this repo has measured promises failing (114 of 238 journals lack
//      a stamp that a reader once assumed was always present).
//   2. An agent comment posted unmarked AND unledgered is still invisible here. That case is
//      closed upstream, by the agent having no sanctioned step that posts a comment at all
//      (SKILL.md PHASE 0.7), not by this function. What this function guarantees is that every
//      violation the agent could plausibly commit — through its own stamped posting path — is
//      caught, and that catching one refuses consent rather than degrading quietly.
//
// PRE-RULE REPLIES ARE LEGACY, NOT VIOLATIONS
// -------------------------------------------
// Agent replies written before the rule existed are real and must stay readable, so they are
// partitioned as `legacy` instead of permanently breaking the invariant. Without a cutoff the
// three replies already on task #468's doc would pin `ok:false` forever, and an invariant that
// can never hold is one nobody consults.
export const NEVER_COMMENT_SINCE = '2026-09-04T03:32:12Z'

/**
 * Does the never-comment rule HOLD on this comment list?
 *
 * An agent-attributed entry created at or after `since` is a violation. An agent entry with no
 * readable `created` is ALSO a violation: this gate guards consent, so the unknown case must fail
 * towards refusing. Treating an undated agent comment as legacy would make "strip the date" a way
 * to launder a violation into a tolerated one.
 */
export function neverCommentView(entries, ledger = {}, { since = NEVER_COMMENT_SINCE } = {}) {
  const cutoff = Date.parse(String(since ?? ''))
  const violations = []
  const legacy = []
  for (const row of attribute(entries, ledger)) {
    if (row.author !== AUTHOR.AGENT) continue
    const at = Date.parse(String(row.created ?? ''))
    if (Number.isNaN(at) || Number.isNaN(cutoff) || at >= cutoff) violations.push(row)
    else legacy.push(row)
  }
  return {
    ok: violations.length === 0,
    since,
    violations,
    legacy,
    reason: violations.length ? 'agent-commented-after-rule' : 'no-agent-comment-after-rule',
  }
}

/**
 * FAIL-CLOSED reader for consent. `human` is never INFERRED — see the header.
 *
 * `neverComment: true` opts into the rule above, and is the only way this function can ever
 * report a human author. It is opt-in rather than the default on purpose: turning it on weakens
 * a gate, so it is a decision a caller makes explicitly and per call, not one that arrives by
 * upgrading this file. And it grants nothing on its own — the invariant is re-proven against the
 * comments in hand each time, so a doc carrying an agent comment refuses exactly as before.
 */
export function consentView(entries, ledger = {}, { neverComment = false, since = NEVER_COMMENT_SINCE } = {}) {
  const attributed = attribute(entries, ledger)
  const invariant = neverComment ? neverCommentView(entries, ledger, { since }) : null
  const rows =
    invariant && invariant.ok
      ? attributed.map((r) => (r.author === AUTHOR.UNKNOWN ? { ...r, author: AUTHOR.HUMAN, evidence: 'never-comment-rule' } : r))
      : attributed
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

  // A broken invariant outranks the ordinary diagnoses. `affirmative_unattributed` is still
  // populated above, so the caller can see WHAT it refused as well as why — but the reason it
  // reports is the violation, because "an agent comment exists on this doc" is the fact that has
  // to be repaired, and reporting it as an ordinary "no attribution channel" would hide a rule
  // breach behind the message the gate prints on every healthy pre-rule doc.
  if (invariant && !invariant.ok) {
    result.reason = invariant.reason
    return result
  }

  result.reason = result.affirmative_unattributed
    ? 'affirmative-not-attributable-to-human'
    : result.human_comments > 0
      ? 'human-spoke-but-no-affirmative'
      : 'no-human-attribution-channel'
  return result
}
