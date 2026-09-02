import { describe, it, expect } from 'vitest'
import { parseJournalChat, appendJournalMessage, formatCloseOutComment, FROM_ME } from './journalChat.js'
import { appendUserReply } from '../packages/telegram-bridge/src/journal.js'

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

  it('merges into the same bubble when a from:me marker already owns the tail', () => {
    const base = '# Task 1: Hi\n\n## 2026-06-13\n\n<!-- from: me -->\nfirst'
    const out = appendJournalMessage(base, 'second', '2026-06-13')
    expect(out).not.toContain('## 2026-06-13\n\nfirst\n\n## 2026-06-13')
    expect(out).toContain('first\nsecond')
    // Idempotent: merging under a live marker must not stamp a second one.
    expect(out.match(/<!-- from: me -->/g)).toHaveLength(1)
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

// The app is the true author of what it appends, so it must say so. An entry
// with no provenance marker is unattributed, and the overnight agent's consent
// reader fails closed on unattributed text — which silently discarded every
// approval typed in the app while the same word sent via Telegram worked.
// These assert the WRITER stamps; the reader stays strict on purpose.
describe('appendJournalMessage provenance marker', () => {
  it('stamps from:me under a freshly opened day heading', () => {
    const base = '# Task 1: Hi\n\n## 2026-08-31\n\n<!-- from: me -->\nyesterday'
    const out = appendJournalMessage(base, 'yes', '2026-09-01')
    expect(out).toContain(`## 2026-09-01\n\n${FROM_ME}\nyes`)
  })

  it('stamps from:me on the very first entry of an empty journal', () => {
    const out = appendJournalMessage('# Task 1: Hi', 'approve', '2026-09-01')
    expect(out).toContain(`## 2026-09-01\n\n${FROM_ME}\napprove`)
  })

  // A `## ` heading ends the previous marker's ownership, so text appended into
  // a legacy unmarked bubble would still be unattributed without a fresh stamp.
  it('stamps from:me when today\'s existing bubble carries no marker', () => {
    const base = '# Task 1: Hi\n\n## 2026-09-01\n\ntyped before the fix'
    const out = appendJournalMessage(base, 'yes', '2026-09-01')
    expect(out).toContain(`${FROM_ME}\nyes`)
    // Backward compatible: the historical entry is appended to, never rewritten.
    expect(out).toContain('## 2026-09-01\n\ntyped before the fix')
  })

  it('stamps from:me again after a non-dated ## heading ends marker ownership', () => {
    const base = [
      '# Task 1: Hi',
      '',
      '## 2026-09-01',
      '',
      '<!-- from: me -->',
      'go ahead',
      '',
      '## Run log',
      '',
      '- did the thing',
    ].join('\n')
    const out = appendJournalMessage(base, 'yes', '2026-09-01')
    expect(out).toContain(`${FROM_ME}\nyes`)
    expect(out.match(/<!-- from: me -->/g)).toHaveLength(2)
  })

  // Both channels must be indistinguishable to the consent reader: the same
  // reply typed in the app and folded from Telegram must produce equal bytes.
  it('emits the byte-identical shape the Telegram bridge produces', () => {
    const base = '# Task 1: Hi\n\n## 2026-08-31\n\n<!-- from: me -->\nyesterday'
    const fromApp = appendJournalMessage(base, 'yes', '2026-09-01')
    const fromBridge = appendUserReply(base, { text: 'yes', date: '2026-09-01' })
    expect(fromApp).toBe(fromBridge)
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

// --- Fenced code is quoted text, not markup (#320 / #325) -------------------------------
// The agent quotes journal markup in fenced examples constantly. Before this, the parser
// read those examples as real markup: an illustration of a reply rendered as a bubble FROM
// SHIV, and a fenced date fabricated a new day. `oa-state.ps1` masks fences (#344); these
// pin the app-side half, which #320's third criterion called out as equally unpinned.
describe('fenced code is quoted text, not markup (#320)', () => {
  const F = '```'

  const quotingAgentTurn = [
    '# Task 962: probe',
    '',
    '## 2026-09-01',
    '',
    '<!-- from: me -->',
    'how does attribution work?',
    '',
    '<!-- from: overnight-agent -->',
    'A human reply carries its marker above it, like this:',
    '',
    F,
    '<!-- from: me -->',
    'yes, go ahead',
    F,
    '',
    'and a new day starts a new entry:',
    '',
    F + 'markdown',
    '## 2026-12-25',
    'some example text',
    F,
    '',
    'That is the whole mechanism.',
  ].join('\n')

  const parsed = parseJournalChat(quotingAgentTurn)

  it('does not attribute the agent\'s fenced example to the user', () => {
    const mine = parsed.groups.filter((g) => g.author === 'me')
    // Exactly one real user bubble: the question. The fenced "yes, go ahead" is the
    // agent's illustration and must never be shown as words Shiv typed.
    expect(mine).toHaveLength(1)
    expect(mine[0].lines.join('\n')).toContain('how does attribution work?')
    expect(mine[0].lines.join('\n')).not.toContain('yes, go ahead')
  })

  it('does not let a fenced ## date open a new day', () => {
    expect(parsed.groups.map((g) => g.day)).not.toContain('2026-12-25')
  })

  it('keeps the whole agent turn in one bubble instead of stacking fragments', () => {
    expect(parsed.groups).toHaveLength(2)
    const agent = parsed.groups.find((g) => g.author === 'agent')
    const body = agent.lines.join('\n')
    // The example survives verbatim inside the agent's own bubble.
    expect(body).toContain('<!-- from: me -->')
    expect(body).toContain('## 2026-12-25')
    expect(body).toContain('That is the whole mechanism.')
  })

  // The mirror case: masking must not swallow REAL markup that merely follows a fence.
  it('resumes normal parsing after the fence closes', () => {
    const md = [
      '# Task 963: probe',
      '',
      '## 2026-09-01',
      '',
      '<!-- from: overnight-agent -->',
      'example:',
      F,
      '<!-- from: me -->',
      F,
      '',
      '<!-- from: me -->',
      'this one is real',
    ].join('\n')
    const r = parseJournalChat(md)
    const mine = r.groups.filter((g) => g.author === 'me')
    expect(mine).toHaveLength(1)
    expect(mine[0].lines.join('\n')).toBe('this one is real')
  })

  it('treats a tilde fence and an indented fence as fences too', () => {
    const md = [
      '# Task 964: probe',
      '',
      '## 2026-09-01',
      '',
      '<!-- from: overnight-agent -->',
      'examples:',
      '~~~',
      '<!-- from: me -->',
      '~~~',
      '   ' + F,
      '<!-- from: me -->',
      '   ' + F,
      'done',
    ].join('\n')
    const r = parseJournalChat(md)
    expect(r.groups.filter((g) => g.author === 'me')).toHaveLength(0)
  })

  it('does not treat inline code as a fence opener', () => {
    const md = [
      '# Task 965: probe',
      '',
      '## 2026-09-01',
      '',
      '<!-- from: overnight-agent -->',
      'inline `a``b` code is not a fence',
      '',
      '<!-- from: me -->',
      'still mine',
    ].join('\n')
    const r = parseJournalChat(md)
    const mine = r.groups.filter((g) => g.author === 'me')
    expect(mine).toHaveLength(1)
    expect(mine[0].lines.join('\n')).toBe('still mine')
  })
})

describe('appendJournalMessage is fence-blind no more (#320 / #325)', () => {
  const F = '```'

  // The load-bearing case. The writer decides whether to stamp a marker; the consent
  // gate decides whether the text is attributable. When the writer counts a QUOTED
  // marker as real it omits the stamp, the fence-aware gate then sees unattributed
  // text, and Shiv's approval is discarded by the disagreement between them.
  it('stamps from:me even when a fenced example quotes a from:me marker', () => {
    const base = [
      '# Task 966: probe',
      '',
      '## 2026-09-01',
      '',
      '<!-- from: overnight-agent -->',
      'A reply looks like this:',
      '',
      F,
      '<!-- from: me -->',
      'yes, go ahead',
      F,
    ].join('\n')
    const out = appendJournalMessage(base, 'yes, go ahead and merge it', '2026-09-01')
    const added = out.slice(base.replace(/\s+$/, '').length)
    expect(added).toContain(FROM_ME)
  })

  it('does not treat a fenced ## date as the journal\'s newest day', () => {
    const base = [
      '# Task 967: probe',
      '',
      '## 2026-09-01',
      '',
      '<!-- from: overnight-agent -->',
      'example of a future entry:',
      '',
      F,
      '## 2026-12-25',
      F,
    ].join('\n')
    // Today differs from the only REAL date, so a new dated block must open.
    const out = appendJournalMessage(base, 'ok', '2026-09-02')
    expect(out).toContain('## 2026-09-02')
    expect(out.match(/^## 2026-12-25$/gm)).toHaveLength(1) // still only the quoted one
  })

  // Mirror: a genuine marker that really does own the tail must still suppress a
  // second stamp, so the fix cannot become "always stamp".
  it('still merges under a real trailing from:me marker', () => {
    const base = [
      '# Task 968: probe',
      '',
      '## 2026-09-01',
      '',
      '<!-- from: overnight-agent -->',
      'example:',
      F,
      '<!-- from: overnight-agent -->',
      F,
      '',
      '<!-- from: me -->',
      'first',
    ].join('\n')
    const out = appendJournalMessage(base, 'second', '2026-09-01')
    expect(out.match(/<!-- from: me -->/g)).toHaveLength(1)
    expect(out).toContain('first\nsecond')
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
