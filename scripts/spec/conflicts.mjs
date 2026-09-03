// Deterministic conflicting-requirement detector for the spec pipeline.
//
// NO SHEBANG HERE, DELIBERATELY. Unlike collect.mjs and verify.mjs, this module
// is imported by a unit test, and Vite does not strip `#!` from an imported
// module -- V8 then rejects the file with "SyntaxError: Invalid or unexpected
// token" pointing at the *importing* test, which is a genuinely confusing place
// to start looking. The workflow invokes this as `node scripts/spec/conflicts.mjs`,
// exactly as it does the other two, so the shebang bought nothing to begin with.
//
// WHY THIS EXISTS
// ---------------
// The spec pipeline moved from weekly to every 6h (#470). Cadence alone makes the
// spec fresher; it does not make it *truer*. The failure it does not catch is two
// open issues that ask for opposite things -- one says "never post per turn", the
// next says "post a line every turn". The generated prose will happily encode
// whichever it read last, verify.mjs will pass (both issues exist, so neither
// reference is invented), and the contradiction ships as design authority.
//
// So this is a third mechanism-half, alongside collect (facts) and verify
// (references): it reads the SAME collected facts and reports requirement pairs
// that cannot both be satisfied. No model is involved, for the same reason the
// rest of the pipeline avoids one -- a model asked "are these in conflict?"
// produces a fluent answer that cannot be checked, and the whole point here is
// that a human can audit the finding in one glance.
//
// PRECISION OVER RECALL, DELIBERATELY
// -----------------------------------
// This repo has already paid for the opposite choice once. The Telegram approval
// digest read "open ask" generously, every turn tripped it, and the result was a
// queue nobody could act on. A conflict report has exactly that failure mode: at
// 4 runs a day, a detector that cries wolf is muted within a week and then it is
// worse than nothing, because its silence now looks like a verdict.
//
// So every rule here demands a *shared, specific target* before it will call two
// statements a conflict, and every finding carries the verbatim sentences it was
// derived from. If a finding is wrong, that is visible in one line rather than
// requiring a re-derivation.
//
// Usage:
//   node scripts/spec/conflicts.mjs --facts spec-facts.json --out spec-decisions.json

import { readFileSync, writeFileSync } from 'fs'
import { pathToFileURL } from 'url'

// --- normalisation -----------------------------------------------------------

// Words that carry no discriminating power for "are these about the same thing".
// Keeping this list small and boring is deliberate: an aggressive stoplist starts
// merging unrelated targets, which is precisely the false positive that kills the
// report's credibility.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you', 'i',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'by', 'from', 'as', 'and', 'or', 'but', 'if', 'then', 'than',
  'so', 'because', 'when', 'while', 'which', 'who', 'what', 'how', 'all', 'any',
  'can', 'could', 'would', 'may', 'might', 'do', 'does', 'did', 'get', 'gets',
  'one', 'two', 'also', 'just', 'only', 'more', 'most', 'other', 'into', 'out',
  'up', 'down', 'over', 'under', 'again', 'very', 'each', 'every', 'per',
])

