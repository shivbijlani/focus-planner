// mutcheck-doc-comments.mjs — prove the doc-comment attribution reader (GH #422) actually holds.
//
// The reader in lib-doc-comments.mjs makes four claims. Each is asserted here by NEUTERING it in
// the real source and requiring the answer to change. If a mutation does not change the answer,
// that guard is decoration and this file fails.
//
//   1. An agent-authored comment carrying `approve` does NOT return consent_ok. (acceptance #2)
//   2. Agent and human comments partition exactly, with zero misattributions, WITHOUT inspecting
//      writing style. (acceptance #1)
//   3. Reading fails OPEN; consent fails CLOSED. Opposite defaults, on purpose.
//   4. The API's own author field is read but never trusted.
//
// Method: the REAL module source is mutated textually and imported. No reimplementation of the
// reader lives in this file — a guard that grades its own copy grades nothing.
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'lib-doc-comments.mjs')
// Normalised to LF before any mutation is applied. The working tree is CRLF on Windows, so
// patterns written with `\n` silently matched NOTHING and every mutation "survived" for a reason
// that had nothing to do with the reader. A mutation that fails to apply is reported as a failure
// below rather than counted as a kill, which is how that was caught — but normalising here means
// the patterns stay readable and cannot rot the moment `.gitattributes` changes. Line endings are
// semantically irrelevant to the module under test.
const SOURCE = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
const TMP = mkdtempSync(join(tmpdir(), 'mutcheck-doc-comments-'))

let counter = 0
async function load(mutation) {
  let src = SOURCE
  if (mutation) {
    const next = mutation.apply(src)
    if (next === src) throw new Error(`mutation ${mutation.name} did not change the source`)
    src = next
  }
  const file = join(TMP, `m${counter++}.mjs`)
  writeFileSync(file, src, 'utf8')
  return import(pathToFileURL(file).href)
}

// ---------------------------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------------------------

// VERBATIM shape of the live `list_document_comments` dump, measured 2026-09-03 against the one
// catch-up doc that exists (task #228, doc 16F7lGso6NUAZjz2aeThKPkDvr1EVFfYrHWZre6XwaNU).
// Every Author line says `Shiv Bijlani` — including the four replies the agent wrote. That is the
// defect #422 exists for, so it is the fixture, not a simplification of it.
const LIVE_DUMP = `Found 4 comments in document 16F7lGso6NUAZjz2aeThKPkDvr1EVFfYrHWZre6XwaNU:

Comment ID: AAACAbx8RrQ
Author: Shiv Bijlani
Created: 2026-09-02T16:18:38.650Z
Quoted text: Wed
Content: It's there a sat to Wed option
  Replies (1):
    Reply ID: AAACGdxf9QE
    Author: Shiv Bijlani
    Created: 2026-09-02T17:14:29.487Z
    Content: Yes — priced it just now. Sat 14 out, Kiley home Wed 25: 10 nights in Dubai, $980 per person nonstop.

Comment ID: AAACAbx8RrM
Author: Shiv Bijlani
Created: 2026-09-02T16:17:12.885Z
Quoted text: History
Content: Skip
  Replies (1):
    Reply ID: AAACGdxf9QA
    Author: Shiv Bijlani
    Created: 2026-09-02T17:14:29.174Z
    Content: Done — History section removed.
`

// The backfill ledger for the doc above: the reply ids the agent posted on 2026-09-02, recorded
// by id because the Docs API exposes no comment-update call, so the marker cannot be added to a
// comment after the fact. Acceptance #3 requires these eight be handled EXPLICITLY rather than
// silently classified; recording them by exact id is that handling.
const LIVE_LEDGER = { comments: [{ id: 'AAACGdxf9QE' }, { id: 'AAACGdxf9QA' }] }

const MARKER = '-- overnight-agent [oa-comment:v1]'

