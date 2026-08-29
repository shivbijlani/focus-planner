import { describe, it, expect } from 'vitest'
import { parseReplyRouting, coalesceByTask } from './routeReply.js'

// The board IDs that exist as journals in these tests.
const KNOWN = ['120', '234', '328', '348', '386', '394', '407', '432', '426565']

const route = (text) => parseReplyRouting(text, { knownTaskIds: KNOWN })

describe('parseReplyRouting', () => {
  it('routes the batched reply shape the agent asks for', () => {
    expect(route('merge 394, 386, 407; go on 348; 432 is 4 people')).toEqual([
      { taskId: '394', text: 'merge 394, 386, 407' },
      { taskId: '386', text: 'merge 394, 386, 407' },
      { taskId: '407', text: 'merge 394, 386, 407' },
      { taskId: '348', text: 'go on 348' },
      { taskId: '432', text: '432 is 4 people' },
    ])
  })

  it('treats newlines as separators, so bullet lists work', () => {
    expect(route('merge 394\n• go on 348\n- 432 is 4 people')).toEqual([
      { taskId: '394', text: 'merge 394' },
      { taskId: '348', text: '• go on 348' },
      { taskId: '432', text: '- 432 is 4 people' },
    ])
  })

  it('folds the segment verbatim rather than paraphrasing the answer', () => {
    expect(route('328: get the blue one for mum, ship by Friday')).toEqual([
      { taskId: '328', text: '328: get the blue one for mum, ship by Friday' },
    ])
  })

  // The whole point of validating against real journals: prose in an answer is
  // full of numbers that are not task IDs.
  it('ignores numbers that are not known task IDs', () => {
    expect(route('210 is 1000W and slot 9225 is signed in, ref 26-743022976')).toEqual([])
    expect(route('$3,046/yr beats it')).toEqual([])
    expect(route('mini golf on Aug 30 2026')).toEqual([])
  })

  it('picks the real task ID out of a sentence full of other numbers', () => {
    expect(route('348 — start it, budget 20 applications by 2026-09-01')).toEqual([
      { taskId: '348', text: '348 — start it, budget 20 applications by 2026-09-01' },
    ])
  })

  it('supports long imported task IDs', () => {
    expect(route('426565 looks done already')).toEqual([
      { taskId: '426565', text: '426565 looks done already' },
    ])
  })

  it('returns empty when the reply names no known task, so the caller can fall back', () => {
    expect(route('merge all')).toEqual([])
    expect(route('thanks!')).toEqual([])
  })

  it('returns empty for blank input or when no journals exist', () => {
    expect(route('')).toEqual([])
    expect(route('   ')).toEqual([])
    expect(parseReplyRouting('merge 394', { knownTaskIds: [] })).toEqual([])
    expect(parseReplyRouting('merge 394')).toEqual([])
  })

  it('does not emit the same task twice for one segment', () => {
    expect(route('394 — merge 394 please')).toEqual([
      { taskId: '394', text: '394 — merge 394 please' },
    ])
  })

  it('accepts numeric known IDs as well as strings', () => {
    expect(parseReplyRouting('merge 394', { knownTaskIds: [394] })).toEqual([
      { taskId: '394', text: 'merge 394' },
    ])
  })
})

describe('coalesceByTask', () => {
  it('merges several segments aimed at the same task into one entry', () => {
    expect(coalesceByTask(route('merge 394; 394 also needs a changelog'))).toEqual([
      { taskId: '394', text: 'merge 394\n394 also needs a changelog' },
    ])
  })

  it('keeps distinct tasks separate and preserves first-seen order', () => {
    expect(coalesceByTask(route('go on 348; merge 394'))).toEqual([
      { taskId: '348', text: 'go on 348' },
      { taskId: '394', text: 'merge 394' },
    ])
  })

  it('is a no-op on an empty routing', () => {
    expect(coalesceByTask([])).toEqual([])
  })
})
