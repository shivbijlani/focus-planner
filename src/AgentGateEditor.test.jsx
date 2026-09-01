/**
 * Render-level guards for the Agent gate editor (#288).
 *
 * These assert the *rendered DOM* and the handlers, because the acceptance
 * criteria in the issue are properties of the UI, not of the parser: two
 * line-oriented lists, add a line with Enter, remove one with ×.
 *
 * `renderToStaticMarkup` drops listeners, so interaction is exercised by
 * calling the handlers directly — the same approach as SkillsSection.test.jsx.
 * `GateList` is controlled (no hooks) precisely so this is possible.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GateList } from './AgentGateEditor.jsx'
import { handleGateKeyDown } from './agentGateEditor.js'
import { REVERSIBLE_HEADING, DEFAULT_REVERSIBLE } from './config/agentGate.js'

const render = (props = {}) =>
  renderToStaticMarkup(
    <GateList
      id="test-list"
      title={REVERSIBLE_HEADING}
      hint="The agent does these without asking."
      placeholder="Add something…"
      items={DEFAULT_REVERSIBLE}
      {...props}
    />
  )

describe('GateList rendering', () => {
  it('renders the list title and every line', () => {
    const html = render()
    expect(html).toContain(REVERSIBLE_HEADING)
    for (const line of DEFAULT_REVERSIBLE) {
      // The seed lines contain characters React escapes (apostrophes, &, <).
      expect(html).toContain(line.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    }
  })

  it('is line-oriented — one list item per entry', () => {
    const html = render()
    expect(html.match(/class="agent-gate-item"/g)).toHaveLength(DEFAULT_REVERSIBLE.length)
  })

  it('gives every line a labelled × remove button', () => {
    const html = render({ items: ['Emailing myself'] })
    expect(html).toContain('agent-gate-remove')
    expect(html).toContain('×')
    expect(html).toContain('aria-label="Remove: Emailing myself"')
  })

  it('renders an input for adding a line, with the Enter affordance', () => {
    const html = render({ placeholder: 'Add a rule…' })
    expect(html).toContain('class="agent-gate-input"')
    expect(html).toContain('placeholder="Add a rule…"')
    expect(html).toContain('Press Enter to add')
    expect(html).toContain(`aria-label="Add to ${REVERSIBLE_HEADING}"`)
  })

  it('shows the draft text in the input', () => {
    expect(render({ draft: 'half typed' })).toContain('value="half typed"')
  })

  it('shows an empty state rather than a bare list', () => {
    const html = render({ items: [] })
    expect(html).toContain('Nothing here yet.')
    expect(html).not.toContain('class="agent-gate-item"')
  })

  it('escapes markdown-special text instead of rendering it as markup', () => {
    const html = render({ items: ['<b>not bold</b> & 100%'] })
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;')
    expect(html).not.toContain('<b>not bold</b>')
  })

  it('disables the controls while a save is in flight', () => {
    const html = render({ items: ['a'], disabled: true })
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('GateList handlers', () => {
  // Pull the rendered element tree apart to invoke a specific handler.
  const el = (props) => GateList({ id: 'x', title: 'T', items: ['one', 'two'], ...props })
  const findByClass = (node, className) => {
    if (!node || typeof node !== 'object') return null
    if (node.props?.className === className) return node
    const kids = node.props?.children
    for (const k of Array.isArray(kids) ? kids : [kids]) {
      const hit = findByClass(k, className)
      if (hit) return hit
    }
    return null
  }

  it('removes the clicked line by index', () => {
    const onRemove = vi.fn()
    const list = findByClass(el({ onRemove }), 'agent-gate-items')
    // Second item's × button.
    list.props.children[1].props.children[1].props.onClick()
    expect(onRemove).toHaveBeenCalledWith(1)
  })

  it('reports draft edits to the parent', () => {
    const onDraftChange = vi.fn()
    const input = findByClass(el({ onDraftChange }), 'agent-gate-input')
    input.props.onChange({ target: { value: 'typing' } })
    expect(onDraftChange).toHaveBeenCalledWith('typing')
  })

  it('adds the draft on Enter, via the input', () => {
    const onAdd = vi.fn()
    const onDraftChange = vi.fn()
    const input = findByClass(el({ draft: 'new rule', onAdd, onDraftChange }), 'agent-gate-input')
    input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    expect(onAdd).toHaveBeenCalledWith('new rule')
    expect(onDraftChange).toHaveBeenCalledWith('')
  })
})

describe('handleGateKeyDown', () => {
  const wire = (draft = 'text') => {
    const onAdd = vi.fn()
    const onDraftChange = vi.fn()
    const preventDefault = vi.fn()
    return { draft, onAdd, onDraftChange, preventDefault }
  }

  it('commits the draft and clears the box on Enter', () => {
    const w = wire('Emailing myself')
    const handled = handleGateKeyDown({ key: 'Enter', preventDefault: w.preventDefault }, w)
    expect(handled).toBe(true)
    expect(w.preventDefault).toHaveBeenCalled()
    expect(w.onAdd).toHaveBeenCalledWith('Emailing myself')
    expect(w.onDraftChange).toHaveBeenCalledWith('')
  })

  it('ignores every other key', () => {
    for (const key of ['a', 'Escape', 'Tab', 'Shift']) {
      const w = wire()
      expect(handleGateKeyDown({ key, preventDefault: w.preventDefault }, w)).toBe(false)
      expect(w.onAdd).not.toHaveBeenCalled()
    }
  })

  it('does not throw on a missing event or missing callbacks', () => {
    expect(handleGateKeyDown(null, {})).toBe(false)
    expect(() => handleGateKeyDown({ key: 'Enter' }, {})).not.toThrow()
  })
})