// The live task-228 catch-up doc, and the real ids measured on it 2026-09-03. These are the
// eight replies the agent wrote (journal task-228.md: a 3-comment pass then a 5-comment pass)
// and the eight top-level comments Shiv wrote. The API reports ONE author for all sixteen.
const DOC_228 = '16F7lGso6NUAZjz2aeThKPkDvr1EVFfYrHWZre6XwaNU'
const REPLIES_228 = ['AAACGb8YArw', 'AAACGb8YAr0', 'AAACGb8YAr4', 'AAACGdxf9QA',
  'AAACGdxf9QE', 'AAACGdxf9QI', 'AAACGdxf9QM', 'AAACGdxf9QU']
const COMMENTS_228 = ['AAACAbx8RrQ', 'AAACAbx8RrM', 'AAACAbx8RrI', 'AAACAbx8RrE',
  'AAACAbx8RrA', 'AAACGVkt6-k', 'AAACGVkt6-g', 'AAACGVkt6-c']

function entries(...rows) {
  return rows.map((r, i) => ({
    id: r.id ?? `c${i}`,
    kind: r.kind ?? 'comment',
    parentId: r.parentId ?? null,
    author: r.author ?? 'Shiv Bijlani', // the API always says this — for BOTH of us
    created: r.created ?? '2026-09-03T00:00:00.000Z',
    quoted: null,
    content: r.content,
  }))
}

// ---------------------------------------------------------------------------------------------
// ARMS — each returns null on pass, or a string describing the failure.
// ---------------------------------------------------------------------------------------------

