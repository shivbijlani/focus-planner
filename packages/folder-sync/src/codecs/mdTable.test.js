import { describe, expect, it } from 'vitest'
import { parse, serialize } from './mdTable.js'

const PLAN = `## Today

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|----------|
| 70 | 🟡 | First task | Sydney | 2026-01-27 | |
| 71 | 🔴 | Second task | Vibe | 2026-01-28 | |

## Deferred

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|----------|
| 72 | ⚪ | Later task | - | 2026-01-29 | |

## Priorities

1. 70
2. 71
`

describe('mdTable codec', () => {
  it('parses rows into id-keyed records and keeps the frame', () => {
    const { records, frame } = parse(PLAN)
    expect(Object.keys(records).sort()).toEqual(['70', '71', '72'])
    expect(records['70'].section).toBe('Today')
    expect(records['72'].section).toBe('Deferred')
    expect(records['70'].raw).toContain('First task')
    expect(frame).toContain('## Priorities')
    expect(frame).toContain('1. 70')
    expect(frame).not.toContain('First task') // rows replaced by markers
  })

  it('round-trips unchanged content exactly', () => {
    const { records, frame } = parse(PLAN)
    expect(serialize({ records, frame })).toBe(PLAN)
  })

  it('drops a deleted row on serialize', () => {
    const { records, frame } = parse(PLAN)
    delete records['71']
    const out = serialize({ records, frame })
    expect(out).not.toContain('Second task')
    expect(out).toContain('First task')
    expect(out).toContain('Later task')
  })

  it('inserts a row added on another device under its section', () => {
    const { records, frame } = parse(PLAN)
    records['99'] = { section: 'Today', raw: '| 99 | 🟡 | New from mobile | - | 2026-02-01 | |' }
    const out = serialize({ records, frame })
    const lines = out.split('\n')
    const todoIdx = lines.findIndex(l => l.startsWith('## Today'))
    const defIdx = lines.findIndex(l => l.startsWith('## Deferred'))
    const newIdx = lines.findIndex(l => l.includes('New from mobile'))
    expect(newIdx).toBeGreaterThan(todoIdx)
    expect(newIdx).toBeLessThan(defIdx) // landed in Today, not Deferred
  })

  it('extracts id from a composite first cell (ADO link form)', () => {
    const md = `## Today

| ID | 🎯 | Task | Priority | Added | Linked ID |
|---|---|------|----------|-------|----------|
| 70,[1234](https://ado/1234) | 🟡 | Linked task | - | 2026-01-27 | |
`
    const { records } = parse(md)
    expect(records['70']).toBeDefined()
    expect(records['70'].raw).toContain('1234')
  })

  it('handles empty / missing content', () => {
    expect(parse('').records).toEqual({})
    expect(serialize({ records: {}, frame: '' })).toBe('')
  })
})
