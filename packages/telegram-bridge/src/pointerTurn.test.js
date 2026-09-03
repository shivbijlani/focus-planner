// #425: once a task has a catch-up doc, its journal turn becomes a short POINTER —
// status, doc link, a sentence or two, the ask — and the narrative is amended into
// the doc instead of being restated on every wake.
//
// These tests pin the JS end of that contract. `write-turn.ps1`'s G9/G10/G11 refuse a
// turn that is too long, that never links the doc, or that carries no ask; but the guard
// can only enforce the SHAPE. Whether the shape is still READABLE is decided here, by the
// two functions the Telegram approval digest actually runs.
//
// The acceptance criterion this covers is #425's second one: "the task's ask still
// appears in the Telegram approval digest". A shortening change that satisfies the guard
// and quietly breaks this would take every doc-bound task's ask off every surface at
// once — since #424, a doc-bound task's topic posts nothing per turn, so the digest is
// the only place the ask can still surface. `user-settings.md` records the cost of that
// happening before: 148 open asks, 17 shown, 131 unnamed.
//
// `mutcheck-pointer-turn.ps1` proves the same thing end-to-end through the real
// write-turn.ps1. This proves it from the side that owns the parser, so a change to
// digest.js's dialects fails here rather than in a check that lives in another package.
import { describe, it, expect } from 'vitest'
import { latestAgentTurn, hasAgentBlock, agentBlockStatus } from './journal.js'
import { extractAskEntry } from './digest.js'

const DOC_ID = 'DOC425aaaaBBBBccccDDDDeeeeFFFFgggg1234'
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`

/** The canonical #425 pointer turn, as SKILL.md tells the agent to author it. */
const POINTER = [
  '## 🌙 Overnight Agent — packet drafted, doc amended',
  '',
  '<!-- from: overnight-agent -->',
  '',
  '**Status:** In-progress · 2026-09-03',
  `📄 **[Catch-up doc](${DOC_URL})** — current state, amended tonight. **Comment there.**`,
  '',
  "Drafted the packet and folded tonight's findings into the doc rather than restating them here.",
  '',
  '**Needs from you:** approve the packet, or say what to change.',
  '',
  '<!-- /overnight-agent turn-end -->',
].join('\n')

function journalWith(turn) {
  return [
    '# Task 801: synthetic',
    '<!-- tg-meta chatId=-100123 threadId=7 -->',
    `<!-- doc-meta docId=${DOC_ID} docUrl=${DOC_URL} -->`,
    '',
    "The user's own notes.",
    '',
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '',
    turn,
    '',
  ].join('\n')
}

describe('#425 pointer turn', () => {
  it('is short enough to be a pointer rather than the story', () => {
    // The issue's target is ~800; write-turn.ps1 refuses a doc-bound turn over 1,500.
    // Measured status quo for comparison: agent turns on task 468 averaged 5,305 chars.
    expect(POINTER.length).toBeLessThan(800)
  })

  it('still opens an agent block the bridge will look at', () => {
    // hasAgentBlock gates EVERY task in the bridge. A turn the bridge never reads is a
    // turn that reaches no surface at all, however well-formed it is (#451: 7 journals
    // were born invisible this way).
    expect(hasAgentBlock(journalWith(POINTER))).toBe(true)
  })

  it('is isolated as the newest agent turn, without the heading or the turn-end stamp', () => {
    const turn = latestAgentTurn(journalWith(POINTER))
    // The turn body starts BELOW the provenance marker, so the 🌙 heading is not part of
    // it. That is why the pointer template puts the doc link and the ask in the body and
    // not in the heading — a heading-only link would be invisible to everything here.
    expect(turn).toContain('Drafted the packet')
    expect(turn).not.toContain('## 🌙')
    // The stamp must not be rendered into the message — 36 journals once showed it to
    // the user verbatim.
    expect(turn).not.toContain('turn-end')
  })

  it('carries a status the bridge can read', () => {
    expect(agentBlockStatus(journalWith(POINTER))).toMatch(/in-progress/i)
  })

  it('yields the ask to the approval digest', () => {
    const entry = extractAskEntry(latestAgentTurn(journalWith(POINTER)))
    expect(entry).not.toBeNull()
    expect(entry.source).toBe('needs')
    expect(entry.text).toMatch(/approve the packet/)
  })

  it('links the doc it is pointing at', () => {
    // G10's JS-side twin. A pointer with nothing to point at is strictly worse than the
    // long turn it replaced: the detail has left the journal and cannot be reached from it.
    expect(latestAgentTurn(journalWith(POINTER))).toContain(DOC_URL)
  })

  it('goes silent to the digest if the ask is moved into the doc instead of duplicated', () => {
    // The negative control, and the reason G11 refuses rather than warns. Without this
    // case the test above would pass against a digest that reports an ask for anything.
    const moved = POINTER.split('\n')
      .filter((l) => !l.startsWith('**Needs from you:**'))
      .join('\n')
    expect(extractAskEntry(latestAgentTurn(journalWith(moved)))).toBeNull()
  })
})