const ARMS = [
  {
    name: 'A_agent_approve_is_not_consent',
    why: 'acceptance #2 — the agent must not be able to authorise itself through a comment',
    run: async (m) => {
      const rows = entries({ id: 'r1', content: `approve — shipping it now.\n\n${MARKER}` })
      const v = m.consentView(rows, {})
      if (v.consent_ok) return `consent_ok true on an agent-stamped "approve" (reason=${v.reason})`
      if (!v.affirmative_unattributed) return 'the refused affirmative was dropped instead of surfaced'
      if (v.reason !== 'affirmative-not-attributable-to-human') return `reason=${v.reason}`
      return null
    },
  },
  {
    name: 'B_unmarked_approve_is_also_not_consent',
    why: 'absence of the agent marker is NOT proof of a human (#227 in a new channel)',
    run: async (m) => {
      const rows = entries({ id: 'r1', content: 'approve' })
      const v = m.consentView(rows, {})
      if (v.consent_ok) return `consent_ok true on an UNATTRIBUTED "approve" (reason=${v.reason})`
      return null
    },
  },
  {
    name: 'C_partition_is_exact',
    why: 'acceptance #1 — agent vs non-agent split with zero misattributions, no style inspection',
    run: async (m) => {
      const rows = entries(
        { id: 'a1', content: `Done — removed.\n\n${MARKER}` }, // agent, by marker
        { id: 'a2', content: 'Priced it: $980pp.' },           // agent, by ledger only
        { id: 'h1', content: 'Skip' },                          // not provably agent
      )
      const got = m.attribute(rows, { comments: [{ id: 'a2' }] })
      const by = Object.fromEntries(got.map((r) => [r.id, r.author]))
      if (by.a1 !== 'agent') return `marked comment read as ${by.a1}`
      if (by.a2 !== 'agent') return `ledger comment read as ${by.a2}`
      if (by.h1 !== 'unknown') return `unattributed comment read as ${by.h1}`
      return null
    },
  },
  {
    name: 'D_ledger_alone_attributes',
    why: 'a body edit or a lost marker must not turn an agent comment into a possible instruction',
    run: async (m) => {
      const got = m.attribute(entries({ id: 'x', content: 'no marker here' }), { comments: [{ id: 'x' }] })
      if (got[0].author !== 'agent') return `ledger-only comment read as ${got[0].author}`
      return null
    },
  },
  {
    name: 'E_marker_alone_attributes',
    why: 'a lost/rebuilt ledger, or another machine, must still recognise the agent',
    run: async (m) => {
      const got = m.attribute(entries({ id: 'x', content: `hi\n\n${MARKER}` }), {})
      if (got[0].author !== 'agent') return `marker-only comment read as ${got[0].author}`
      return null
    },
  },
  {
    name: 'F_quoted_marker_does_not_steal_the_comment',
    why: 'a human quoting the agent must NOT have their instruction attributed to the agent',
    run: async (m) => {
      const body = `You said:\n${MARKER}\nbut I disagree — use option 6 instead.`
      const got = m.attribute(entries({ id: 'q', content: body }), {})
      if (got[0].author === 'agent') return 'a mid-body (quoted) marker was accepted as a stamp'
      const view = m.readingView(entries({ id: 'q', content: body }), {})
      if (!view[0].treatAsInstruction) return 'the quoted-marker comment was dropped as an instruction'
      return null
    },
  },
  {
    name: 'G_reading_fails_open',
    why: 'over-offering costs a re-read; under-offering silently drops one of Shiv instructions',
    run: async (m) => {
      const view = m.readingView(entries(
        { id: 'u', content: 'use option 6' },
        { id: 'a', content: `ok\n\n${MARKER}` },
      ), {})
      const by = Object.fromEntries(view.map((r) => [r.id, r.treatAsInstruction]))
      if (by.u !== true) return 'an unattributed comment was NOT offered as an instruction'
      if (by.a !== false) return 'the agent own reply was offered back as an instruction'
      return null
    },
  },
  {
    name: 'H_api_author_is_never_trusted',
    why: 'the API stamps both halves `Shiv Bijlani`; believing it is the defect',
    run: async (m) => {
      const rows = entries({ id: 'a', author: 'Shiv Bijlani', content: `approve\n\n${MARKER}` })
      const got = m.attribute(rows, {})
      if (got[0].author !== 'agent') return `API author overrode the marker (${got[0].author})`
      if (got[0].apiAuthor !== 'Shiv Bijlani') return 'apiAuthor was not carried through for audit'
      return null
    },
  },
  {
    name: 'I_live_dump_partitions',
    why: 'the reader must work on the surface the MCP actually returns, not a tidied shape',
    run: async (m) => {
      const parsed = m.parseCommentDump(LIVE_DUMP)
      if (parsed.length !== 4) return `parsed ${parsed.length} entries, expected 4`
      const got = m.attribute(parsed, LIVE_LEDGER)
      const by = Object.fromEntries(got.map((r) => [r.id, r.author]))
      if (by.AAACGdxf9QE !== 'agent' || by.AAACGdxf9QA !== 'agent') return 'backfilled replies not attributed to the agent'
      if (by.AAACAbx8RrQ === 'agent' || by.AAACAbx8RrM === 'agent') return 'Shiv own comments were attributed to the agent'
      const distinctApi = new Set(got.map((r) => r.apiAuthor))
      if (distinctApi.size !== 1) return 'fixture no longer reproduces the single-author defect'
      return null
    },
  },
  {
    name: 'J_stamp_is_idempotent_and_reversible',
    why: 'a re-stamped body must not accumulate markers, and unstamp must recover the text',
    run: async (m) => {
      const once = m.stampAgentBody('hello')
      const twice = m.stampAgentBody(once)
      if (once !== twice) return 'stampAgentBody is not idempotent'
      if (!m.isStamped(once)) return 'stampAgentBody produced a body isStamped rejects'
      if (m.unstampBody(once) !== 'hello') return `unstampBody returned ${JSON.stringify(m.unstampBody(once))}`
      return null
    },
  },
  {
    name: 'K_consent_vocabulary_matches_the_journal_reader',
    why: 'a word SKILL.md advertises but this reader rejects is silently dropped consent (#301)',
    run: async (m) => {
      const advertised = ['approve', 'approved', 'yes', 'go', 'go ahead', 'lgtm', 'ship it', 'do it',
        'vibe it', 'send it', 'make it so', 'proceed', 'merge 300']
      const missed = advertised.filter((w) => !m.CONSENT_AFFIRM_RE.test(w))
      if (missed.length) return `reader rejects advertised affirmative(s): ${missed.join(', ')}`
      return null
    },
  },
  {
    name: 'L_backfill_ledger_covers_the_eight_task228_replies',
    why: 'acceptance #3 — the pre-marker replies must be handled explicitly, not silently classified',
    run: async (m) => {
      const file = JSON.parse(readFileSync(join(HERE, 'doc-comment-ledger-backfill.json'), 'utf8'))
      const led = m.ledgerForDoc(file, DOC_228)
      const ids = led.comments.map((c) => c.id).sort()
      const expected = [...REPLIES_228].sort()
      if (ids.length !== 8) return `backfill lists ${ids.length} ids for the task-228 doc, expected 8`
      if (ids.join(',') !== expected.join(',')) return `backfill ids drifted from the live reply ids`
      // The eight top-level comments must NOT be in there: absence is not an assertion of human,
      // but PRESENCE would wrongly attribute Shiv's own comments to the agent and drop them.
      const wrong = COMMENTS_228.filter((id) => ids.includes(id))
      if (wrong.length) return `backfill claims Shiv own comment(s) as agent: ${wrong.join(', ')}`
      const unknownDoc = m.ledgerForDoc(file, 'no-such-doc')
      if (unknownDoc.comments.length !== 0) return 'an unknown doc returned a non-empty ledger'
      return null
    },
  },
  {
    name: 'M_merged_ledger_is_a_union',
    why: 'the committed backfill and the live per-run ledger must both count, not shadow each other',
    run: async (m) => {
      // The REAL shape this has to survive: a committed backfill plus an EMPTY live ledger, which
      // is exactly the state on any machine that has not posted a comment yet. A merge where the
      // last argument wins silently discards all eight backfilled ids here — and the previous
      // version of this arm missed that, because its fixture happened to put every id in the last
      // ledger, so union and last-wins agreed. A fixture both answers agree on tests nothing.
      const file = JSON.parse(readFileSync(join(HERE, 'doc-comment-ledger-backfill.json'), 'utf8'))
      const backfill = m.ledgerForDoc(file, DOC_228)
      const live = { comments: [] }
      const merged = m.mergeLedgers(backfill, live)
      if (merged.comments.length !== 8) {
        return `backfill + empty live ledger yielded ${merged.comments.length} ids, expected 8`
      }
      // And it must still dedupe when the same id appears in both.
      const dedup = m.mergeLedgers({ comments: [{ id: 'a' }] }, { comments: [{ id: 'b' }, { id: 'a' }] })
      const ids = dedup.comments.map((c) => c.id).sort().join(',')
      if (ids !== 'a,b') return `mergeLedgers produced ${ids}, expected a,b`
      return null
    },
  },
  {
    name: 'N_the_never_comment_rule_is_opt_in',
    why: 'turning it on WEAKENS a gate, so it must never arrive by default on an existing caller',
    run: async (m) => {
      const rows = entries({ id: 'c1', content: 'approve' })
      const off = m.consentView(rows, {})
      if (off.consent_ok) return 'an unattributed "approve" granted consent with no options passed'
      const on = m.consentView(rows, {}, { neverComment: true })
      if (!on.consent_ok) return `the rule was requested and consent still refused (reason=${on.reason})`
      if (on.affirmative_author !== 'human') return `granted, but author=${on.affirmative_author}`
      return null
    },
  },
  {
    name: 'O_an_agent_comment_after_the_rule_refuses_everything',
    why: 'the rule licenses positive attribution only while it actually holds, re-proven per call',
    run: async (m) => {
      const rows = entries(
        { id: 'c1', content: 'approve' },
        {
          id: 'r1', kind: 'reply', parentId: 'c1',
          created: '2026-09-04T09:00:00.000Z',
          content: `On it.\n\n${MARKER}`,
        },
      )
      const inv = m.neverCommentView(rows, {})
      if (inv.ok) return 'an agent comment written AFTER the rule did not break the invariant'
      if (inv.violations.length !== 1) return `expected 1 violation, got ${inv.violations.length}`
      const v = m.consentView(rows, {}, { neverComment: true })
      if (v.consent_ok) return 'consent granted on a doc the agent had itself commented on'
      if (v.reason !== 'agent-commented-after-rule') return `reason=${v.reason}, expected the violation`
      return null
    },
  },
  {
    name: 'P_pre_rule_agent_replies_are_legacy_not_violations',
    why: 'three real replies predate the rule; counting them would pin the invariant false forever',
    run: async (m) => {
      // The live ids and timestamps on task #468's own catch-up doc, measured 2026-09-04. All
      // three agent replies were written at 00:05Z, before the rule landed at 03:32Z.
      const rows = entries(
        { id: 'AAACGhcT3Qw', created: '2026-09-04T03:32:12.115Z', content: 'approve' },
        { id: 'AAACCk6l6ME', kind: 'reply', created: '2026-09-04T00:05:21.343Z', content: `Filed as #441.\n\n${MARKER}` },
        { id: 'AAACCk6l6MA', kind: 'reply', created: '2026-09-04T00:05:12.779Z', content: `Added to #421.\n\n${MARKER}` },
        { id: 'AAACCk6l6L8', kind: 'reply', created: '2026-09-04T00:05:02.878Z', content: `Filed as #442.\n\n${MARKER}` },
      )
      const inv = m.neverCommentView(rows, {})
      if (!inv.ok) return `pre-rule replies broke the invariant: ${inv.violations.map((v) => v.id).join(', ')}`
      if (inv.legacy.length !== 3) return `expected 3 legacy replies, got ${inv.legacy.length}`
      return null
    },
  },
  {
    name: 'Q_an_undated_agent_comment_is_a_violation',
    why: 'otherwise dropping the timestamp launders a violation into a tolerated legacy row',
    run: async (m) => {
      const rows = entries(
        { id: 'c1', content: 'approve' },
        { id: 'r1', kind: 'reply', parentId: 'c1', content: `On it.\n\n${MARKER}` },
      )
      rows[1].created = ''
      const inv = m.neverCommentView(rows, {})
      if (inv.ok) return 'an agent comment with no readable date was tolerated as legacy'
      const v = m.consentView(rows, {}, { neverComment: true })
      if (v.consent_ok) return 'consent granted despite an undated agent comment on the doc'
      return null
    },
  },
]

