import { describe, expect, it } from 'vitest'
import { detectOutlierIds, selfHealOutlierIds } from './selfHealIds.js'

describe('detectOutlierIds', () => {
  it('flags a high cluster separated by a large gap', () => {
    const ids = [120, 200, 271, 282, 426576, 426580, 426592]
    expect([...detectOutlierIds(ids)].sort((a, b) => a - b)).toEqual([426576, 426580, 426592])
  })

  it('returns empty for a contiguous low sequence', () => {
    expect(detectOutlierIds([1, 2, 3, 50, 51, 200]).size).toBe(0)
  })

  it('returns empty for a planner that legitimately uses high IDs', () => {
    // All large & contiguous-ish — no internal gap > threshold.
    expect(detectOutlierIds([426570, 426575, 426580, 426592]).size).toBe(0)
  })

  it('returns empty for fewer than two IDs', () => {
    expect(detectOutlierIds([]).size).toBe(0)
    expect(detectOutlierIds([426592]).size).toBe(0)
  })

  it('respects a custom gap threshold', () => {
    expect([...detectOutlierIds([1, 5, 2000], 100)]).toEqual([2000])
    expect(detectOutlierIds([1, 5, 80], 100).size).toBe(0)
  })
})

describe('selfHealOutlierIds', () => {
  const plan = [
    '## Today',
    '',
    '| ID | 🎯 | Task | P | Added | Linked ID |',
    '|---|---|------|---|-------|-----------|',
    '| 282 | 🟡 | Real recent | - | 2026-06-16 | 192 |',
    '| 426591 | 🟡 | Runaway one | - | 2026-06-16 | 192 |',
    '| 426592 | 🟡 | Runaway two | - | 2026-06-16 | 426591 |',
    '',
    '## Priorities',
    '',
    '1. 192',
    '2. 426592',
    '',
  ].join('\n')

  it('renumbers outliers down, continuing from the normal max', () => {
    const { content, idMap, changed } = selfHealOutlierIds(plan)
    expect(changed).toBe(true)
    expect(idMap.get('426591')).toBe('283')
    expect(idMap.get('426592')).toBe('284')
    expect(content).toContain('| 283 | 🟡 | Runaway one |')
    expect(content).toContain('| 284 | 🟡 | Runaway two |')
    // No 426xxx remains.
    expect(/4265\d\d/.test(content)).toBe(false)
  })

  it('remaps a linked-ID that pointed at a renamed task', () => {
    const { content } = selfHealOutlierIds(plan)
    // Row 284 (was 426592) linked to 426591 → now 283.
    expect(content).toContain('| 284 | 🟡 | Runaway two | - | 2026-06-16 | 283 |')
  })

  it('remaps the Priorities list entry', () => {
    const { content } = selfHealOutlierIds(plan)
    expect(content).toContain('2. 284')
    expect(content).not.toContain('2. 426592')
  })

  it('skips target IDs already taken by an existing journal', () => {
    const { idMap } = selfHealOutlierIds(plan, { journalIds: new Set([283]) })
    expect(idMap.get('426591')).toBe('284')
    expect(idMap.get('426592')).toBe('285')
  })

  it('preserves an ADO suffix on a renumbered row', () => {
    const adoPlan = [
      '## Today',
      '| ID | 🎯 | Task | P | Added | Linked ID |',
      '|---|---|---|---|---|---|',
      '| 100 | 🟡 | Keep | - | d | |',
      '| 426576,[419965](https://x/419965) | 🟡 | Runaway | - | d | |',
    ].join('\n')
    const { content } = selfHealOutlierIds(adoPlan)
    expect(content).toContain('| 101,[419965](https://x/419965) |')
  })

  it('is a no-op for a healthy planner', () => {
    const healthy = [
      '## Today',
      '| ID | 🎯 | Task | P | Added | Linked ID |',
      '|---|---|---|---|---|---|',
      '| 281 | 🟡 | A | - | d | |',
      '| 282 | 🟡 | B | - | d | |',
    ].join('\n')
    const { changed, content } = selfHealOutlierIds(healthy)
    expect(changed).toBe(false)
    expect(content).toBe(healthy)
  })
})
