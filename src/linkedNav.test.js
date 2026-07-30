import { describe, it, expect } from 'vitest'
import { extractLinkedNum, shouldNavigateToCompleted, linkedNavFallbackFile } from './linkedNav.js'

const PLAN = 'planner.md'
const COMPLETED = 'planner-completed.md'

describe('extractLinkedNum', () => {
  it('extracts a plain numeric id', () => {
    expect(extractLinkedNum('331')).toBe('331')
    expect(extractLinkedNum(331)).toBe('331')
  })
  it('extracts the id from a labeled linked id', () => {
    expect(extractLinkedNum('331 (Focus plan app)')).toBe('331')
  })
  it('returns null for empty / missing values', () => {
    expect(extractLinkedNum(null)).toBe(null)
    expect(extractLinkedNum(undefined)).toBe(null)
    expect(extractLinkedNum('')).toBe(null)
  })
  it('handles zero', () => {
    expect(extractLinkedNum(0)).toBe('0')
    expect(extractLinkedNum('0')).toBe('0')
  })
})

describe('shouldNavigateToCompleted', () => {
  const active = ['192', '331', '373']

  it('is false for an active task even when its row is not rendered', () => {
    // This is the #394 regression: an active task hidden by a search filter
    // must NOT be treated as completed.
    expect(shouldNavigateToCompleted('331', active)).toBe(false)
  })

  it('is true only when the task is positively absent from the active set', () => {
    expect(shouldNavigateToCompleted('999', active)).toBe(true)
  })

  it('is false when the active set is unknown (no evidence of missing)', () => {
    expect(shouldNavigateToCompleted('999', null)).toBe(false)
    expect(shouldNavigateToCompleted('999', undefined)).toBe(false)
  })

  it('is false for an empty linked id', () => {
    expect(shouldNavigateToCompleted(null, active)).toBe(false)
    expect(shouldNavigateToCompleted('', active)).toBe(false)
  })
})

describe('linkedNavFallbackFile', () => {
  const active = ['192', '331']

  it('routes an active task to the plan board (never completed) — #394', () => {
    expect(linkedNavFallbackFile('331', active, PLAN, COMPLETED)).toBe(PLAN)
  })

  it('routes a known-absent task to the completed board', () => {
    expect(linkedNavFallbackFile('999', active, PLAN, COMPLETED)).toBe(COMPLETED)
  })

  it('routes to the plan board when the active set is unknown', () => {
    expect(linkedNavFallbackFile('999', null, PLAN, COMPLETED)).toBe(PLAN)
  })
})
