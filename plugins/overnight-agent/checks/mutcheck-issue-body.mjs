// mutcheck-issue-body.mjs — prove the issue-body precondition (GH #456) actually holds.
//
// The primitive in lib-issue-body.mjs makes five claims. Each is asserted by NEUTERING it in the
// real source and requiring the answer to change. A mutation that changes nothing means that guard
// is decoration, and this file fails.
//
//   1. A write is refused when the body moved under the caller. (#456 requirement 2)
//   2. The refusal hands back the LIVE content, so the caller can re-apply instead of forcing.
//   3. The body is re-read immediately before the write — a digest from earlier is not evidence.
//   4. A successful write reports the digest of what is ACTUALLY on the issue. (#456 req 4)
//   5. Append is additive, and still takes the precondition. (#456 requirement 3)
//
// Method: the REAL module source is mutated textually and imported, against an in-memory fake of
// the `gh` transport. No reimplementation of the primitive lives here — a guard that grades its
// own copy grades nothing. Nothing in this file touches the network.
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'lib-issue-body.mjs')
// Normalised to LF before mutation. The working tree is CRLF on Windows, so patterns written with
// `\n` would match NOTHING and every mutation would "survive" for a reason unrelated to the
// primitive. A mutation that fails to apply is reported as a failure rather than counted as a kill.
const SOURCE = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
const TMP = mkdtempSync(join(tmpdir(), 'mutcheck-issue-body-'))

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
// A FAKE `gh`, holding one issue body in memory.
//
// `onRead` fires on every read, so a test can move the body BETWEEN the caller's read and the
// write — which is the only way to exercise a precondition. A fake that cannot change underneath
// the code under test cannot prove anything about concurrency.
// ---------------------------------------------------------------------------------------------
function makeGh(initialBody) {
  const state = { body: initialBody, writes: 0, reads: 0, onRead: null, onWrite: null }
  const run = (args) => {
    const isPatch = args.includes('-X') && args.includes('PATCH')
    if (isPatch) {
      const spec = args.find((a) => a.startsWith('body=@'))
      const sent = readFileSync(spec.slice('body=@'.length), 'utf8')
      // `onWrite` lets a test make the stored body differ from what was sent. That is not
      // hypothetical: a body can come back altered by server-side handling, and a partial write
      // leaves something that is neither the old text nor the new one. Without this the fake can
      // never disagree with the caller, so "read back instead of assuming" is untestable and any
      // guard asserting it grades nothing.
      state.body = state.onWrite ? state.onWrite(sent) : sent
      state.writes++
      return JSON.stringify({ ok: true })
    }
    state.reads++
    if (state.onRead) state.onRead(state)
    return JSON.stringify({ body: state.body })
  }
  const writeFile = (body) => {
    const f = join(TMP, `body-${counter++}.md`)
    writeFileSync(f, body, 'utf8')
    return f
  }
  return { state, run, writeFile }
}

const REPO = 'shivbijlani/focus-planner'
const ORIGINAL = '## Observation\n\nThe original body, five references.'
const MINE = '## Observation\n\nMy rewrite, six references.'
const THEIRS = '## Observation\n\nSomeone else got here first.'

// ---------------------------------------------------------------------------------------------
// ARMS — each returns null on pass, or a string describing the failure.
// ---------------------------------------------------------------------------------------------

