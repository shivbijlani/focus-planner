// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DocView from './DocView.jsx'
import { blockAnchor, selectionToAnchor } from './selection.js'
import { loadDoc, loadHistory, saveDrafts, sendDrafts } from './docsStore.js'

vi.mock('./docsStore.js', () => ({
  loadDoc: vi.fn(), loadHistory: vi.fn(), loadDrafts: () => [], legacyDraftNotice: () => null,
  saveDrafts: vi.fn(), sendDrafts: vi.fn(), markRead: vi.fn(), reopen: vi.fn(),
}))

const parsed = {
  title: 'Keyboard fixture', header: { rev: 2 },
  blocks: ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].map((text, i) => ({
    id: `b${i + 1}`, kind: 'paragraph', lines: [text],
  })),
}
const review = { readRev: 2, comments: {} }
const scope = { accountId: 'test', sourceId: 'fixture' }
const blocks = () => [...document.querySelectorAll('[data-block]')]
const key = (target, value, modifiers = {}) => fireEvent.keyDown(target, { key: value, ...modifiers })
const lastDrafts = () => saveDrafts.mock.calls.at(-1)[1]
async function open() {
  render(<DocView docId="d-keyboard" draftScope={scope} index={{ docs: {} }} onBack={vi.fn()} onOpenDoc={vi.fn()} />)
  await screen.findByRole('article')
  act(() => blocks()[0].focus())
}

beforeEach(() => {
  vi.clearAllMocks()
  loadDoc.mockResolvedValue({
    parsed, review, response: { rev: 2, dispositions: {}, revisions: [{ rev: 1 }, { rev: 2 }] },
  })
  loadHistory.mockResolvedValue({ ...parsed, header: { rev: 1 } })
  sendDrafts.mockResolvedValue({ review })
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.scrollTo = vi.fn()
})
afterEach(() => { cleanup(); window.getSelection().removeAllRanges() })

describe('Docs keyboard commenting', () => {
  it('roves j/k and arrows in document order, clamps at ends, and keeps one tab stop', async () => {
    await open()
    const [first, second, third] = blocks()
    expect(blocks().map((b) => b.tabIndex)).toEqual([0, -1, -1])
    expect(first.getAttribute('aria-label')).toBe('Paragraph 1, press C to comment')
    key(first, 'j')
    expect(document.activeElement).toBe(second)
    expect(blocks().map((b) => b.tabIndex)).toEqual([-1, 0, -1])
    key(second, 'ArrowDown')
    key(third, 'j')
    expect(document.activeElement).toBe(third)
    key(third, 'k')
    expect(document.activeElement).toBe(second)
    key(second, 'ArrowUp')
    key(first, 'k')
    expect(document.activeElement).toBe(first)
    expect(first.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it.each(['c', 'Enter', 'ContextMenu', 'Shift+F10'])('%s opens the same whole-block comment anchor and Escape restores focus', async (shortcut) => {
    await open()
    key(blocks()[0], 'j')
    const body = blocks()[1]
    key(body, shortcut === 'Shift+F10' ? 'F10' : shortcut, { shiftKey: shortcut === 'Shift+F10' })
    await screen.findByRole('dialog', { name: 'Comment' })
    const textarea = screen.getByRole('textbox')
    await waitFor(() => expect(document.activeElement).toBe(textarea))
    fireEvent.change(textarea, { target: { value: 'Keyboard comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(lastDrafts()[0]).toMatchObject({ anchor: blockAnchor(body), body: 'Keyboard comment' })
    expect(document.activeElement).toBe(body)
    key(body, 'c')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')))
    key(screen.getByRole('textbox'), 'Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(body)
  })

  it('does not run shortcuts in textareas, inputs, editable content, or with modifiers/composition', async () => {
    await open()
    const first = blocks()[0]
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      for (const value of ['j', 'c', 'a', 'Enter']) key(first, value, modifier)
    }
    expect(document.activeElement).toBe(first)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(lastDrafts()).toEqual([])
    for (const tag of ['input', 'textarea', 'div']) {
      const editable = document.createElement(tag)
      if (tag === 'div') editable.setAttribute('contenteditable', 'true')
      first.append(editable)
      editable.focus()
      for (const value of ['j', 'k', 'c', 'a', 'Enter']) key(editable, value)
      expect(document.activeElement).toBe(editable)
      expect(screen.queryByRole('dialog')).toBeNull()
      editable.remove()
    }
    key(first, 'c')
    const textarea = screen.getByRole('textbox')
    for (const value of ['j', 'k', 'c', 'a', 'Enter']) key(textarea, value)
    expect(lastDrafts()).toEqual([])
    key(textarea, 'Escape', { isComposing: true })
    key(textarea, 'Escape', { ctrlKey: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
    key(textarea, 'Escape')
    expect(document.activeElement).toBe(first)
  })

  it('prefers a non-collapsed article selection for C', async () => {
    await open()
    const body = blocks()[0]
    const range = document.createRange()
    range.setStart(body.querySelector('p').firstChild, 0)
    range.setEnd(body.querySelector('p').firstChild, 5)
    range.getClientRects = () => []
    range.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 30, width: 30 })
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    expect(selectionToAnchor(screen.getByRole('article'))?.anchor.quote).toBe('First')
    key(body, 'c')
    expect(screen.getByRole('dialog').querySelector('blockquote').textContent).toBe('First')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Selected text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(lastDrafts()[0].anchor.quote).toBe('First')
  })

  it('Escape dismisses the existing context-menu pill and focuses the current block', async () => {
    await open()
    key(blocks()[0], 'j')
    fireEvent.contextMenu(blocks()[1], { clientY: 10 })
    expect(screen.getByRole('toolbar')).toBeTruthy()
    key(blocks()[1], 'Escape')
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(document.activeElement).toBe(blocks()[1])
  })

  it.each(['ctrlKey', 'metaKey'])('A approves the current block and %s+Enter sends from the send bar only', async (modifier) => {
    await open()
    key(blocks()[0], 'a')
    expect(lastDrafts()[0]).toMatchObject({ anchor: blockAnchor(blocks()[0]), intent: 'approve' })
    key(blocks()[0], 'Enter', { [modifier]: true })
    expect(sendDrafts).not.toHaveBeenCalled()
    const send = screen.getByRole('button', { name: /Send to agent/ })
    key(send, 'Enter', { [modifier]: true, isComposing: true })
    expect(sendDrafts).not.toHaveBeenCalled()
    key(send, 'Enter', { [modifier]: true })
    await waitFor(() => expect(sendDrafts).toHaveBeenCalledOnce())
  })

  it('does not enable block shortcuts or tab stops in a historical read-only revision', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Version history/ }))
    fireEvent.click(screen.getByRole('button', { name: /^r1/ }))
    await screen.findByText('Back to current')
    const first = blocks()[0]
    expect(blocks().every((body) => !body.hasAttribute('tabindex'))).toBe(true)
    for (const value of ['j', 'k', 'ArrowDown', 'c', 'a', 'Enter', 'ContextMenu']) key(first, value)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(lastDrafts()).toEqual([])
  })
})
