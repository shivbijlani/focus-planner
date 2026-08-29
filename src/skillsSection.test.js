import { describe, it, expect } from 'vitest'
import {
  isSkillsSection,
  findSkillsSection,
  parseSkillsTable,
  parseSkillsSection,
  hasRenderableSkills,
  splitTaskRefs,
  extractTaskRefs,
  stripCode,
} from './skillsSection.js'
import {
  opAddTask,
  opMoveBetweenSections,
  opChangePriority,
  opDeleteTask,
  opRenameTask,
  opPromoteToManagerPriority,
} from './focusPlanOps.js'

// A stand-in for App.jsx's `parseFocusPlan`: it only has to split on `## `
// headings the same way, which is the contract `findSkillsSection` relies on.
function parseFocusPlan(content) {
  const lines = content.split('\n')
  const sections = []
  let current = null
  let buffer = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push({ title: current, lines: buffer })
      current = line.replace('## ', '').trim()
      buffer = []
    } else if (current) {
      buffer.push(line)
    }
  }
  if (current) sections.push({ title: current, lines: buffer })
  return sections
}

const SKILLS_BLOCK = [
  '## Skills',
  '',
  '*Generated 2026-08-26 by `skills-inventory.mjs` — read-only view for task #357.*',
  '',
  '| Skill | Purpose | Source | Picked up by | Active tasks |',
  '| --- | --- | --- | --- | --- |',
  '| `daily-planner` | Printable two-week planner. | OneDrive library | copilot | #252 #296 |',
  '| `gstack` | Fast headless browser for QA. | copilot-local | agents, copilot | — |',
  '',
].join('\n')

const BOARD = [
  '# Focus Planner',
  '',
  '## Today',
  '',
  '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 12 | 🟡 | Existing task | - | 2026-08-01 | |',
  '',
  '## Deferred',
  '',
  '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 9 | ⚪ | Someday task | - | 2026-07-01 | |',
  '',
  SKILLS_BLOCK,
  '## Priorities',
  '',
  '1. Ship the thing',
  '',
].join('\n')

describe('isSkillsSection', () => {
  it('matches only the exact Skills heading', () => {
    expect(isSkillsSection('Skills')).toBe(true)
    expect(isSkillsSection('  Skills  ')).toBe(true)
    expect(isSkillsSection('skills')).toBe(false)
    expect(isSkillsSection('Skills Backlog')).toBe(false)
    expect(isSkillsSection('Today')).toBe(false)
  })

  it('is null-safe', () => {
    expect(isSkillsSection(undefined)).toBe(false)
    expect(isSkillsSection(null)).toBe(false)
  })
})

describe('findSkillsSection', () => {
  it('finds the section in parsed board output', () => {
    const found = findSkillsSection(parseFocusPlan(BOARD))
    expect(found).toBeTruthy()
    expect(found.title).toBe('Skills')
  })

  it('returns null when the board has no Skills heading', () => {
    const without = BOARD.replace(SKILLS_BLOCK, '')
    expect(findSkillsSection(parseFocusPlan(without))).toBe(null)
  })

  it('tolerates a non-array input', () => {
    expect(findSkillsSection(undefined)).toBe(null)
    expect(findSkillsSection(null)).toBe(null)
  })
})

describe('parseSkillsTable', () => {
  const parsed = parseSkillsTable(findSkillsSection(parseFocusPlan(BOARD)).lines)

  it('keeps the skill columns verbatim', () => {
    expect(parsed.headers).toEqual(['Skill', 'Purpose', 'Source', 'Picked up by', 'Active tasks'])
  })

  it('does not rename or drop columns the way the task board does', () => {
    // Regression guard: App.jsx's parseMarkdownTable drops `Linked ID` and
    // renames `Added` → `Age`. Skill columns must survive untouched.
    expect(parsed.headers).toContain('Picked up by')
    expect(parsed.headers).not.toContain('Age')
  })

  it('reads each row as an object keyed by header', () => {
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toEqual({
      Skill: '`daily-planner`',
      Purpose: 'Printable two-week planner.',
      Source: 'OneDrive library',
      'Picked up by': 'copilot',
      'Active tasks': '#252 #296',
    })
  })

  it('skips the separator row', () => {
    expect(parsed.rows.some(r => r.Skill.startsWith('-'))).toBe(false)
  })

  it('collects prose lines as notes', () => {
    expect(parsed.notes.join(' ')).toContain('skills-inventory.mjs')
  })

  it('pads short rows instead of dropping cells', () => {
    const { rows } = parseSkillsTable([
      '| Skill | Purpose | Source |',
      '| --- | --- | --- |',
      '| `a` | b |',
    ])
    expect(rows[0]).toEqual({ Skill: '`a`', Purpose: 'b', Source: '' })
  })

  it('handles a heading with no table', () => {
    const { headers, rows } = parseSkillsTable(['', 'nothing here yet', ''])
    expect(headers).toEqual([])
    expect(rows).toEqual([])
  })

  it('is null-safe', () => {
    expect(parseSkillsTable(undefined).rows).toEqual([])
  })
})