const ARMS = [
  {
    name: 'A_an_unmoved_body_is_written_and_reports_a_fresh_digest',
    why: 'the guard must not block the ordinary case, or it gets removed rather than obeyed',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      if (read.body !== ORIGINAL) return 'read returned the wrong body'

      const res = m.updateIssueBody({
        repo: REPO, issue: 456, body: MINE, baseDigest: read.digest, run: gh.run, writeFile: gh.writeFile,
      })
      if (!res.ok) return `an unmoved body was refused (${res.reason})`
      if (gh.state.body !== MINE) return 'the write did not land'
      // Requirement 4: the caller must be handed something checkable, and it must describe what is
      // ACTUALLY on the issue rather than what was sent.
      if (res.digest !== m.bodyDigest(gh.state.body)) return 'the reported digest is not the live body\'s'
      if (res.digest === read.digest) return 'the digest did not advance after a write'
      return null
    },
  },
  {
    name: 'B_a_moved_body_refuses_and_nothing_is_written',
    why: 'requirement 2 — this is the write that would silently destroy the other session\'s text',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      // Someone else writes between the caller's read and its write. This is the whole scenario.
      gh.state.body = THEIRS

      const res = m.updateIssueBody({
        repo: REPO, issue: 456, body: MINE, baseDigest: read.digest, run: gh.run, writeFile: gh.writeFile,
      })
      if (res.ok) return 'a moved body was overwritten'
      if (res.reason !== 'body-moved') return `refused for the wrong reason: ${res.reason}`
      if (gh.state.body !== THEIRS) return 'the other write was clobbered despite the refusal'
      if (gh.state.writes !== 0) return `${gh.state.writes} write(s) issued despite the refusal`
      return null
    },
  },
  {
    name: 'C_the_refusal_hands_back_the_live_content',
    why: 'a refusal without the current text leaves forcing as the only way forward',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      gh.state.body = THEIRS

      const res = m.updateIssueBody({
        repo: REPO, issue: 456, body: MINE, baseDigest: read.digest, run: gh.run, writeFile: gh.writeFile,
      })
      if (res.liveBody !== THEIRS) return `liveBody was ${JSON.stringify(res.liveBody)}, expected the live text`
      if (res.digest !== m.bodyDigest(THEIRS)) return 'the refusal reported a digest that is not the live one'

      // And the handed-back digest must be immediately usable to re-apply. If it is not, the
      // refusal is a dead end and the caller's only route is to force.
      const retry = m.updateIssueBody({
        repo: REPO, issue: 456, body: MINE, baseDigest: res.digest, run: gh.run, writeFile: gh.writeFile,
      })
      if (!retry.ok) return `re-applying onto the returned digest failed (${retry.reason})`
      return null
    },
  },
  {
    name: 'D_the_body_is_re_read_immediately_before_the_write',
    why: 'requirement 1 — a digest taken earlier in the run is not evidence about now',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      const readsAfterFirst = gh.state.reads

      // Move the body DURING the update call itself, on its first read. A precondition compared
      // against the caller's stale value would not notice; one that re-reads does.
      let armed = true
      gh.state.onRead = (s) => {
        if (armed) {
          armed = false
          s.body = THEIRS
        }
      }
      const res = m.updateIssueBody({
        repo: REPO, issue: 456, body: MINE, baseDigest: read.digest, run: gh.run, writeFile: gh.writeFile,
      })
      if (res.ok) return 'the write proceeded from a stale read'
      if (gh.state.reads <= readsAfterFirst) return 'update issued no read of its own before writing'
      return null
    },
  },
  {
    name: 'E_a_missing_precondition_is_refused_not_defaulted',
    why: 'fail closed: absent evidence must not be treated as evidence of no conflict',
    run: async (m) => {
      for (const missing of [undefined, null, '']) {
        const gh = makeGh(ORIGINAL)
        const res = m.updateIssueBody({
          repo: REPO, issue: 456, body: MINE, baseDigest: missing, run: gh.run, writeFile: gh.writeFile,
        })
        if (res.ok) return `a write with baseDigest=${JSON.stringify(missing)} was allowed`
        if (gh.state.writes !== 0) return 'a write was issued with no precondition'
      }
      return null
    },
  },
  {
    name: 'F_append_is_additive_and_still_takes_the_precondition',
    why: 'requirement 3 — additive intent should not travel as a whole-document replace',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      const res = m.appendToIssueBody({
        repo: REPO, issue: 456, addition: '## Update\n\nOne more row.', baseDigest: read.digest,
        run: gh.run, writeFile: gh.writeFile,
      })
      if (!res.ok) return `append was refused on an unmoved body (${res.reason})`
      if (!gh.state.body.startsWith(ORIGINAL)) return 'append replaced the original text instead of adding to it'
      if (!gh.state.body.includes('One more row.')) return 'the addition is missing'

      // Append is safe about LOSS, not about correctness: appending onto a body that moved can
      // duplicate a section the other write already added.
      const gh2 = makeGh(ORIGINAL)
      const r2 = m.readIssueBody({ repo: REPO, issue: 456, run: gh2.run })
      gh2.state.body = THEIRS
      const moved = m.appendToIssueBody({
        repo: REPO, issue: 456, addition: 'x', baseDigest: r2.digest, run: gh2.run, writeFile: gh2.writeFile,
      })
      if (moved.ok) return 'append proceeded onto a moved body'
      if (gh2.state.writes !== 0) return 'append issued a write despite the refusal'
      return null
    },
  },
  {
    name: 'G_the_digest_ignores_line_ending_and_trailing_whitespace_noise',
    why: 'a guard that fires on non-conflicts is one that gets bypassed',
    run: async (m) => {
      const lf = 'line one\nline two'
      if (m.bodyDigest(lf) !== m.bodyDigest('line one\r\nline two')) return 'CRLF changed the digest'
      if (m.bodyDigest(lf) !== m.bodyDigest(`${lf}\n\n`)) return 'trailing whitespace changed the digest'
      // ...but it must still be a digest of the CONTENT, not a constant.
      if (m.bodyDigest(lf) === m.bodyDigest('line one\nline three')) return 'different bodies share a digest'
      return null
    },
  },
  {
    name: 'H_there_is_no_force_escape_hatch',
    why: 'an override is taken under exactly the conditions the guard exists for',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      gh.state.body = THEIRS
      // Every plausible spelling of an override. None may write.
      for (const extra of [{ force: true }, { Force: true }, { overwrite: true }, { ifMatch: false }]) {
        const res = m.updateIssueBody({
          repo: REPO, issue: 456, body: MINE, baseDigest: read.digest,
          run: gh.run, writeFile: gh.writeFile, ...extra,
        })
        if (res.ok) return `a moved body was written with ${JSON.stringify(extra)}`
      }
      if (gh.state.writes !== 0) return 'an override wrote through the precondition'
      // Structural: the source must not name one either, so it cannot be reached for later.
      const code = SOURCE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      if (/\bforce\b/i.test(code)) return 'the module names a force option in its code'
      return null
    },
  },
  {
    name: 'I_a_write_that_did_not_land_as_sent_is_not_reported_as_success',
    why: 'the returned digest must describe the issue, not the caller\'s intention for it',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      // The write is stored ALTERED — a truncation, which is what a partial write looks like.
      gh.state.onWrite = (sent) => sent.slice(0, Math.max(1, sent.length - 12))

      const res = m.updateIssueBody({
        repo: REPO, issue: 456, body: MINE, baseDigest: read.digest, run: gh.run, writeFile: gh.writeFile,
      })
      if (res.ok) return 'a write that landed altered was reported as success'
      if (res.reason !== 'write-not-confirmed') return `wrong reason: ${res.reason}`
      // Whatever it hands back must describe what is ON THE ISSUE, so the caller can recover.
      if (res.digest !== m.bodyDigest(gh.state.body)) return 'the reported digest is not the live one'
      if (res.liveBody !== gh.state.body) return 'the caller was not shown what actually landed'
      return null
    },
  },
  {
    name: 'J_a_successful_digest_is_usable_as_the_next_precondition',
    why: 'a digest a caller cannot write against next time is a number, not a contract',
    run: async (m) => {
      const gh = makeGh(ORIGINAL)
      const read = m.readIssueBody({ repo: REPO, issue: 456, run: gh.run })
      const first = m.updateIssueBody({
        repo: REPO, issue: 456, body: MINE, baseDigest: read.digest, run: gh.run, writeFile: gh.writeFile,
      })
      if (!first.ok) return `the first write failed (${first.reason})`
      // Round-trip: the digest handed back must be exactly what the NEXT write needs. If the
      // reported digest were the intended one rather than the live one, this second write would
      // still pass by coincidence whenever the write landed verbatim -- so the fake alters it,
      // making the two values genuinely different.
      const second = m.updateIssueBody({
        repo: REPO, issue: 456, body: `${MINE}\n\nAnd a follow-up.`, baseDigest: first.digest,
        run: gh.run, writeFile: gh.writeFile,
      })
      if (!second.ok) return `the returned digest did not work as the next precondition (${second.reason})`
      return null
    },
  },
]

