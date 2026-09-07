#!/usr/bin/env node
/**
 * issue-comment.mjs -- the reachable entry point for writing the agent's ONE comment on an issue.
 *
 * WHY THIS FILE EXISTS (GH #505)
 * ------------------------------
 * `lib-issue-comments.mjs` already solves this problem completely. It stamps unconditionally,
 * resolves the 0/1/2+ verdict, and refuses ambiguity by throwing. Its own header names it:
 * "THIS IS THE ENTRY POINT."
 *
 * It shipped with no way to call it. Measured 2026-09-07, four days after it landed, nothing
 * that writes imported it -- only its own mutation check and a mention in SKILL.md. Reaching
 * `writeAgenticComment` from a run meant authoring a bespoke Node script for a one-line action,
 * so every session reached for `gh issue comment` instead, which cannot stamp. Three unmarked
 * comments were produced that night (#531, #548, #586), each of which would have been
 * DUPLICATED on the next pass rather than edited -- the "stacked agent responses" defect of
 * #468, reappearing on the issue surface for want of a command.
 *
 * So the defect this fixes is not disregard of a rule. It is that the correct path was harder
 * to invoke than the wrong one. A contract that requires an agent to hand-roll a script to obey
 * it is not enforced, it is merely stated -- the class #560 exists to eliminate.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It contains no policy. It does not decide edit-vs-post, does not stamp, and does not inspect
 * a body for authorship. Every one of those lives in `lib-issue-comments.mjs` and is mutation-
 * checked there. Re-implementing any of it here would recreate GH #462 exactly: that bug WAS a
 * second copy of the branch, written by a caller that had the verdict in hand and guessed its
 * shape. This file's whole job is to carry argv to that library and report what it did.
 *
 * REFUSAL IS AN EXIT CODE, NOT A MESSAGE
 * --------------------------------------
 * `writeAgenticComment` throws on 2+ marked comments because a return value can be ignored by
 * the same inattention that caused the bug. That property survives to the shell only if the
 * throw becomes a non-zero exit, so the catch below re-raises it as exit 3 and never prints a
 * refusal to stdout as though it were an outcome.
 *
 * THE SUBJECT IS PRINTED WITH THE RESULT
 * --------------------------------------
 * Every line of output names the repo, issue and body file it actually resolved. `action=post`
 * and `exit=0` are true statements about *something*; without the subject they cannot be
 * checked against the thing the caller meant. This is the same failure that produced a
 * confident measurement of the wrong git tree and a `-SimpleMatch` search for a string that
 * exists in no file -- right command, right exit code, wrong subject.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  writeAgenticComment,
  readIssueComments,
  resolveAgenticComment,
} from './lib-issue-comments.mjs'

export const USAGE = `Usage:
  node issue-comment.mjs --repo <owner/repo> --issue <n> --body-file <path> [--dry-run]

Writes the agent's single comment on an issue: stamps it with the provenance marker, then
EDITS the existing agent comment if there is exactly one, or POSTS a new one if there is none.
Refuses (exit 3) if two or more marked comments exist, because that means an earlier invariant
already broke and guessing which to keep silently discards one.

  --dry-run   resolve and report the verdict without writing anything.

The body is always read from a file. There is no --body flag: a shell-quoted body loses the
newlines the marker depends on being alone on the first line.`

const defaultRun = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

/**
 * Parse argv into options. Flags only -- no positionals.
 *
 * `pr-closing-keyword.mjs` accepted a positional and crashed with ERR_INVALID_ARG_TYPE when
 * given one, and the exit-1 read as a finding rather than as operator error. An unrecognised
 * argument here is a hard error naming the argument, so a mistyped flag can never be silently
 * dropped and leave a required value at its default.
 */
export function parseArgs(argv) {
  const opts = { repo: null, issue: null, bodyFile: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') { opts.dryRun = true; continue }
    if (a === '--repo') { opts.repo = argv[++i] ?? null; continue }
    if (a === '--issue') { opts.issue = argv[++i] ?? null; continue }
    if (a === '--body-file') { opts.bodyFile = argv[++i] ?? null; continue }
    if (a === '--help' || a === '-h') { opts.help = true; continue }
    throw new Error(`unrecognised argument '${a}'\n\n${USAGE}`)
  }
  return opts
}

/**
 * The body must come from a file that exists and has content.
 *
 * An empty body is rejected rather than posted. A zero-length comment is indistinguishable
 * from a successful write in every log this produces, and it would consume the ONE agentic
 * comment slot on that issue -- so the next real write finds a marked comment already there
 * and edits the empty one, which looks like it worked.
 */
export function readBody(bodyFile, readFile = readFileSync) {
  const raw = String(readFile(bodyFile, 'utf8'))
  if (raw.trim() === '') {
    throw new Error(`body file is empty: ${bodyFile} -- refusing to write an empty comment`)
  }
  return raw
}

export function main({
  argv = process.argv.slice(2),
  run = defaultRun,
  readFile = readFileSync,
  log = console.log,
  err = console.error,
} = {}) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    err(e.message)
    return 2
  }

  if (opts.help) { log(USAGE); return 0 }

  const missing = ['repo', 'issue', 'bodyFile'].filter((k) => !opts[k])
  if (missing.length) {
    err(`missing required argument(s): ${missing.join(', ')}\n\n${USAGE}`)
    return 2
  }

  let body
  try {
    body = readBody(opts.bodyFile, readFile)
  } catch (e) {
    err(e.message)
    return 2
  }

  // The subject, before the result, so a failure names what it was pointed at.
  log(`subject: ${opts.repo}#${opts.issue}  body-file=${opts.bodyFile}  bytes=${body.length}`)

  if (opts.dryRun) {
    const comments = readIssueComments({ repo: opts.repo, issue: opts.issue, run })
    const verdict = resolveAgenticComment(comments)
    log(`dry-run: comments=${comments.length} marked=${verdict.marked.length} ` +
        `action=${verdict.action} commentId=${verdict.commentId ?? '-'} reason=${verdict.reason}`)
    return verdict.action === 'refuse' ? 3 : 0
  }

  let res
  try {
    res = writeAgenticComment({ repo: opts.repo, issue: opts.issue, body, run })
  } catch (e) {
    err(`REFUSED: ${e.message}`)
    return 3
  }

  log(`action=${res.action} commentId=${res.commentId ?? '-'} reason=${res.reason}`)
  return 0
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('issue-comment.mjs')

if (invokedDirectly) process.exit(main())