// ---------------------------------------------------------------------------------------------
// MUTATIONS — each neuters exactly one guarantee. Each MUST be killed by at least one arm.
// ---------------------------------------------------------------------------------------------

const MUTATIONS = [
  {
    name: 'promote_regardless_of_invariant',
    breaks: 'grants positive attribution even on a doc the agent has itself commented on',
    apply: (s) => s.replace('invariant && invariant.ok', 'invariant'),
  },
  {
    name: 'never_comment_on_by_default',
    breaks: 'weakens the consent gate for every existing caller without them asking for it',
    apply: (s) => s.replace('{ neverComment = false, since', '{ neverComment = true, since'),
  },
  {
    name: 'undated_agent_comment_is_legacy',
    breaks: 'lets a violation launder itself simply by losing its timestamp',
    apply: (s) => s.replace(
      'if (Number.isNaN(at) || Number.isNaN(cutoff) || at >= cutoff) violations.push(row)',
      'if (at >= cutoff) violations.push(row)'),
  },
  {
    name: 'cutoff_swallows_every_violation',
    breaks: 'no agent comment ever counts, so the invariant is decoration over a granted gate',
    apply: (s) => s.replace(
      'if (Number.isNaN(at) || Number.isNaN(cutoff) || at >= cutoff) violations.push(row)',
      'if (false) violations.push(row)'),
  },
  {
    name: 'unknown_becomes_human',
    breaks: 'infers a human from the absence of the agent marker — the #227 hole, mail-merged',
    apply: (s) => s.replace(
      'const author = stamped || inLedger ? AUTHOR.AGENT : AUTHOR.UNKNOWN',
      'const author = stamped || inLedger ? AUTHOR.AGENT : AUTHOR.HUMAN'),
  },
  {
    name: 'trust_api_author',
    breaks: 'believes the API author field, which stamps both halves of the conversation as Shiv',
    apply: (s) => s.replace(
      'const author = stamped || inLedger ? AUTHOR.AGENT : AUTHOR.UNKNOWN',
      'const author = e.author ? AUTHOR.HUMAN : AUTHOR.UNKNOWN'),
  },
  {
    name: 'marker_anywhere',
    breaks: 'accepts a marker anywhere in the body, so quoting the agent steals the comment',
    apply: (s) => s.replace(
      'for (let i = lines.length - 1; i >= 0; i--) {\n    if (lines[i].trim() === \'\') continue\n    return MARKER_RE.test(lines[i])\n  }\n  return false',
      'return lines.some((l) => MARKER_RE.test(l))'),
  },
  {
    name: 'ignore_ledger',
    breaks: 'drops the ledger, so an edited body makes an agent comment look like an instruction',
    apply: (s) => s.replace('const inLedger = known.has(e.id)', 'const inLedger = false'),
  },
  {
    name: 'ignore_marker',
    breaks: 'drops the marker, so a rebuilt ledger loses every attribution it once had',
    apply: (s) => s.replace('const stamped = isStamped(e.content)', 'const stamped = false'),
  },
  {
    name: 'reading_fails_closed',
    breaks: 'only offers provably-human text as an instruction, silently dropping Shiv comments',
    apply: (s) => s.replace(
      'treatAsInstruction: e.author !== AUTHOR.AGENT,',
      'treatAsInstruction: e.author === AUTHOR.HUMAN,'),
  },
  {
    name: 'shrink_consent_vocabulary',
    breaks: 'accepts fewer affirmatives than SKILL.md advertises, so approvals vanish silently',
    apply: (s) => s.replace(
      /export const CONSENT_AFFIRM_RE =\n\s*\/.*\/i/,
      'export const CONSENT_AFFIRM_RE =\n  /(?<![\\w-])(approved?)(?![\\w-])/i'),
  },
  {
    name: 'stamp_not_idempotent',
    breaks: 'appends a second marker every run, so bodies grow a tail of stamps',
    apply: (s) => s.replace('if (isStamped(text)) return text', 'if (false) return text'),
  },
  {
    name: 'ledger_ignores_doc_scoping',
    breaks: 'returns one doc ledger for every doc, so ids leak across documents',
    apply: (s) => s.replace(
      'const entry = docs && docs[docId]',
      'const entry = docs && (docs[docId] || Object.values(docs)[0])'),
  },
  {
    name: 'merge_ledgers_last_wins',
    breaks: 'the live ledger shadows the committed backfill, un-attributing the eight replies',
    apply: (s) => s.replace(
      'for (const l of ledgers) {\n    for (const id of ledgerIds(l)) if (!seen.has(id)) seen.set(id, { id })\n  }',
      'const l = ledgers[ledgers.length - 1]\n  for (const id of ledgerIds(l)) seen.set(id, { id })'),
  },
]