// ---------------------------------------------------------------------------------------------
// MUTATIONS — each restores a different version of the unguarded write. Each MUST be killed.
// ---------------------------------------------------------------------------------------------

const MUTATIONS = [
  {
    name: 'drop_the_precondition_entirely',
    breaks: 'restores `gh issue edit --body`: an unconditional whole-document overwrite',
    apply: (s) => s.replace('if (live.digest !== baseDigest) {', 'if (false) {'),
  },
  {
    name: 'treat_a_missing_digest_as_permission',
    breaks: 'absent evidence read as evidence of no conflict — the fail-open direction',
    apply: (s) => s.replace('if (!baseDigest) {\n    return { ok: false, reason: \'no-base-digest\', liveBody: live.body, digest: live.digest }\n  }\n  if (live.digest !== baseDigest) {', 'if (baseDigest && live.digest !== baseDigest) {'),
  },
  {
    name: 'compare_against_the_callers_stale_read',
    breaks: 'checks the precondition against the value the caller already held, so it always passes',
    apply: (s) => s.replace('if (live.digest !== baseDigest) {', 'if (baseDigest !== baseDigest) {'),
  },
  {
    name: 'refuse_without_returning_the_live_content',
    breaks: 'the caller cannot re-apply, so the practical response becomes forcing',
    apply: (s) => s.replace(
      "return { ok: false, reason: 'body-moved', liveBody: live.body, digest: live.digest }",
      "return { ok: false, reason: 'body-moved' }"),
  },
  {
    // COMPOUND, and deliberately so. Mutating only the reported value is an EQUIVALENT mutant:
    // the confirmation check immediately above already proves `after.digest === next` on the
    // success path, so swapping one for the other changes no observable behaviour and no arm
    // could ever kill it. Reporting an intention instead of an observation is only a defect when
    // nothing verified the write — so the mutant is the pair, which is also how the bug would
    // really arrive: "the write returned 200, report what we sent."
    name: 'assume_the_write_landed_and_report_what_was_sent',
    breaks: 'hands back another memory of what was meant, which is the defect being fixed',
    apply: (s) => s
      .replace('if (after.digest !== next) {', 'if (false) {')
      .replace(
        "return { ok: true, reason: 'written', digest: after.digest, liveBody: after.body }",
        "return { ok: true, reason: 'written', digest: next, liveBody: after.body }"),
  },
  {
    name: 'skip_the_write_confirmation',
    breaks: 'assumes the write landed as sent rather than reading back what is actually there',
    apply: (s) => s.replace('if (after.digest !== next) {', 'if (false) {'),
  },
  {
    name: 'append_becomes_a_replace',
    breaks: 'additive intent travels as a full-document overwrite, discarding the existing body',
    apply: (s) => s.replace(
      'const joined = `${live.body.replace(/\\s+$/, \'\')}\\n\\n${String(addition ?? \'\').replace(/^\\s+/, \'\')}`',
      'const joined = String(addition ?? \'\')'),
  },
  {
    name: 'append_drops_its_precondition',
    breaks: 'appends onto a body that moved, duplicating what the other write already added',
    apply: (s) => s.replace(
      "  if (live.digest !== baseDigest) {\n    return { ok: false, reason: 'body-moved', liveBody: live.body, digest: live.digest }\n  }\n  const joined",
      '  const joined'),
  },
  {
    name: 'digest_is_byte_exact',
    breaks: 'CRLF round-tripping makes an unchanged body look moved; the guard fires on non-conflicts',
    apply: (s) => s.replace(
      "const normalised = String(body ?? '').replace(/\\r\\n/g, '\\n').replace(/\\s+$/, '')",
      "const normalised = String(body ?? '')"),
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

console.log('\nmutcheck-issue-body — GH #456 issue-body write precondition\n')

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
