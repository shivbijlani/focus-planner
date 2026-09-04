// lib-issue-body.mjs — a precondition for issue-body writes (GH #456).
//
// WHY THIS FILE EXISTS
// --------------------
// Editing an issue BODY with `gh issue edit --body` is an unconditional whole-document overwrite.
// There is no base revision, no precondition, no conflict detection: `gh issue edit --help`
// exposes no `sha`, `base`, `revision` or `if-match` flag of any kind. The concept is absent
// rather than switched off.
//
// The asymmetry inside that same command is the design argument. Every other mutation it offers
// is ADDITIVE — `--add-label`, `--remove-label`, `--add-assignee`, `--add-sub-issue` — and each is
// concurrency-safe by construction. Only `--body`/`--body-file` is a blind full replace. The
// destructive shape is chosen, not imposed by the API.
//
// TWO COSTS, AND THE SECOND IS THE ONE THAT BITES WITHOUT ANY CONCURRENCY
// ----------------------------------------------------------------------
// The obvious cost is a lost write. The subtler one needs no second writer at all: **"was my work
// overwritten?" is not a decidable question, in either direction.**
//
// Every layer that might answer it is blind. GitHub attributes every session's writes to the same
// account, so the author field cannot separate them. Issue bodies carry no provenance marker. The
// API exposes no edit history to a caller, so "who wrote the current text" cannot be asked. What
// remains is a session's memory of what it wrote — and a session has already reached a confident,
// specific, FALSE conclusion about the authorship of text it had written itself minutes earlier,
// with measurements attached and nothing in the system able to contradict it.
//
// So a precondition here is not only loss prevention. It makes the question answerable: a session
// that suspects an overwrite can be shown the digest and told it is wrong. That is why
// `updateIssueBody` returns a fresh digest on success (#456 requirement 4) — a session should hold
// something checkable rather than a memory.
//
// WHY IT MIRRORS THE PULL-REQUEST PATH RATHER THAN INVENTING A SHAPE
// -----------------------------------------------------------------
// The PR editing primitive in this environment already solves exactly this: it takes a `base_sha`,
// returns a fresh `base_sha` on success, and REFUSES WITH THE LIVE CONTENT when the object moved
// underneath the caller. That last clause is the load-bearing half — a refusal that does not hand
// back the current text leaves the caller unable to re-apply, so the practical response becomes
// "force it", which is the unguarded write with extra steps.
//
// A DIGEST, NOT A TIMESTAMP OR AN ETAG
// ------------------------------------
// The precondition is a hash of the body itself, because that is the thing being replaced.
// `updated_at` moves when a label changes, which would refuse writes that no body edit conflicts
// with — a guard that fires on non-conflicts is one that gets bypassed. A digest of the content
// answers precisely the question asked: is the text I am replacing still the text I read?
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { defaultWriteFile } from './lib-gh-write-file.mjs'

/**
 * Digest of an issue body.
 *
 * Line endings are normalised and trailing whitespace stripped FIRST. The same body round-trips
 * through the API, a file on a Windows disk and a shell pipe, and can come back CRLF where it went
 * out LF. Digesting the raw bytes would make an unchanged body look moved, which is the
 * fires-on-non-conflicts failure this guard must not have.
 */
export function bodyDigest(body) {
  const normalised = String(body ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return createHash('sha256').update(normalised, 'utf8').digest('hex')
}

const ghJson = (args, run) => JSON.parse(run(args))

const defaultRun = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

/**
 * Read an issue body and the digest to write back against.
 *
 * The digest is returned WITH the body rather than left for the caller to compute, so the value a
 * caller carries is always the digest of the text it actually saw.
 */
export function readIssueBody({ repo, issue, run = defaultRun }) {
  const data = ghJson(['api', `repos/${repo}/issues/${issue}`, '--jq', '{body:.body}'], run)
  const body = data.body ?? ''
  return { body, digest: bodyDigest(body) }
}

/**
 * Replace an issue body, but only if it still reads as it did when `baseDigest` was taken.
 *
 * Returns:
 *   { ok: true,  digest }                  — written; `digest` is the new body's, for the caller to hold
 *   { ok: false, reason, liveBody, digest} — refused; `liveBody` is the current text so the caller
 *                                            can re-apply its change onto it instead of forcing
 *
 * ⛔ There is no `force` parameter, deliberately. An escape hatch on a guard like this is taken
 * under exactly the conditions the guard exists for — the caller is mid-run, believes it knows
 * what the body should say, and the refusal is inconvenient. Re-applying onto `liveBody` is always
 * available and is never destructive, so nothing legitimate needs forcing.
 */
export function updateIssueBody({ repo, issue, body, baseDigest, run = defaultRun, writeFile = defaultWriteFile }) {
  // ALWAYS re-read immediately before writing (#456 requirement 1). A digest taken earlier in the
  // run is not evidence about now; the whole point is that the body may have moved since, and a
  // precondition checked against a stale read is not a precondition.
  const live = readIssueBody({ repo, issue, run })

  if (!baseDigest) {
    return { ok: false, reason: 'no-base-digest', liveBody: live.body, digest: live.digest }
  }
  if (live.digest !== baseDigest) {
    return { ok: false, reason: 'body-moved', liveBody: live.body, digest: live.digest }
  }

  // Writing an identical body is a no-op that still costs an API round trip and an `updated_at`
  // bump, which is noise on the one timeline used to reconstruct who wrote what.
  const next = bodyDigest(body)
  if (next === live.digest) {
    return { ok: true, reason: 'unchanged', digest: next, liveBody: live.body }
  }

  const file = writeFile(body)
  run(['api', '-X', 'PATCH', `repos/${repo}/issues/${issue}`, '-F', `body=@${file}`])

  // Read back rather than assuming the write landed as sent. The digest a caller holds has to be
  // the digest of what is ACTUALLY on the issue, or it is another memory of what it meant to write
  // — which is the failure mode this file exists to end.
  const after = readIssueBody({ repo, issue, run })
  if (after.digest !== next) {
    return { ok: false, reason: 'write-not-confirmed', liveBody: after.body, digest: after.digest }
  }
  return { ok: true, reason: 'written', digest: after.digest, liveBody: after.body }
}

/**
 * Append to an issue body under a precondition (#456 requirement 3).
 *
 * Additive intent should not travel as a whole-document replace. It still takes a precondition,
 * because appending onto a body that moved can duplicate a section that the other write already
 * added — the append is safe about LOSS, not about correctness.
 */
export function appendToIssueBody({ repo, issue, addition, baseDigest, run = defaultRun, writeFile = defaultWriteFile }) {
  const live = readIssueBody({ repo, issue, run })
  if (!baseDigest) {
    return { ok: false, reason: 'no-base-digest', liveBody: live.body, digest: live.digest }
  }
  if (live.digest !== baseDigest) {
    return { ok: false, reason: 'body-moved', liveBody: live.body, digest: live.digest }
  }
  const joined = `${live.body.replace(/\s+$/, '')}\n\n${String(addition ?? '').replace(/^\s+/, '')}`
  return updateIssueBody({ repo, issue, body: joined, baseDigest: live.digest, run, writeFile })
}
