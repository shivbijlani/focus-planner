import { describe, it, expect } from 'vitest'
import {
  parseTitle,
  latestAgentTurn,
  appendUserReply,
  topicName,
  taskIdFromFilename,
  journalFilename,
  hasAgentBlock,
  FROM_ME,
} from './journal.js'

const JOURNAL = `# Task 42: Test task

a user note at the top

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-07-08

### Proposed plan (v1)
1. step one
2. step two

## 2026-07-08

<!-- from: me -->
approve

## 2026-07-08

<!-- from: overnight-agent -->
Done \u2014 shipped the thing.

### Run log
- did the work
`

const PLAN_ONLY = `# Task 7: Planning

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-07-08

### Proposed plan (v1)
1. only step
`

describe('parseTitle', () => {
  it('reads the Task H1 title', () => {
    expect(parseTitle(JOURNAL)).toBe('Test task')
  })
  it('falls back to the first H1', () => {
    expect(parseTitle('# Just a heading\nbody')).toBe('Just a heading')
  })
})

describe('latestAgentTurn', () => {
  it('returns the newest from:overnight-agent entry, not the plan', () => {
    const turn = latestAgentTurn(JOURNAL)
    expect(turn).toContain('Done \u2014 shipped the thing.')
    expect(turn).toContain('did the work')
    expect(turn).not.toContain('approve')
    expect(turn).not.toContain('step one')
  })
  it('returns the plan block when there is no chat turn yet', () => {
    const turn = latestAgentTurn(PLAN_ONLY)
    expect(turn).toContain('only step')
    expect(turn).toContain('Status')
  })
  it('returns null when there is no agent content', () => {
    expect(latestAgentTurn('# Task 1: x\njust notes')).toBeNull()
  })
})

describe('appendUserReply', () => {
  it('appends a dated from:me entry at the bottom', () => {
    const out = appendUserReply(JOURNAL, { text: 'looks good', date: '2026-07-09' })
    expect(out.startsWith(JOURNAL.replace(/\s+$/, ''))).toBe(true)
    expect(out).toContain('## 2026-07-09')
    expect(out).toContain(FROM_ME)
    expect(out.trimEnd().endsWith('looks good')).toBe(true)
  })
})

describe('topicName', () => {
  it('formats id and title', () => {
    expect(topicName('42', 'Test task')).toBe('#42 \u00B7 Test task')
  })
  it('truncates past 128 chars', () => {
    const name = topicName('42', 'x'.repeat(200))
    expect(name.length).toBeLessThanOrEqual(128)
  })
})

describe('filename helpers', () => {
  it('round-trips id <-> filename', () => {
    expect(taskIdFromFilename('task-352.md')).toBe('352')
    expect(journalFilename('352')).toBe('task-352.md')
    expect(taskIdFromFilename('planner.md')).toBeNull()
  })
})

describe('hasAgentBlock', () => {
  it('detects the sentinel', () => {
    expect(hasAgentBlock(JOURNAL)).toBe(true)
    expect(hasAgentBlock('# Task 1: x')).toBe(false)
  })
})
