// mutcheck-issue-comments.mjs — prove the issue-comment provenance reader (GH #453) actually holds.
//
// The reader in lib-issue-comments.mjs makes five claims. Each is asserted here by NEUTERING it in
// the real source and requiring the answer to change. A mutation that does not change the answer
// means that guard is decoration, and this file fails.
//
//   1. Every newly posted agentic comment carries a provenance marker. (acceptance #1)
//   2. "The agentic comment" is resolved by MARKER, never by count or position. (acceptance #2)
//   3. An unmarked comment is never edited, under any path. Zero marked means POST. (acceptance #3)
//   4. The pre-existing comments are adopted by explicit id, so they are not duplicated. (#4)
//   5. Nothing infers authorship from the doc-link prefix or any other body content. (#5)
//
// Method: the REAL module source is mutated textually and imported. No reimplementation of the
// reader lives in this file — a guard that grades its own copy grades nothing.
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'lib-issue-comments.mjs')
// Normalised to LF before any mutation is applied. The working tree is CRLF on Windows, so
// patterns written with `\n` would silently match NOTHING and every mutation would "survive" for
// a reason unrelated to the reader. A mutation that fails to apply is reported as a failure below
// rather than counted as a kill.
const SOURCE = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
const TMP = mkdtempSync(join(tmpdir(), 'mutcheck-issue-comments-'))

let counter = 0
// Sibling `lib-*.mjs` modules are copied alongside each mutant. The harness mutates ONE file and
// imports it from a temp directory, so a relative import that resolves fine in the repo (and in
// the flat OA home, where every check lands in one directory) resolves to nothing here. Copying
// the siblings keeps the shared helper single-sourced instead of duplicating it per library to
// suit the test harness — the tail wagging the dog, and a second copy is a second thing to drift.
const SIBLINGS = readdirSync(HERE).filter((f) => /^lib-.*\.mjs$/.test(f) && f !== 'lib-issue-comments.mjs')
for (const f of SIBLINGS) writeFileSync(join(TMP, f), readFileSync(join(HERE, f), 'utf8'), 'utf8')

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

const MARKER = '<!-- from: overnight-agent -->'

// The opening signature every pre-existing agentic comment shares. Present ONLY so arm E can
// prove the module does not read it. It must never become a discriminator: Shiv can paste this
// line, and then his comment is adoptable and overwritable — the data-loss path #453 exists to
// close, reintroduced by its own fix.
const DOC_LINK_PREFIX =
  '📄 **[Catch-up doc — Task 468](https://docs.google.com/document/d/1PprnoEl17N4KOYgDFbc5dh4sSE_gWBxc7ko8E7E4dIc/edit)**'

// A real human comment, in his voice, on one of the issues in the roster.
const SHIV = { id: 9001, body: 'Double check if it is shipped then why is it waiting' }

const AGENT = { id: 9002, body: `${MARKER}\n${DOC_LINK_PREFIX}\n\nWhere this stands: shipped.` }

// ---------------------------------------------------------------------------------------------
// ARMS — each returns null on pass, or a string describing the failure.
// ---------------------------------------------------------------------------------------------

