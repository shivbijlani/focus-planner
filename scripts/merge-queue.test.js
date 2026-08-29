import { describe, it, expect } from 'vitest'
import {
  VERIFIED_QUEUE,
  EXCLUDED,
  planStep,
  planQueue,
  parseTestCount,
} from './merge-queue.mjs'

const open = (over = {}) => ({ state: 'OPEN', mergeable: 'MERGEABLE', isDraft: false, ...over })
const lookupFrom = (map) => (n) => (n in map ? map[n] : open())

describe('VERIFIED_QUEUE', () => {
  it('starts with #150, the fix that unblocks the suite', () => {
    // Everything downstream is measured against a green suite, so if #150
    // is not first every later "green" reading is meaningless.
    expect(VERIFIED_QUEUE[0].pr).toBe(150)
  })

  it('lands #149 before #154, which is stacked on it', () => {
    const order = VERIFIED_QUEUE.map((e) => e.pr)
    expect(order.indexOf(149)).toBeLessThan(order.indexOf(154))
  })

  it('contains no duplicate PRs', () => {
    const order = VERIFIED_QUEUE.map((e) => e.pr)
    expect(new Set(order).size).toBe(order.length)
  })

  it('never queues a PR that is also excluded', () => {
    const queued = new Set(VERIFIED_QUEUE.map((e) => e.pr))
    for (const x of EXCLUDED) expect(queued.has(x.pr)).toBe(false)
  })

  it('excludes #152, which is superseded by #154', () => {
    expect(EXCLUDED.some((x) => x.pr === 152)).toBe(true)
    expect(VERIFIED_QUEUE.some((e) => e.pr === 154)).toBe(true)
  })

  it('has a non-decreasing expected test count', () => {
    const counts = VERIFIED_QUEUE.map((e) => e.tests)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    }
  })
})

describe('planStep', () => {
  it('merges an open, mergeable PR', () => {
    expect(planStep({ pr: 1 }, open())).toMatchObject({ action: 'merge', needsReady: false })
  })

  it('flags a draft so it gets marked ready first', () => {
    expect(planStep({ pr: 1 }, open({ isDraft: true }))).toMatchObject({
      action: 'merge',
      needsReady: true,
    })
  })

  it('skips an already-merged PR so a stopped run is resumable', () => {
    expect(planStep({ pr: 1 }, open({ state: 'MERGED' }))).toMatchObject({ action: 'skip' })
  })

  it('skips a PR closed without merging', () => {
    expect(planStep({ pr: 1 }, open({ state: 'CLOSED' }))).toMatchObject({ action: 'skip' })
  })

  it('stops on a conflicting PR rather than guessing', () => {
    expect(planStep({ pr: 1 }, open({ mergeable: 'CONFLICTING' }))).toMatchObject({ action: 'stop' })
  })

  it('stops when the PR cannot be found', () => {
    expect(planStep({ pr: 1 }, null)).toMatchObject({ action: 'stop' })
  })

  it('still merges when mergeability is UNKNOWN, but says so', () => {
    const step = planStep({ pr: 1 }, open({ mergeable: 'UNKNOWN' }))
    expect(step.action).toBe('merge')
    expect(step.reason).toMatch(/computing/)
  })
})

describe('planQueue', () => {
  const queue = [
    { pr: 10, label: 'a', tests: 1 },
    { pr: 20, label: 'b', tests: 2 },
    { pr: 30, label: 'c', tests: 3 },
  ]

  it('plans every step when all are healthy', () => {
    const steps = planQueue(queue, lookupFrom({}))
    expect(steps).toHaveLength(3)
    expect(steps.every((s) => s.action === 'merge')).toBe(true)
  })

  it('halts at the first blocker, since later steps are unverifiable', () => {
    const steps = planQueue(queue, lookupFrom({ 20: open({ mergeable: 'CONFLICTING' }) }))
    expect(steps.map((s) => s.pr)).toEqual([10, 20])
    expect(steps.at(-1).action).toBe('stop')
  })

  it('keeps going past an already-merged PR', () => {
    const steps = planQueue(queue, lookupFrom({ 10: open({ state: 'MERGED' }) }))
    expect(steps.map((s) => s.action)).toEqual(['skip', 'merge', 'merge'])
  })

  it('resumes from a given PR', () => {
    const steps = planQueue(queue, lookupFrom({}), { from: 20 })
    expect(steps.map((s) => s.pr)).toEqual([20, 30])
  })

  it('carries the label through for readable output', () => {
    expect(planQueue(queue, lookupFrom({}))[0].label).toBe('a')
  })
})

describe('parseTestCount', () => {
  it('reads the passing count from vitest output', () => {
    expect(parseTestCount('  Tests  459 passed (459)')).toBe(459)
  })

  it('reads the count even when some tests failed', () => {
    expect(parseTestCount('Tests  3 passed | 1 failed (4)')).toBe(3)
  })

  it('returns null when there is no count to read', () => {
    expect(parseTestCount('build error')).toBeNull()
    expect(parseTestCount('')).toBeNull()
    expect(parseTestCount(undefined)).toBeNull()
  })
})
