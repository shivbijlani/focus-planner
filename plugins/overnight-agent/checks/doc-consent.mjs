#!/usr/bin/env node
// doc-consent.mjs -- the catch-up doc as a CONSENT channel (GH #442)
//
// WHY THIS FILE EXISTS
//
// `lib-doc-comments.mjs` has carried `consentView(..., { neverComment: true })`
// since #451, proven by 17 mutation arms, and **nothing has ever called it**.
// It was left dormant on purpose: switching on a consent channel weakens a gate,
// and an agent that grants itself a new way to be authorised is the failure this
// repo keeps recording. So it waited for Shiv.
//
// He answered on 2026-09-09, in the margin of the bound doc, twice:
//
//     "Yes approved"                                     (on the Pending section,
//                                                         whose one open decision
//                                                         was exactly this)
//     "Comment is the first class way to give you approvals"
//
// This is the wiring, and nothing more. The attribution rule, the invariant and
// the affirmative vocabulary are all unchanged; this file only lets
// `oa-state.ps1 consent` ask the question.
//
// WHY A SEPARATE PROCESS. The reader is JavaScript and the gate is PowerShell.
// Re-implementing the attribution rule in PowerShell would be a second opinion
// about who wrote a comment, and two readers that can disagree about consent is
// strictly worse than one reader behind a process boundary (#463: "green where
// it was written, broken where it runs").
//
// WHY IT TAKES A FILE AND MAKES NO NETWORK CALL. The run already fetches the
// comment dump every wake for `oa-state.ps1 doc -Observe`. Reusing that file
// costs nothing, keeps `consent` fast and offline, and -- the point -- means the
// gate cannot be made to depend on a live Google call that might fail OPEN.
//
// EVERY FAILURE IS A REFUSAL. Missing file, unreadable dump, unparsed envelope,
// broken invariant: all return consent_ok:false with a reason. There is no input
// to this program that produces consent by accident.

import { readFileSync, existsSync } from 'node:fs'
import {
  parseCommentDump,
  isUnparsedDump,
  consentView,
  ledgerForDoc,
  mergeLedgers
} from './lib-doc-comments.mjs'

function refuse(reason, extra = {}) {
  return { consent_ok: false, reason, ...extra }
}

/**
 * @param dumpPath  the `list_document_comments` output the run already fetched
 * @param docId     the bound doc, so the ledger is read for the right document
 * @param ledgerPaths  zero or more ledger JSON files (committed backfill + live)
 */
export function docConsent(dumpPath, docId, ledgerPaths = []) {
  if (!dumpPath || !existsSync(dumpPath)) {
    return refuse('doc-comments-file-missing', { path: dumpPath ?? null })
  }

  let text
  try {
    text = readFileSync(dumpPath, 'utf8')
  } catch (e) {
    return refuse('doc-comments-unreadable', { detail: String(e.message || e).slice(0, 160) })
  }

  const entries = parseCommentDump(text)

  // THE #502 FAILURE, AS A REFUSAL RATHER THAN A SILENCE. A transport error, a
  // truncated file and a genuinely empty document all parse to zero rows, and on
  // this channel "he said nothing" and "the read failed" must not be the same
  // answer. On the reading side that cost an instruction; here it would be worse,
  // because the caller is about to do something irreversible.
  if (isUnparsedDump(text, entries)) {
    return refuse('doc-comments-unparsed', { rows: entries.length })
  }

  let ledger = { comments: [] }
  const ledgers = []
  for (const p of ledgerPaths) {
    if (!p || !existsSync(p)) continue
    try {
      ledgers.push(ledgerForDoc(JSON.parse(readFileSync(p, 'utf8')), docId))
    } catch {
      // A corrupt ledger is not fatal and must not be: it can only make FEWER
      // comments provably the agent's, and `neverCommentView` then sees an
      // unattributed agent comment and refuses. Degrading toward refusal is the
      // safe direction; throwing here would make a consent gate crash on a
      // cache file.
    }
  }
  if (ledgers.length) ledger = mergeLedgers(...ledgers)

  // `neverComment: true` is the whole grant, and it is re-proven against the
  // comments in hand on every call -- it is not a stored permission. One agent
  // comment on this document and the invariant breaks, so consent refuses again
  // without anything having to be switched off.
  const view = consentView(entries, ledger, { neverComment: true })
  return { ...view, comments: entries.length, doc_id: docId ?? null }
}

function main(argv) {
  const dump = argv[0]
  const docId = argv[1]
  const ledgers = argv.slice(2)
  const verdict = docConsent(dump, docId, ledgers)
  console.log(JSON.stringify(verdict))
  // 0 = consent, 1 = no consent. Both are ANSWERS; the caller must not read a
  // non-zero exit as an error, and must not read an absent process as consent.
  return verdict.consent_ok ? 0 : 1
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('doc-consent.mjs')
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
