import { describe, it, expect } from 'vitest'
import { journalFilePresentation } from './fileTreePresentation.js'

describe('journalFilePresentation', () => {
  it('labels the canonical task file as the chronological journal', () => {
    expect(journalFilePresentation('journal/task-431.md')).toEqual({
      icon: '📔',
      label: 'Journal · Task 431',
      title: 'Chronological journal for Task 431',
    })
  })

  it.each([
    ['431', 'webmcp-evaluation'],
    ['367', 'insurance-comparison'],
    ['472', 'bagel-recipe'],
    ['431', 'another-report'],
  ])('labels task-%s-%s.md as a separate supporting document for the same task', (id, description) => {
    expect(journalFilePresentation(`journal/task-${id}-${description}.md`)).toEqual({
      icon: '📄',
      label: `Supporting doc · Task ${id}`,
      title: `Supporting document for Task ${id}, separate from task-${id}.md`,
    })
  })

  it('labels a standalone supporting document without requiring a canonical sibling', () => {
    expect(journalFilePresentation('journal/task-999-standalone.md').label).toBe('Supporting doc · Task 999')
  })

  it.each([
    'archive/journal/task-431.md',
    'journal\\task-431.md',
  ])('recognizes a journal at %s', (path) => {
    expect(journalFilePresentation(path).label).toBe('Journal · Task 431')
  })

  it.each([
    'task-431.md',
    'reports/task-431-evaluation.md',
    'journal/notes.md',
    'journal/task-431-.md',
    'journal/task-431.md.bak',
    'journal/task-431/report.md',
    'journal/task-431-artifacts/report.md',
    'journal/task-abc.md',
    'planner.md',
  ])('leaves unrelated or noncanonical file %s unchanged', (path) => {
    expect(journalFilePresentation(path)).toBeNull()
  })
})