/** Lowercase, strip punctuation, drop stopwords, and lightly singularise. */
export function tokenize(text) {
  if (!text) return []
  return String(text)
    .toLowerCase()
    .replace(/[`*_~<>[\]()#|]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

/**
 * Do two targets refer to the same thing?
 *
 * Requires BOTH a minimum absolute overlap and a minimum Jaccard similarity. The
 * absolute floor stops "the agent" matching "the agent" in two unrelated
 * sentences; the ratio stops a long sentence from matching everything simply by
 * containing many tokens.
 */
export function sameTarget(a, b, { minShared = 2, minJaccard = 0.34 } = {}) {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size || !B.size) return false
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  if (shared < minShared) return false
  const union = new Set([...A, ...B]).size
  return shared / union >= minJaccard
}

/** Split prose into sentences, keeping list items and lines as boundaries. */
export function sentences(text) {
  if (!text) return []
  return String(text)
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
}

// --- rule 1: polarity ---------------------------------------------------------

// Negatives are tested FIRST and the positive pattern explicitly excludes a
// following negation. Order matters here: "should not archive" contains "should",
// so a naive positive-first pass classifies every prohibition as a requirement --
// inverting the very signal this rule exists to read.
const NEGATIVE = [
  /\b(?:must|should|shall|will|needs? to|has to|have to)\s+(?:not|never)\b\s*(.+)/i,
  /\b(?:do not|don't|dont|does not|doesn't)\b\s*(.+)/i,
  /\bnever\b\s+(.+)/i,
  /\b(?:stop|avoid|prevent|disable|suppress)\b\s+(.+)/i,
  /\bno longer\b\s+(.+)/i,
]
const POSITIVE = [
  /\b(?:must|should|shall|needs? to|has to|have to)\s+(?!not\b|never\b)(.+)/i,
  /\balways\b\s+(.+)/i,
  /\b(?:enable|ensure)\b\s+(.+)/i,
]

/** Extract normative statements with their polarity and target phrase. */
export function extractDirectives(text) {
  const out = []
  for (const s of sentences(text)) {
    let matched = null
    for (const re of NEGATIVE) {
      const m = s.match(re)
      if (m) { matched = { polarity: 'negative', target: m[1] }; break }
    }
    if (!matched) {
      for (const re of POSITIVE) {
        const m = s.match(re)
        if (m) { matched = { polarity: 'positive', target: m[1] }; break }
      }
    }
    if (!matched) continue
    const tokens = tokenize(matched.target)
    // A one-token target ("must stop") is not specific enough to compare, and
    // pairing on it manufactures conflicts between unrelated issues.
    if (tokens.length < 2) continue
    out.push({ polarity: matched.polarity, target: matched.target.trim(), tokens, quote: s })
  }
  return out
}

// --- rule 2: setting values ---------------------------------------------------

// Durations are the values this pipeline actually argues about (cadences,
// thresholds, retention windows), and they are the ones where a disagreement is
// unambiguous rather than a matter of wording.
const UNIT_MINUTES = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  d: 1440, day: 1440, days: 1440,
  w: 10080, week: 10080, weeks: 10080,
}

/** Parse "every 6h", "45 minutes", "weekly" into minutes, or null. */
export function parseDuration(text) {
  if (!text) return null
  const s = String(text).toLowerCase()
  if (/\bhourly\b/.test(s)) return 60
  if (/\bdaily\b|\bnightly\b/.test(s)) return 1440
  if (/\bweekly\b/.test(s)) return 10080
  const m = s.match(/\b(\d+(?:\.\d+)?)\s*(minutes|minute|mins|min|hours|hour|hrs|hr|days|day|weeks|week|[mhdw])\b/)
  if (!m) return null
  const mult = UNIT_MINUTES[m[2]]
  return mult ? Math.round(parseFloat(m[1]) * mult) : null
}

/**
 * Extract "<setting> ... <duration>" claims.
 *
 * The setting key is the tokens of the sentence MINUS the duration itself, so
 * "run the spec pipeline every 6h" and "run the spec pipeline weekly" produce the
 * same key and different values -- which is exactly the pair worth surfacing.
 */
export function extractSettings(text) {
  const out = []
  for (const s of sentences(text)) {
    const minutes = parseDuration(s)
    if (minutes == null) continue
    const withoutValue = s
      .replace(/\b\d+(?:\.\d+)?\s*(?:minutes|minute|mins|min|hours|hour|hrs|hr|days|day|weeks|week|[mhdw])\b/gi, ' ')
      .replace(/\b(?:hourly|daily|nightly|weekly)\b/gi, ' ')
    const tokens = tokenize(withoutValue)
    if (tokens.length < 2) continue
    out.push({ minutes, tokens, quote: s })
  }
  return out
}

// --- rule 3: add vs remove ----------------------------------------------------

const ADD = /\b(?:add|introduce|create|implement|restore|re-?enable)\b\s+(.+)/i
const REMOVE = /\b(?:remove|delete|drop|revert|retire|rip out|get rid of)\b\s+(.+)/i

/** Extract lifecycle intents (adding vs removing the same artifact). */
export function extractLifecycle(text) {
  const out = []
  for (const s of sentences(text)) {
    const rm = s.match(REMOVE)
    const add = rm ? null : s.match(ADD)
    const m = rm || add
    if (!m) continue
    const tokens = tokenize(m[1])
    if (tokens.length < 2) continue
    out.push({ action: rm ? 'remove' : 'add', tokens, quote: s })
  }
  return out
}

// --- the detector ------------------------------------------------------------

/**
 * Does this sentence explicitly cite the other issue?
 *
 * A sentence that names the other issue by number is commentary ON it, not an
 * independent competing requirement -- so the two are discussing one thing, not
 * disagreeing about it. Measured on the live corpus: this was the single false
 * positive across 70 open issues, where #406 quoted #181's own bug report back
 * ("#181 -- a green check must mean all tests actually ran") and the opposite
 * polarity was the bug statement versus the requirement statement, which is
 * agreement written from two ends.
 */
export function citesIssue(quote, number) {
  return new RegExp(`#${number}(?!\\d)`).test(String(quote || ''))
}

const textOf = (issue) => `${issue.title || ''}\n${issue.body || ''}`

/**
 * Compare every pair of issues and report requirement pairs that cannot both
 * hold. Returns findings sorted deterministically, so the same facts always
 * produce byte-identical output and the artifact is diffable across runs.
 */
export function findConflicts(issues, opts = {}) {
  const parsed = (issues || []).map((i) => ({
    number: i.number,
    title: i.title || '',
    directives: extractDirectives(textOf(i)),
    settings: extractSettings(textOf(i)),
    lifecycle: extractLifecycle(textOf(i)),
  }))

  const findings = []
  const seen = new Set()

  const SUMMARY = {
    polarity: (x, y) => `#${x} and #${y} state opposite requirements about the same behaviour.`,
    value: (x, y) => `#${x} and #${y} specify different values for the same setting.`,
    lifecycle: (x, y) => `#${x} and #${y} disagree on whether the same thing should exist.`,
  }

  const push = (kind, evidence) => {
    // Normalise on the way in rather than trusting call-site order. `gh issue
    // list` does not promise a stable ordering, so deriving the summary text or
    // the evidence order from the loop variables makes the artifact differ
    // run-to-run for identical inputs -- which silently destroys the "diffable
    // across runs" property this file claims, and would show up as phantom churn
    // four times a day once the cadence drops to 6h.
    const ev = [...evidence].sort((p, q) => p.issue - q.issue)
    const pair = ev.map((e) => e.issue)
    // Cross-citation means cooperation, not contradiction. Checked here rather
    // than per-rule so all three rules inherit it.
    if (citesIssue(ev[0].quote, pair[1]) || citesIssue(ev[1].quote, pair[0])) return
    const key = `${kind}:${pair[0]}:${pair[1]}`
    // One finding per issue pair per kind. Long issues restate their own
    // requirement several times, and without this the report shows the same
    // disagreement a dozen times and reads as a dozen problems.
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ kind, issues: pair, summary: SUMMARY[kind](pair[0], pair[1]), evidence: ev })
  }

  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i]
      const b = parsed[j]

      // Rule 1: one requires it, the other forbids it.
      for (const da of a.directives) {
        for (const db of b.directives) {
          if (da.polarity === db.polarity) continue
          if (!sameTarget(da.tokens, db.tokens, opts)) continue
          push('polarity', [
            { issue: a.number, polarity: da.polarity, quote: da.quote },
            { issue: b.number, polarity: db.polarity, quote: db.quote },
          ])
        }
      }

      // Rule 2: same setting, different value.
      for (const sa of a.settings) {
        for (const sb of b.settings) {
          if (sa.minutes === sb.minutes) continue
          if (!sameTarget(sa.tokens, sb.tokens, opts)) continue
          push('value', [
            { issue: a.number, minutes: sa.minutes, quote: sa.quote },
            { issue: b.number, minutes: sb.minutes, quote: sb.quote },
          ])
        }
      }

      // Rule 3: one adds it, the other removes it.
      for (const la of a.lifecycle) {
        for (const lb of b.lifecycle) {
          if (la.action === lb.action) continue
          if (!sameTarget(la.tokens, lb.tokens, opts)) continue
          push('lifecycle', [
            { issue: a.number, action: la.action, quote: la.quote },
            { issue: b.number, action: lb.action, quote: lb.quote },
          ])
        }
      }
    }
  }

  findings.sort((x, y) =>
    x.issues[0] - y.issues[0] || x.issues[1] - y.issues[1] || x.kind.localeCompare(y.kind))
  return findings
}