const ARMS = [
  {
    name: 'A_a_posted_comment_is_stamped_and_the_stamp_is_idempotent',
    why: 'acceptance #1 — an unstamped comment is indistinguishable from his the moment he replies',
    run: async (m) => {
      const once = m.stampIssueComment('Where this stands: shipped.')
      if (!m.isAgentComment(once)) return 'a freshly stamped comment did not read as the agent comment'
      if (once.split(/\r?\n/)[0] !== MARKER) return `marker is not the first line: ${JSON.stringify(once.slice(0, 40))}`
      const twice = m.stampIssueComment(once)
      if (twice !== once) return 'stamping twice changed the body — the marker would accumulate'
      if (m.unstampIssueComment(once) !== 'Where this stands: shipped.') {
        return `unstamp did not round-trip: ${JSON.stringify(m.unstampIssueComment(once))}`
      }
      return null
    },
  },
  {
    name: 'B_resolution_reads_the_marker_not_the_count',
    why: 'acceptance #2 — the contract was satisfied by there happening to be exactly one comment',
    run: async (m) => {
      // The exact situation that breaks the old contract: TWO comments, both authored
      // `shivbijlani`, his newest. Counting cannot tell them apart; the marker can.
      const v = m.resolveAgenticComment([AGENT, SHIV])
      if (v.action !== 'edit') return `expected edit, got ${v.action} (${v.reason})`
      if (v.commentId !== AGENT.id) return `resolved to comment ${v.commentId}, expected the agent's ${AGENT.id}`
      // ...and position must not decide it either: same pair, reversed.
      const rev = m.resolveAgenticComment([SHIV, AGENT])
      if (rev.commentId !== AGENT.id) return `order changed the answer: got ${rev.commentId}`
      return null
    },
  },
  {
    name: 'C_an_unmarked_comment_is_never_edited',
    why: 'acceptance #3 — fail closed; overwriting his comment is the destructive failure',
    run: async (m) => {
      // Only his comment exists. The tempting fallback is "edit the most recent one", and the
      // most recent one is HIS. It must post instead.
      const v = m.resolveAgenticComment([SHIV])
      if (v.action !== 'post') return `expected post on an unmarked-only issue, got ${v.action}`
      if (v.commentId !== null) return `handed back comment id ${v.commentId} to edit`
      // An empty issue behaves the same way.
      if (m.resolveAgenticComment([]).action !== 'post') return 'an issue with no comments did not resolve to post'
      // Two marked comments means an earlier invariant already broke: refuse rather than guess,
      // because picking one silently discards the other.
      const two = m.resolveAgenticComment([AGENT, { id: 9003, body: `${MARKER}\nolder` }])
      if (two.action !== 'refuse') return `two marked comments resolved to ${two.action}, expected refuse`
      return null
    },
  },
  {
    name: 'D_a_quoted_marker_does_not_steal_a_human_comment',
    why: 'a reply that quotes the agent must stay his, or the fix creates the loss it prevents',
    run: async (m) => {
      const quoting = { id: 9004, body: `Re your note:\n\n> ${MARKER}\n> Where this stands: shipped.\n\nDisagree.` }
      if (m.isAgentComment(quoting.body)) return 'a comment QUOTING the marker was read as the agent\'s'
      const v = m.resolveAgenticComment([quoting])
      if (v.action !== 'post') return `a quoting human comment resolved to ${v.action}, expected post`

      // The case blockquote syntax does NOT cover, and the one that actually happens: he pastes
      // the agent's comment underneath his own reply, so the marker sits on a bare line that is
      // not the first. Anchoring to the first non-empty line is what keeps this his; a search
      // anywhere in the body hands his comment over to be edited.
      const pastedBelow = {
        id: 9006,
        body: `Disagree with this framing.\n\nFor reference, what you wrote:\n\n${MARKER}\nWhere this stands: shipped.`,
      }
      if (m.isAgentComment(pastedBelow.body)) {
        return 'a human comment was claimed because it contained the marker further down'
      }
      const below = m.resolveAgenticComment([pastedBelow])
      if (below.action !== 'post') return `a pasted-marker human comment resolved to ${below.action}, expected post`
      return null
    },
  },
  {
    name: 'E_authorship_is_never_inferred_from_the_body',
    why: 'acceptance #5 — the doc-link prefix must seed the backfill and nothing more',
    run: async (m) => {
      // Shiv pastes the prefix. Under a prefix-based discriminator this becomes adoptable and
      // overwritable, which is precisely the data-loss path, reintroduced by the fix.
      const pasted = { id: 9005, body: `${DOC_LINK_PREFIX}\n\nI disagree with this whole framing.` }
      if (m.isAgentComment(pasted.body)) return 'a comment was claimed as the agent\'s because of its prefix'
      const v = m.resolveAgenticComment([pasted])
      if (v.action !== 'post') return `a prefix-only comment resolved to ${v.action}, expected post`
      // Structural, not behavioural: the prefix must not appear in the module's CODE, so it
      // cannot be reached for later. A behavioural arm alone would pass against a module that
      // merely happens not to call its own prefix helper yet.
      //
      // Full-line `//` comments are stripped first, because the module DOCUMENTS the trap at
      // length and must be able to keep doing so. Prose explaining why the prefix is forbidden is
      // the opposite of a prefix discriminator; conflating them would force the file to stop
      // saying why, which is how the reason gets lost and the trap gets rebuilt.
      const code = readFileSync(SRC, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n')
      if (/docs\.google\.com|Catch-up doc/.test(code)) {
        return 'the module has a doc-link prefix in its CODE; it must not be able to read one'
      }
      return null
    },
  },
  {
    name: 'F_the_backfill_roster_is_by_id_and_matches_the_issue',
    why: 'acceptance #4 — unadoptable comments get DUPLICATED, not stranded, on the next pass',
    run: async (m) => {
      const roster = m.BACKFILL_COMMENT_IDS
      if (!Array.isArray(roster) || roster.length !== 5) {
        return `expected 5 roster entries, got ${roster && roster.length}`
      }
      // The exact ids verified against `gh api` on 2026-09-03. Wrong ids here would stamp the
      // wrong comment, and stamping one of HIS makes it editable — the failure this closes.
      const want = [
        [261, 5535544915], [422, 5530190335], [421, 5533727007],
        [424, 5531015978], [442, 5535563840],
      ]
      for (const [issue, id] of want) {
        if (!roster.some((r) => r.issue === issue && r.id === id)) return `roster is missing #${issue} / ${id}`
      }
      if (roster.some((r) => typeof r.id !== 'number')) return 'a roster entry is not addressed by numeric id'
      return null
    },
  },
  {
    name: 'G_the_edit_verdict_is_usable_by_a_caller_that_reads_dot_id',
    why: 'GH #462 trap 2 — `resolved.id` read undefined on an EDIT verdict, so the caller posted a duplicate',
    run: async (m) => {
      // The caller from GH #457, reproduced in shape rather than described: duck-type on `.id`.
      const branch = (comments) => {
        const r = m.resolveAgenticComment(comments)
        return r && r.id ? `edit:${r.id}` : 'post'
      }
      if (branch([AGENT, SHIV]) !== `edit:${AGENT.id}`) {
        return `a caller reading .id on an EDIT verdict got ${branch([AGENT, SHIV])} — this is the duplicate-posting path`
      }
      // The alias must not become a second, disagreeing source of truth.
      const v = m.resolveAgenticComment([AGENT, SHIV])
      if (v.id !== v.commentId) return `id (${v.id}) and commentId (${v.commentId}) disagree`
      // ...and it must stay falsy where editing is unsafe, or the alias BECOMES the bug.
      if (m.resolveAgenticComment([SHIV]).id) return 'a post verdict handed back a truthy id'
      if (m.resolveAgenticComment([AGENT, { id: 9003, body: `${MARKER}\nolder` }]).id) {
        return 'a refuse verdict handed back a truthy id — that would edit one of two marked comments'
      }
      return null
    },
  },
  {
    name: 'H_the_write_helper_owns_the_branch_so_no_caller_can_get_it_wrong',
    why: 'GH #462 acceptance — a caller using the documented entry point cannot produce a second comment',
    run: async (m) => {
      // Effects are injected, so this asserts WHICH HTTP writes happen without touching GitHub.
      const harness = (comments) => {
        const writes = []
        const run = (args) => {
          if (!args.includes('-X')) return JSON.stringify(comments) // the read
          writes.push(args.join(' '))
          return JSON.stringify({ id: 777 })
        }
        return { writes, run, writeFile: (b) => { harnessBody = b; return '/tmp/body.md' } }
      }
      let harnessBody = null

      // One marked comment AND his reply: must PATCH the agent's comment, and post nothing.
      let h = harness([AGENT, SHIV])
      let res = m.writeAgenticComment({ repo: 'o/r', issue: 7, body: 'update', run: h.run, writeFile: h.writeFile })
      if (res.action !== 'edit') return `one marked comment resolved to ${res.action}`
      if (h.writes.length !== 1) return `expected exactly one write, got ${h.writes.length}`
      if (!h.writes[0].includes('PATCH') || !h.writes[0].includes(`comments/${AGENT.id}`)) {
        return `edit did not PATCH the agent's comment: ${h.writes[0]}`
      }
      if (h.writes.some((w) => w.includes('POST'))) return 'an EDIT verdict still POSTed — this is the duplicate'
      // The body it wrote must be stamped, or next pass cannot find it and posts a second one.
      if (!m.isAgentComment(harnessBody)) return 'the written body was not stamped'

      // No marked comment: post exactly one.
      h = harness([SHIV])
      res = m.writeAgenticComment({ repo: 'o/r', issue: 7, body: 'first', run: h.run, writeFile: h.writeFile })
      if (res.action !== 'post') return `no marked comment resolved to ${res.action}`
      if (h.writes.length !== 1 || !h.writes[0].includes('POST')) return `expected one POST, got ${JSON.stringify(h.writes)}`

      // Two marked: THROW, and — the part that matters — write nothing at all.
      h = harness([AGENT, { id: 9003, body: `${MARKER}\nolder` }])
      let threw = false
      try {
        m.writeAgenticComment({ repo: 'o/r', issue: 7, body: 'x', run: h.run, writeFile: h.writeFile })
      } catch { threw = true }
      if (!threw) return 'two marked comments did not throw — refusal returned quietly and can be ignored'
      if (h.writes.length !== 0) return `refusal still wrote: ${JSON.stringify(h.writes)}`
      return null
    },
  },
]

// ---------------------------------------------------------------------------------------------
// MUTATIONS — each restores a different version of the hole. Each MUST be killed.
// ---------------------------------------------------------------------------------------------

const MUTATIONS = [
  {
    name: 'edit_the_only_comment_regardless_of_marker',
    breaks: 'restores the count-based contract — one comment means edit it, even when it is his',
    apply: (s) => s.replace('if (marked.length === 1) {', 'if (rows.length === 1) {')
      .replace('const id = marked[0].id', 'const id = rows[0].id'),
  },
  {
    name: 'fall_back_to_editing_the_newest_when_none_is_marked',
    breaks: 'the destructive fallback: the newest comment is very often his reply',
    apply: (s) => s.replace(
      "return { action: 'post', commentId: null, id: null, marked, unmarked, reason: 'no-marked-comment' }",
      "return { action: 'edit', commentId: rows.length ? rows[rows.length - 1].id : null, id: null, marked, unmarked, reason: 'no-marked-comment' }"),
  },
  {
    name: 'guess_when_several_are_marked',
    breaks: 'picking one of two marked comments silently discards the other',
    apply: (s) => s.replace(
      "return { action: 'refuse', commentId: null, id: null, marked, unmarked, reason: 'multiple-marked-comments' }",
      "return { action: 'edit', commentId: marked[0].id, id: marked[0].id, marked, unmarked, reason: 'multiple-marked-comments' }"),
  },
  {
    name: 'marker_anywhere_in_the_body',
    breaks: 'a human QUOTING the agent has their own comment read as the agent\'s, and edited',
    apply: (s) => s.replace(
      'for (const line of String(body ?? \'\').split(/\\r?\\n/)) {\n    if (line.trim() === \'\') continue\n    return MARKER_RE.test(line)\n  }\n  return false',
      'return String(body ?? \'\').split(/\\r?\\n/).some((line) => MARKER_RE.test(line))'),
  },
  {
    name: 'stamp_is_not_idempotent',
    breaks: 'the marker accumulates on every pass, one line per run, forever',
    apply: (s) => s.replace('if (isAgentComment(text)) return text', 'if (false) return text'),
  },
  {
    name: 'stamp_goes_to_the_bottom',
    breaks: 'appending to a body displaces the marker and the comment stops being adoptable',
    apply: (s) => s.replace('return `${ISSUE_AGENT_MARKER}\\n${text}`', 'return `${text}\\n${ISSUE_AGENT_MARKER}`'),
  },
  {
    name: 'roster_loses_an_entry',
    breaks: 'a stranded comment is DUPLICATED on the next pass, not merely left alone',
    apply: (s) => s.replace('  { issue: 261, id: 5535544915 },\n', ''),
  },
  {
    name: 'verdict_drops_the_id_alias',
    breaks: 'GH #462 trap 2 — a caller duck-typing on `.id` reads undefined on an EDIT verdict and posts a duplicate',
    apply: (s) => s.replace(
      "return { action: 'edit', commentId: id, id, marked, unmarked, reason: 'one-marked-comment' }",
      "return { action: 'edit', commentId: id, marked, unmarked, reason: 'one-marked-comment' }"),
  },
  {
    // NOTE: disabling the refuse check ALONE does not restore the hole, and that is worth knowing
    // rather than working around — control then falls to the unrecognised-action throw at the
    // bottom, which stops it a second time. The defence is genuinely two-deep. To model the real
    // GH #462 outcome the mutation has to remove the stop AND route the verdict into a write,
    // which is exactly what a caller re-implementing the branch did.
    name: 'write_helper_falls_through_to_post_on_refuse',
    breaks: 'the exact GH #462 outcome, one level up: a verdict that means STOP becomes a third comment',
    apply: (s) => s.replace("if (verdict.action === 'refuse') {", 'if (false) {')
      .replace("if (verdict.action === 'post') {", 'if (true) {'),
  },
  {
    name: 'write_helper_refusal_returns_quietly_instead_of_throwing',
    breaks: 'a refusal that can be ignored by the same inattention that caused the bug is not a refusal',
    apply: (s) => s.replace("if (verdict.action === 'refuse') {", 'if (false) {')
      .replace('throw new Error(`unrecognised verdict action', 'return ({ ok: false }) || new Error(`unrecognised verdict action'),
  },
  {
    name: 'write_helper_posts_instead_of_editing',
    breaks: 'the duplicate itself: a resolvable EDIT verdict still adds a second comment',
    apply: (s) => s.replace("if (verdict.action === 'edit') {", 'if (false) {'),
  },
  {
    name: 'write_helper_does_not_stamp',
    breaks: 'an unstamped comment is unfindable next pass, so the duplicate arrives one run later instead of now',
    apply: (s) => s.replace('const stamped = stampIssueComment(body)', 'const stamped = String(body ?? \'\')'),
  },
]

// ---------------------------------------------------------------------------------------------

async function runArms(mod) {
  const failures = []
  for (const arm of ARMS) {
    let res
    try {
      res = await arm.run(mod)
    } catch (err) {
      res = `threw: ${err.message}`
    }
    if (res) failures.push({ arm: arm.name, res })
  }
  return failures
}

console.log('\nmutcheck-issue-comments — GH #453 agentic issue-comment provenance\n')

const baseline = await load(null)
const baseFailures = await runArms(baseline)
for (const arm of ARMS) {
  const bad = baseFailures.find((f) => f.arm === arm.name)
  console.log(`  ${bad ? 'FAIL' : 'pass'}  baseline  ${arm.name}${bad ? `\n        ${bad.res}` : ''}`)
}

let problems = baseFailures.length
console.log('')

for (const mutation of MUTATIONS) {
  let killers = []
  try {
    const mod = await load(mutation)
    killers = (await runArms(mod)).map((f) => f.arm)
  } catch (err) {
    console.log(`  ERROR     ${mutation.name}  (${err.message})`)
    problems++
    continue
  }
  if (killers.length === 0) {
    console.log(`  SURVIVED  ${mutation.name}  -- ${mutation.breaks}`)
    problems++
  } else {
    console.log(`  killed    ${mutation.name}  by ${killers.length} arm(s): ${killers[0]}`)
  }
}

console.log(`\n${ARMS.length} arms, ${MUTATIONS.length} mutations, ${problems} failure(s).\n`)
process.exit(problems ? 1 : 0)
