import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { scrollToAndFlashTask, FLASH_CLASS } from './scrollToTask.js'

// Minimal fake row + document so we can test scroll/flash behavior in the node
// environment without jsdom.
function makeRow() {
  const classes = new Set()
  return {
    scrollIntoView: vi.fn(),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      has: (c) => classes.has(c),
    },
    _classes: classes,
  }
}

function makeDoc(rowsById = {}) {
  return {
    querySelector: (sel) => {
      const m = sel.match(/data-task-id="([^"]+)"/)
      return (m && rowsById[m[1]]) || null
    },
    querySelectorAll: () => [],
  }
}

describe('scrollToAndFlashTask', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete globalThis.matchMedia
  })
  afterEach(() => {
    vi.useRealTimers()
    delete globalThis.matchMedia
  })

  it('does nothing for an empty task id', () => {
    const doc = makeDoc()
    const spy = vi.spyOn(doc, 'querySelector')
    scrollToAndFlashTask('', { doc })
    scrollToAndFlashTask(null, { doc })
    scrollToAndFlashTask(undefined, { doc })
    expect(spy).not.toHaveBeenCalled()
  })

  it('scrolls smoothly and flashes the row, then clears the flash', () => {
    const row = makeRow()
    const doc = makeDoc({ 70: row })
    scrollToAndFlashTask(70, { doc })
    expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(row._classes.has(FLASH_CLASS)).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(row._classes.has(FLASH_CLASS)).toBe(false)
  })

  it('snaps (behavior:auto) when prefers-reduced-motion is set', () => {
    const row = makeRow()
    const doc = makeDoc({ 70: row })
    globalThis.matchMedia = () => ({ matches: true })
    scrollToAndFlashTask(70, { doc })
    expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
  })

  it('does not flash when the row is absent and nothing expands', () => {
    const doc = makeDoc({})
    // querySelectorAll returns [] so no sections expand and no retry is scheduled.
    expect(() => scrollToAndFlashTask(999, { doc })).not.toThrow()
  })
})
