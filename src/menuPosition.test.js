import { describe, it, expect } from 'vitest'
import { clampMenuPosition, menuMaxHeight, MENU_MARGIN } from './menuPosition.js'

describe('clampMenuPosition (GH #640)', () => {
  it('leaves a menu that already fits exactly where it was asked for', () => {
    // The common case, and the one that must not regress: a right-click in open space should
    // land the menu at the pointer, not nudged by geometry it did not need.
    expect(clampMenuPosition({
      x: 100, y: 100, width: 200, height: 300, viewportWidth: 1280, viewportHeight: 800,
    })).toEqual({ top: 100, left: 100 })
  })

  it('flips a menu above the pointer when it would run off the bottom', () => {
    // Flipping rather than sliding keeps the menu clear of the row it acts on, which is what
    // makes a bottom-of-list right-click still feel like it belongs to that row.
    expect(clampMenuPosition({
      x: 100, y: 700, width: 200, height: 300, viewportWidth: 1280, viewportHeight: 800,
    })).toEqual({ top: 400, left: 100 })
  })

  it('flips left when it would run off the right edge', () => {
    expect(clampMenuPosition({
      x: 1200, y: 100, width: 200, height: 300, viewportWidth: 1280, viewportHeight: 800,
    })).toEqual({ top: 100, left: 1000 })
  })

  it('slides instead of flipping when there is no room above', () => {
    // Flipping a tall menu opened near the top would push it off the OTHER edge, trading one
    // unreachable tail for another.
    const { top } = clampMenuPosition({
      x: 100, y: 200, width: 200, height: 700, viewportWidth: 1280, viewportHeight: 800,
    })
    expect(top).toBe(800 - 700 - MENU_MARGIN)
    expect(top).toBeGreaterThanOrEqual(MENU_MARGIN)
  })

  it('reproduces the reported case: the whole menu becomes reachable', () => {
    // Measured on the report: a 7-item sheet on a 360x780 viewport put "Create Journal" at
    // top: 1006 — 226px below the fold, with three more entries after it. The menu is fixed, so
    // scrolling the board behind it changed nothing.
    const MENU_H = 7 * 54
    const before = 1006
    expect(before + 0).toBeGreaterThan(780)

    const { top } = clampMenuPosition({
      x: 17, y: before, width: 296, height: MENU_H, viewportWidth: 360, viewportHeight: 780,
    })
    expect(top + MENU_H).toBeLessThanOrEqual(780)
    expect(top).toBeGreaterThanOrEqual(MENU_MARGIN)
  })

  it('never places the menu past the top or left edge', () => {
    expect(clampMenuPosition({
      x: 0, y: 0, width: 200, height: 300, viewportWidth: 1280, viewportHeight: 800,
    })).toEqual({ top: MENU_MARGIN, left: MENU_MARGIN })

    expect(clampMenuPosition({
      x: -50, y: -50, width: 200, height: 300, viewportWidth: 1280, viewportHeight: 800,
    })).toEqual({ top: MENU_MARGIN, left: MENU_MARGIN })
  })

  it('pins to the margin when the menu cannot fit at all', () => {
    // Taller than the viewport: there is no correct position, so it goes to the margin and the
    // caller scrolls it. Silently truncating is the behaviour this issue is about.
    const { top } = clampMenuPosition({
      x: 100, y: 400, width: 200, height: 2000, viewportWidth: 1280, viewportHeight: 800,
    })
    expect(top).toBe(MENU_MARGIN)
  })

  it('does not move an unmeasured menu', () => {
    // Before layout the element reports 0x0. Clamping against that would place it at the margin
    // for one frame and then jump to the pointer.
    expect(clampMenuPosition({
      x: 640, y: 700, width: 0, height: 0, viewportWidth: 1280, viewportHeight: 800,
    })).toEqual({ top: 700, left: 640 })
  })

  it('is inert when the viewport is unknown', () => {
    // Server-side or a detached test env: without a viewport there is nothing to clamp against,
    // and guessing would move menus that were fine.
    expect(clampMenuPosition({ x: 100, y: 700, width: 200, height: 300 }))
      .toEqual({ top: 700, left: 100 })
  })

  it('tolerates junk input rather than producing NaN', () => {
    // A NaN in a style value silently drops the property, which would reinstate the bug.
    const r = clampMenuPosition({
      x: undefined, y: null, width: NaN, height: undefined, viewportWidth: 1280, viewportHeight: 800,
    })
    expect(Number.isFinite(r.top)).toBe(true)
    expect(Number.isFinite(r.left)).toBe(true)
  })
})

describe('menuMaxHeight (GH #640)', () => {
  it('leaves room for the margin on both edges', () => {
    expect(menuMaxHeight(800)).toBe(800 - MENU_MARGIN * 2)
  })

  it('returns null when the viewport is unknown, so no cap is applied', () => {
    expect(menuMaxHeight(0)).toBeNull()
    expect(menuMaxHeight(undefined)).toBeNull()
  })

  it('never returns a negative height', () => {
    expect(menuMaxHeight(4)).toBe(0)
  })

  it('makes an over-tall menu scrollable rather than truncated', () => {
    // The pair is what fixes the reported case: the clamp puts the menu on screen, and the cap
    // means a menu with more entries than the viewport can show is scrolled to rather than cut
    // off. `.context-menu` sets `overflow: hidden`, so without the cap the tail stays unreachable
    // even once the menu is positioned correctly.
    const cap = menuMaxHeight(780)
    expect(cap).toBe(780 - MENU_MARGIN * 2)
    expect(cap).toBeLessThan(780)
    // A menu taller than the viewport is capped, so it scrolls.
    expect(cap).toBeLessThan(2000)
    // A menu that fits is not capped below its own height, so nothing changes for the normal case.
    expect(cap).toBeGreaterThan(7 * 54)
  })
})