// ---------------------------------------------------------------------------------------------

async function runArms(mod) {
  const results = []
  for (const arm of ARMS) {
    let err = null
    try { err = await arm.run(mod) } catch (e) { err = `threw: ${e.message}` }
    results.push({ arm: arm.name, err })
  }
  return results
}

async function main() {
  const matrix = process.argv.includes('--matrix')
  let failures = 0

  console.log('mutcheck-doc-comments — GH #422 doc-comment attribution\n')

  // 1. Baseline: every arm must pass against the real source.
  const base = await runArms(await load(null))
  const baseFails = base.filter((r) => r.err)
  for (const r of base) console.log(`  ${r.err ? 'FAIL' : 'pass'}  baseline  ${r.arm}${r.err ? `  -- ${r.err}` : ''}`)
  if (baseFails.length) {
    failures += baseFails.length
    console.log(`\nBASELINE BROKEN: ${baseFails.length} arm(s) fail against the unmutated reader.`)
  }
  console.log('')

  // 2. Every mutation must be killed by at least one arm. A survivor means that guarantee is
  //    unasserted — the guard is decoration and the defect can return unnoticed.
  for (const mut of MUTATIONS) {
    let killers = []
    try {
      const res = await runArms(await load(mut))
      killers = res.filter((r) => r.err).map((r) => r.arm)
    } catch (e) {
      console.log(`  FAIL  ${mut.name}  -- mutation could not be applied: ${e.message}`)
      failures++
      continue
    }
    if (!killers.length) {
      console.log(`  SURVIVED  ${mut.name}  -- ${mut.breaks}`)
      failures++
    } else {
      console.log(`  killed    ${mut.name}  by ${matrix ? killers.join(', ') : `${killers.length} arm(s): ${killers[0]}`}`)
    }
  }

  console.log(`\n${ARMS.length} arms, ${MUTATIONS.length} mutations, ${failures} failure(s).`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