describe('parseSkillsSection / hasRenderableSkills', () => {
  it('returns null when there is no section, so nothing renders', () => {
    const without = BOARD.replace(SKILLS_BLOCK, '')
    const parsed = parseSkillsSection(parseFocusPlan(without))
    expect(parsed).toBe(null)
    expect(hasRenderableSkills(parsed)).toBe(false)
  })

  it('reports renderable when rows exist', () => {
    expect(hasRenderableSkills(parseSkillsSection(parseFocusPlan(BOARD)))).toBe(true)
  })

  it('reports not renderable for a heading with no rows', () => {
    const empty = BOARD.replace(SKILLS_BLOCK, '## Skills\n\n')
    expect(hasRenderableSkills(parseSkillsSection(parseFocusPlan(empty)))).toBe(false)
  })
})

describe('splitTaskRefs / extractTaskRefs', () => {
  it('splits a cell into text and ref segments', () => {
    expect(splitTaskRefs('#252 #296')).toEqual([
      { type: 'ref', value: '252' },
      { type: 'text', value: ' ' },
      { type: 'ref', value: '296' },
    ])
  })

  it('keeps surrounding text', () => {
    expect(splitTaskRefs('see #12 later')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'ref', value: '12' },
      { type: 'text', value: ' later' },
    ])
  })

  it('treats a cell with no refs as plain text', () => {
    expect(splitTaskRefs('—')).toEqual([{ type: 'text', value: '—' }])
    expect(extractTaskRefs('—')).toEqual([])
  })

  it('does not match a bare number or a hash inside a word', () => {
    expect(extractTaskRefs('357')).toEqual([])
    expect(extractTaskRefs('rgb#fff')).toEqual([])
  })

  it('is null-safe and empty-safe', () => {
    expect(splitTaskRefs(undefined)).toEqual([])
    expect(splitTaskRefs('')).toEqual([])
    expect(extractTaskRefs(null)).toEqual([])
  })

  it('extracts ids without the # so they match tr[data-task-id]', () => {
    expect(extractTaskRefs('#252 #296 #357')).toEqual(['252', '296', '357'])
  })
})

describe('stripCode', () => {
  it('unwraps backticked names', () => {
    expect(stripCode('`daily-planner`')).toBe('daily-planner')
  })
  it('leaves plain names alone', () => {
    expect(stripCode('daily-planner')).toBe('daily-planner')
  })
  it('is null-safe', () => {
    expect(stripCode(undefined)).toBe('')
  })
})

// ── Success criterion 6: a board write must not disturb `## Skills` ──────────
//
// Every mutation in focusPlanOps is line-splice surgery on the raw content, so
// an unknown section should pass through byte-for-byte. That is an *implicit*
// property today; these tests make it explicit so a future rewrite (e.g. a
// parse → re-serialize round trip) can't silently eat the section.
describe('board writes preserve the Skills section byte-for-byte', () => {
  const skillsOf = (content) => {
    const i = content.indexOf('## Skills')
    expect(i).toBeGreaterThan(-1)
    const rest = content.slice(i)
    const next = rest.indexOf('\n## ', 1)
    return next === -1 ? rest : rest.slice(0, next)
  }
  const original = skillsOf(BOARD)

  it('survives adding a task', () => {
    const { content } = opAddTask(BOARD, {
      task: 'Brand new', priority: '🟡', linkedTask: '', section: 'Today',
    })
    expect(skillsOf(content)).toBe(original)
  })

  it('survives moving a task between sections', () => {
    const out = opMoveBetweenSections(
      BOARD, '| 12 | 🟡 | Existing task | - | 2026-08-01 | |', 'Today', 'Deferred'
    )
    expect(skillsOf(out)).toBe(original)
  })

  it('survives a priority change', () => {
    const out = opChangePriority(BOARD, '| 12 | 🟡 | Existing task | - | 2026-08-01 | |', '🟡', '🔴')
    expect(skillsOf(out)).toBe(original)
  })

  it('survives a rename', () => {
    const out = opRenameTask(BOARD, '| 12 | 🟡 | Existing task | - | 2026-08-01 | |', 'Renamed')
    expect(skillsOf(out)).toBe(original)
  })

  it('survives a delete', () => {
    const out = opDeleteTask(BOARD, '| 12 | 🟡 | Existing task | - | 2026-08-01 | |')
    expect(skillsOf(out)).toBe(original)
  })

  it('survives promoting a task to a priority', () => {
    const out = opPromoteToManagerPriority(BOARD, '12')
    expect(skillsOf(out)).toBe(original)
  })

  it('still parses identically after a write', () => {
    const { content } = opAddTask(BOARD, {
      task: 'Another', priority: '⚪', linkedTask: '', section: 'Deferred',
    })
    expect(parseSkillsSection(parseFocusPlan(content)))
      .toEqual(parseSkillsSection(parseFocusPlan(BOARD)))
  })

  it('does not let skill rows inflate the next allocated task ID', () => {
    // findInsertAndMaxId scans *every* table row on the board for a leading
    // number. Skill names are not numeric, so the new id must still follow the
    // task rows (12 → 13), not anything in the Skills table.
    const { newId } = opAddTask(BOARD, {
      task: 'Next', priority: '🟡', linkedTask: '', section: 'Today',
    })
    expect(newId).toBe(13)
  })
})
