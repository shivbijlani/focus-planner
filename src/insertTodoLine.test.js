import { describe, it, expect } from 'vitest'
import { insertTodoLine, stripEmptyTodoLines, TODO_PREFIX, appendJournalMessage } from './journalChat.js'

// The extractor, copied from server.js /api/todos. Duplicated deliberately: the point of these
// tests is that what the BUTTON produces is what the EXTRACTOR accepts, and asserting against a
// paraphrase of my own writer would prove only that it agrees with itself.
const CHECKBOX_RE = /^-\s*\[([ x])\]\s*(.+)/i

function extractTodos(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((l) => CHECKBOX_RE.exec(l))
    .filter(Boolean)
    .map((m) => ({ done: m[1].toLowerCase() === 'x', text: m[2].trim() }))
}

describe('insertTodoLine (GH #645)', () => {
  it('starts a todo in an empty composer', () => {
    expect(insertTodoLine('')).toBe(TODO_PREFIX)
    expect(insertTodoLine(undefined)).toBe(TODO_PREFIX)
  })

  it('puts the todo on its own line rather than at the end of a sentence', () => {
    // The whole failure mode. `note - [ ] milk` renders as prose and is invisible to
    // /api/todos, so appending with a space -- the obvious reuse of the attachment
    // inserter -- would defeat the button.
    expect(insertTodoLine('picked up the keys')).toBe(`picked up the keys\n${TODO_PREFIX}`)
  })

  it('does not add a blank line when the draft already ends with one', () => {
    expect(insertTodoLine('note\n')).toBe(`note\n${TODO_PREFIX}`)
  })

  it('is idempotent on an unfilled box, so a double tap leaves no debris', () => {
    const once = insertTodoLine('note')
    expect(insertTodoLine(once)).toBe(once)
    expect(insertTodoLine(TODO_PREFIX)).toBe(TODO_PREFIX)
  })

  it('adds a second todo once the first one has text', () => {
    const first = `${TODO_PREFIX}buy milk`
    expect(insertTodoLine(first)).toBe(`${first}\n${TODO_PREFIX}`)
  })

  it('handles a CRLF draft', () => {
    expect(insertTodoLine('note\r\n')).toBe(`note\r\n${TODO_PREFIX}`)
  })
})

describe('what the button produces survives the round trip (GH #645)', () => {
  it('is extracted as a todo once the user types the text', () => {
    const draft = `${insertTodoLine('')}buy milk`
    expect(extractTodos(draft)).toEqual([{ done: false, text: 'buy milk' }])
  })

  it('an unfilled box WOULD extract as a blank todo, which is why sending strips it', () => {
    // Measured, and the opposite of what I first assumed. `- [ ] ` has a trailing space, and
    // the extractor's `\s*` hands that space back to `(.+)` -- so the line matches and yields
    // a todo whose text is empty. Only `- [ ]` with no trailing space fails to match, and that
    // is not the markdown to write. Hence stripEmptyTodoLines at the write boundary.
    expect(extractTodos(insertTodoLine(''))).toEqual([{ done: false, text: '' }])
    expect(extractTodos(stripEmptyTodoLines(insertTodoLine('')))).toEqual([])
  })

  it('strips an unfilled box but keeps the note beside it', () => {
    expect(stripEmptyTodoLines(`picked up the keys\n${TODO_PREFIX}`)).toBe('picked up the keys')
    expect(stripEmptyTodoLines(`${TODO_PREFIX}buy milk\n${TODO_PREFIX}`)).toBe(`${TODO_PREFIX}buy milk`)
  })

  it('leaves a ticked or filled box alone', () => {
    expect(stripEmptyTodoLines('- [x] done thing')).toBe('- [x] done thing')
    expect(stripEmptyTodoLines(`${TODO_PREFIX}buy milk`)).toBe(`${TODO_PREFIX}buy milk`)
  })

  it('reduces a draft of nothing but empty boxes to nothing, so Send stays disabled', () => {
    expect(stripEmptyTodoLines(TODO_PREFIX)).toBe('')
    expect(stripEmptyTodoLines(`${TODO_PREFIX}\n${TODO_PREFIX}`)).toBe('')
  })

  it('survives appendJournalMessage into a real journal, still at column 0', () => {
    // The extractor is anchored at column 0. appendJournalMessage inserts the text verbatim,
    // but that is the property this depends on rather than one it declares, so assert it.
    const journal = '# Task 9: Sandbox\n\n## 2026-09-25\n\n<!-- from: me -->\nearlier note\n'
    const draft = `${insertTodoLine('groceries')}buy milk`
    const out = appendJournalMessage(journal, draft, '2026-09-25')
    expect(out).toContain(`\n${TODO_PREFIX}buy milk`)
    expect(extractTodos(out)).toEqual([{ done: false, text: 'buy milk' }])
  })

  it('is attributed to him, not to an agent', () => {
    // #641's rule: a todo added through the composer is his. If this ever lands under an
    // agent marker the consent channel would read his own todo as the agent's words.
    const journal = '# Task 9: Sandbox\n\n## 2026-09-25\n\n<!-- from: overnight-agent -->\nagent turn\n'
    const out = appendJournalMessage(journal, `${insertTodoLine('')}buy milk`, '2026-09-25')
    const idx = out.indexOf(`${TODO_PREFIX}buy milk`)
    const before = out.slice(0, idx)
    expect(before.lastIndexOf('<!-- from: me -->')).toBeGreaterThan(before.lastIndexOf('<!-- from: overnight-agent -->'))
  })
})