// --- decisions ----------------------------------------------------------------

/**
 * Build the decisions-only payload.
 *
 * #470 asks that the catch-up doc surface "only decisions". A decision is
 * something that needs Shiv's judgement and cannot be resolved by re-running
 * anything -- which is exactly a conflict between two requirements. Spec prose
 * that merely got reworded is NOT a decision and is deliberately excluded, since
 * at 4 runs a day that churn is what would bury the signal.
 */
export function buildDecisions(facts, conflicts) {
  return {
    generatedAt: new Date().toISOString(),
    commit: facts?.commit ?? 'unknown',
    counts: {
      openIssues: facts?.issues?.length ?? 0,
      conflicts: conflicts.length,
    },
    // Kept as an explicit field so a consumer never has to infer "no conflicts"
    // from an empty array it might simply have failed to read.
    hasDecisions: conflicts.length > 0,
    decisions: conflicts.map((c) => ({
      kind: c.kind,
      issues: c.issues,
      question: c.summary,
      evidence: c.evidence,
    })),
  }
}

/** Render the decisions as markdown for a PR body or the catch-up doc. */
export function renderMarkdown(decisions) {
  if (!decisions.hasDecisions) {
    return '## Decisions needed\n\nNone. No conflicting requirements were detected in the open issues.\n'
  }
  const lines = ['## Decisions needed', '',
    `${decisions.decisions.length} conflicting requirement pair(s) were detected. ` +
    'Each needs a call from you; nothing downstream can resolve them.', '']
  for (const d of decisions.decisions) {
    lines.push(`### ${d.question}`, '')
    for (const e of d.evidence) {
      const tag = e.polarity ?? e.action ?? (e.minutes != null ? `${e.minutes} min` : '')
      lines.push(`- **#${e.issue}**${tag ? ` (${tag})` : ''}: ${e.quote}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// --- CLI ---------------------------------------------------------------------

// Hand-rolling this comparison with a `file://` template literal is wrong on
// Windows -- Node emits `file:///V:/...` (three slashes) for an absolute path
// while the naive form builds `file://V:/...`, so the CLI silently never runs
// and the command exits 0 having produced nothing. `pathToFileURL` is the
// platform-correct answer and was worth reaching for the moment a drive letter
// appeared.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const val = (flag, dflt) => {
    const i = args.indexOf(flag)
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt
  }
  const factsPath = val('--facts', 'spec-facts.json')
  const outPath = val('--out', 'spec-decisions.json')
  const mdPath = val('--md', null)

  const facts = JSON.parse(readFileSync(factsPath, 'utf8'))
  const conflicts = findConflicts(facts.issues || [])
  const decisions = buildDecisions(facts, conflicts)

  writeFileSync(outPath, JSON.stringify(decisions, null, 2), 'utf8')
  if (mdPath) writeFileSync(mdPath, renderMarkdown(decisions), 'utf8')

  process.stdout.write(
    `[conflicts] scanned ${decisions.counts.openIssues} open issues -> ` +
    `${decisions.counts.conflicts} conflicting requirement pair(s) -> ${outPath}\n`,
  )
  // Exit 0 even with findings: a conflict is information for a human, not a
  // broken build. Failing here would make the spec job red four times a day for
  // a disagreement between two issues, and a permanently-red job is one nobody
  // reads -- the same muting this file exists to avoid.
}
