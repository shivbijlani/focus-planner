/**
 * Render-level guards for the read-only `## Skills` section (#188).
 *
 * These assert the *rendered DOM*, not just the parser, because the
 * "read-only" and "absent when empty" criteria are properties of the markup:
 * a future edit could add a row-action button and every parser test would
 * still pass.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import SkillsSection, { SkillsTaskRefs } from './SkillsSection.jsx'
import { parseSkillsSection, hasRenderableSkills } from './skillsSection.js'

const SECTIONS = [
  { title: 'Today', lines: ['| ID | 🎯 | Task |', '| --- | --- | --- |', '| 12 | 🟡 | A task |'] },
  {
    title: 'Skills',
    lines: [
      '*Generated 2026-08-26 by `skills-inventory.mjs`.*',
      '| Skill | Purpose | Source | Picked up by | Active tasks |',
      '| --- | --- | --- | --- | --- |',
      '| `daily-planner` | Printable planner. | OneDrive library | copilot | #252 #296 |',
      '| `gstack` | Headless browser. | copilot-local | agents, copilot | — |',
    ],
  },
]

const parsed = parseSkillsSection(SECTIONS)
const render = (props = {}) =>
  renderToStaticMarkup(
    <SkillsSection headers={parsed.headers} rows={parsed.rows} notes={parsed.notes} {...props} />
  )

describe('SkillsSection rendering', () => {
  it('renders every skill row with all columns (criterion 3)', () => {
    const html = render({ defaultOpen: true })
    for (const h of ['Skill', 'Purpose', 'Source', 'Picked up by', 'Active tasks']) {
      expect(html).toContain(`<th>${h}</th>`)
    }
    expect(html).toContain('daily-planner')
    expect(html).toContain('gstack')
    expect(html).toContain('Printable planner.')
  })

  it('strips the inventory backticks and styles the name instead', () => {
    const html = render({ defaultOpen: true })
    expect(html).toContain('<code class="skill-name">daily-planner</code>')
    expect(html).not.toContain('`daily-planner`')
  })

  it('is collapsed by default and collapsible (criterion 1)', () => {
    const html = render()
    expect(html).toContain('collapse-icon')
    expect(html).toContain('▶')
    // Collapsed: the table itself is not in the DOM.
    expect(html).not.toContain('skills-table')
  })

  it('renders no mutation affordances at all (criterion 2)', () => {
    const html = render({ defaultOpen: true })
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('contenteditable')
    expect(html).not.toContain('draggable')
    expect(html).not.toMatch(/task-actions|kebab|add-task|delete/i)
  })

  it('makes each #ref a keyboard-reachable control (criterion 4)', () => {
    const html = render({ defaultOpen: true })
    expect(html).toContain('class="skill-task-ref"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('#252')
    expect(html).toContain('#296')
  })

  it('shows the generator provenance note', () => {
    expect(render({ defaultOpen: true })).toContain('skills-inventory.mjs')
  })

  it('renders a non-ref cell as plain text', () => {
    expect(render({ defaultOpen: true })).toContain('—')
  })
})

describe('SkillsTaskRefs', () => {
  it('navigates with the bare id, matching tr[data-task-id]', () => {
    const onNavigateToTask = vi.fn()
    // Exercise the handler directly: renderToStaticMarkup drops listeners.
    const el = SkillsTaskRefs({ text: '#357', onNavigateToTask })
    const refSpan = el.props.children[0]
    refSpan.props.onClick()
    expect(onNavigateToTask).toHaveBeenCalledWith('357')
  })

  it('renders nothing for an empty cell', () => {
    expect(SkillsTaskRefs({ text: '' })).toBe(null)
  })
})

describe('absent when the board has no Skills section (criterion 5)', () => {
  it('parses to null so the caller renders nothing', () => {
    const noSkills = SECTIONS.filter(s => s.title !== 'Skills')
    const p = parseSkillsSection(noSkills)
    expect(p).toBe(null)
    expect(hasRenderableSkills(p)).toBe(false)
  })

  it('renders nothing for a heading with no rows', () => {
    const empty = [{ title: 'Skills', lines: ['', ''] }]
    expect(hasRenderableSkills(parseSkillsSection(empty))).toBe(false)
  })
})
