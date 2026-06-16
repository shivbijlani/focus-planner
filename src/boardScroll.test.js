import { describe, it, expect, beforeEach } from 'vitest'
import {
  saveScrollPosition,
  getSavedScrollPosition,
  clearScrollPosition,
  clampScrollTop,
  _resetScrollPositions,
} from './boardScroll.js'

describe('board scroll save/restore (#278)', () => {
  beforeEach(() => {
    _resetScrollPositions()
  })

  it('returns null when nothing is saved for a path', () => {
    expect(getSavedScrollPosition('planner.md')).toBe(null)
  })

  it('saves and reads back a scroll position by path', () => {
    saveScrollPosition('planner.md', 820)
    expect(getSavedScrollPosition('planner.md')).toBe(820)
  })

  it('keeps positions independent per path', () => {
    saveScrollPosition('planner.md', 300)
    saveScrollPosition('work::planner.md', 50)
    expect(getSavedScrollPosition('planner.md')).toBe(300)
    expect(getSavedScrollPosition('work::planner.md')).toBe(50)
  })

  it('overwrites the saved position on a later save', () => {
    saveScrollPosition('planner.md', 100)
    saveScrollPosition('planner.md', 640)
    expect(getSavedScrollPosition('planner.md')).toBe(640)
  })

  it('ignores empty paths and invalid offsets', () => {
    saveScrollPosition('', 100)
    saveScrollPosition(null, 100)
    saveScrollPosition('planner.md', -5)
    saveScrollPosition('planner.md', NaN)
    saveScrollPosition('planner.md', 'oops')
    expect(getSavedScrollPosition('')).toBe(null)
    expect(getSavedScrollPosition('planner.md')).toBe(null)
  })

  it('saves a 0 offset (top of board)', () => {
    saveScrollPosition('planner.md', 0)
    expect(getSavedScrollPosition('planner.md')).toBe(0)
  })

  it('clears a saved position', () => {
    saveScrollPosition('planner.md', 200)
    clearScrollPosition('planner.md')
    expect(getSavedScrollPosition('planner.md')).toBe(null)
  })
})

describe('clampScrollTop (#278)', () => {
  it('returns the offset when it fits within the scrollable range', () => {
    expect(clampScrollTop(500, 2000, 800)).toBe(500)
  })

  it('clamps to the max scroll when the board shrank while away', () => {
    // max = scrollHeight - clientHeight = 1000 - 800 = 200
    expect(clampScrollTop(800, 1000, 800)).toBe(200)
  })

  it('returns 0 when the board no longer scrolls', () => {
    expect(clampScrollTop(500, 600, 800)).toBe(0)
  })

  it('returns 0 for non-positive or invalid saved values', () => {
    expect(clampScrollTop(0, 2000, 800)).toBe(0)
    expect(clampScrollTop(-10, 2000, 800)).toBe(0)
    expect(clampScrollTop(NaN, 2000, 800)).toBe(0)
  })

  it('falls back to the raw offset when dimensions are unknown', () => {
    expect(clampScrollTop(500, undefined, undefined)).toBe(500)
  })
})
