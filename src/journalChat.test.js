import { describe, it, expect } from 'vitest'
import { parseJournalChat, appendJournalMessage, formatCloseOutComment } from './journalChat.js'

// Simplified excerpt mirroring the real journal/task-254.md structure:
// title, an undated TODO, a thematic break, an AUTO agent marker, agent
// content with bold + checkboxes, and a multi-line <!-- dc-meta --> comment.
const task254 = `# Task 254: Add dance church events to the calendar

- TODO: 

---
<!-- DANCE-CHURCH-AUTO do not edit this line; everything below is regenerated each run -->

## 🕺 Dance Church — Seattle (updated Jun 13, 2026)

**Which classes should I add to your calendar?**
- [ ] **1.** Sat · Jun 13 · 10:30 AM · Reverie Ballroom · **TOMMY IS GAY // PRIDE 2026**
- [ ] **2.** Sun · Jun 14 · 10:00 AM · Reverie Ballroom · Carlin Kramer
**Picks:** <!-- dc-meta
[
  {"n":1,"id":"LndAQC3V","summary":"TOMMY IS GAY // PRIDE 2026"},
  {"n":2,"id":"abc","summary":"Dance Church"}
]
-->
`

describe('parseJournalChat', () => {
  const parsed = parseJournalChat(task254)

  it('extracts the title without the leading #', () => {
    expect(parsed.title).toBe('Task 254: Add dance church events to the calendar')
  })

  it('keeps the undated TODO as pinned content', () => {
    expect(parsed.pinned.join('\n')).toContain('- TODO:')
  })

  it('routes AUTO content into an agent group', () => {
    const agent = parsed.groups.find((g) => g.author === 'agent')
    expect(agent).toBeTruthy()
    expect(agent.lines.join('\n')).toContain('Dance Church')
  })

  it('strips the multi-line dc-meta comment (no JSON leaks)', () => {
    const all = [parsed.pinned, ...parsed.groups.map((g) => g.lines)].flat().join('\n')
    expect(all).not.toContain('dc-meta')
    expect(all).not.toContain('"summary"')
    expect(all).not.toContain('-->')
  })

  it('keeps visible text that precedes an opening comment', () => {
    const all = parsed.groups.map((g) => g.lines.join('\n')).join('\n')
    expect(all).toContain('**Picks:**')
  })

  it('preserves inline bold markers for the renderer', () => {
    const all = parsed.groups.map((g) => g.lines.join('\n')).join('\n')
    expect(all).toContain('**TOMMY IS GAY // PRIDE 2026**')
  })

  it('handles empty content safely', () => {
    const p = parseJournalChat('')
    expect(p.title).toBe('')
    expect(p.groups).toEqual([])
    expect(p.pinned).toEqual([])
  })
})

describe('appendJournalMessage', () => {
  it('starts a new dated block when last date differs from today', () => {
    const out = appendJournalMessage('# Task 1: Hi\n\n## 2026-01-01\n\nold note', 'new note', '2026-06-13')
    expect(out).toContain('## 2026-06-13')
    expect(out.trimEnd().endsWith('new note')).toBe(true)
  })

  it('merges into the same bubble when same day and last author is me', () => {
    const base = '# Task 1: Hi\n\n## 2026-06-13\n\nfirst'
    const out = appendJournalMessage(base, 'second', '2026-06-13')
    expect(out).not.toContain('## 2026-06-13\n\nfirst\n\n## 2026-06-13')
    expect(out).toContain('first\nsecond')
  })

  it('adds a from:me marker when last author was an agent on the same day', () => {
    const base = '# Task 1: Hi\n\n## 2026-06-13\n\n<!-- from: bot -->\nagent said hi'
    const out = appendJournalMessage(base, 'my reply', '2026-06-13')
    expect(out).toContain('<!-- from: me -->\nmy reply')
  })

  it('creates a dated block for a journal that has no dates yet', () => {
    const out = appendJournalMessage('# Task 1: Hi\n\n- TODO: something', 'hello', '2026-06-13')
    expect(out).toContain('## 2026-06-13')
    expect(out).toContain('hello')
  })

  // Regression: an agent block marked with an "-AGENT" sentinel (not "AUTO"),
  // on today's date, must still be detected so the user's reply is attributed
  // to them instead of merging into the agent's bubble.
  it('adds a from:me marker after an -AGENT sentinel block on the same day', () => {
    const base = [
      '# Task 9: Plan',
      '',
      '## 2026-06-15',
      '',
      'Look it up',
      '',
      '---',
      '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
      '',
      '## 🌙 Overnight Agent',
      'Here is the plan.',
    ].join('\n')
    const out = appendJournalMessage(base, 'my reply', '2026-06-15')
    expect(out).toContain('<!-- from: me -->\nmy reply')
    expect(out).not.toMatch(/Here is the plan\.\nmy reply/)
  })
})

describe('agent sentinel detection (parse)', () => {
  it('treats an -AGENT sentinel block as an agent bubble, not the user', () => {
    const md = [
      '# Task 9: Plan',
      '',
      '## 2026-06-15',
      '',
      'My note',
      '',
      '---',
      '<!-- OVERNIGHT-AGENT do not edit this line -->',
      '',
      'Agent content here',
      '',
      '<!-- from: me -->',
      'My reply below',
    ].join('\n')
    const r = parseJournalChat(md)
    const agent = r.groups.find((g) => g.author === 'agent')
    const meReply = r.groups.find((g) => g.author === 'me' && g.lines.join('\n').includes('My reply below'))
    expect(agent).toBeTruthy()
    expect(agent.lines.join('\n')).toContain('Agent content here')
    expect(meReply).toBeTruthy()
    // The user's reply must NOT be lumped into the agent bubble.
    expect(agent.lines.join('\n')).not.toContain('My reply below')
  })
})

describe('formatCloseOutComment', () => {
  it('formats both an outcome and a comment', () => {
    expect(formatCloseOutComment('Canceled', 'Client pulled the project.')).toBe(
      '**Outcome:** Canceled\n\nClient pulled the project.',
    )
  })

  it('formats an outcome only', () => {
    expect(formatCloseOutComment('Done by me', '')).toBe('**Outcome:** Done by me')
  })

  it('formats a comment only', () => {
    expect(formatCloseOutComment('', 'Wrapped it up quickly.')).toBe('Wrapped it up quickly.')
  })

  it('returns an empty string when neither is provided', () => {
    expect(formatCloseOutComment('', '')).toBe('')
    expect(formatCloseOutComment('   ', '  ')).toBe('')
    expect(formatCloseOutComment(undefined, undefined)).toBe('')
  })
})
