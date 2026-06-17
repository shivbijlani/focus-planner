import { describe, it, expect } from 'vitest'
import { filterPlannerTree } from './fileTreeFilter.js'

// Mirrors the noisy real-world tree from the screenshot.
const sampleTree = [
  { name: 'AGENTS.md', type: 'file', path: 'AGENTS.md' },
  {
    name: '_backup_renumber_1781597829',
    type: 'directory',
    path: '_backup_renumber_1781597829',
    children: [
      { name: 'planner.md', type: 'file', path: '_backup_renumber_1781597829/planner.md' },
    ],
  },
  {
    name: 'connect2026.1',
    type: 'directory',
    path: 'connect2026.1',
    children: [
      { name: 'planner.md', type: 'file', path: 'connect2026.1/planner.md' },
    ],
  },
  {
    name: '2026-cycle-3',
    type: 'directory',
    path: '2026-cycle-3',
    children: [
      { name: 'planner.md', type: 'file', path: '2026-cycle-3/planner.md' },
      { name: 'planner-completed.md', type: 'file', path: '2026-cycle-3/planner-completed.md' },
    ],
  },
  { name: 'dist', type: 'directory', path: 'dist', children: [] },
  { name: 'outputs', type: 'directory', path: 'outputs', children: [] },
  { name: '6-week-cycle-plan.md', type: 'file', path: '6-week-cycle-plan.md' },
  { name: 'agent-email-setup.md', type: 'file', path: 'agent-email-setup.md' },
  { name: 'focus-plan-completed.md', type: 'file', path: 'focus-plan-completed.md' },
  { name: 'focus-plan.md', type: 'file', path: 'focus-plan.md' },
  {
    name: 'journal',
    type: 'directory',
    path: 'journal',
    children: [
      { name: 'task-232.md', type: 'file', path: 'journal/task-232.md' },
      { name: 'task-255.md', type: 'file', path: 'journal/task-255.md' },
      { name: 'README.md', type: 'file', path: 'journal/README.md' },
    ],
  },
  { name: 'planner-completed.md', type: 'file', path: 'planner-completed.md' },
  { name: 'planner.md', type: 'file', path: 'planner.md' },
]

describe('filterPlannerTree', () => {
  it('keeps only the curated core files at the top level', () => {
    const names = filterPlannerTree(sampleTree)
      .filter((i) => i.type === 'file')
      .map((i) => i.name)
    expect(names.sort()).toEqual(['AGENTS.md', 'planner-completed.md', 'planner.md'])
  })

  it('hides legacy and stray loose .md files', () => {
    const names = filterPlannerTree(sampleTree).map((i) => i.name)
    expect(names).not.toContain('focus-plan.md')
    expect(names).not.toContain('focus-plan-completed.md')
    expect(names).not.toContain('agent-email-setup.md')
    expect(names).not.toContain('6-week-cycle-plan.md')
  })

  it('drops every non-journal directory, even when it holds core files', () => {
    const names = filterPlannerTree(sampleTree).map((i) => i.name)
    expect(names).not.toContain('_backup_renumber_1781597829')
    expect(names).not.toContain('connect2026.1')
    expect(names).not.toContain('2026-cycle-3')
    expect(names).not.toContain('dist')
    expect(names).not.toContain('outputs')
    // Only the journal directory plus root core files survive.
    expect(names.sort()).toEqual(['AGENTS.md', 'journal', 'planner-completed.md', 'planner.md'])
  })

  it('keeps the journal directory but only its task-<n>.md files', () => {
    const journal = filterPlannerTree(sampleTree).find((i) => i.name === 'journal')
    expect(journal).toBeTruthy()
    const journalFiles = journal.children.map((c) => c.name)
    expect(journalFiles.sort()).toEqual(['task-232.md', 'task-255.md'])
    expect(journalFiles).not.toContain('README.md')
  })

  it('drops a journal directory that has no task files', () => {
    const tree = [
      { name: 'journal', type: 'directory', path: 'journal', children: [
        { name: 'notes.md', type: 'file', path: 'journal/notes.md' },
      ] },
      { name: 'planner.md', type: 'file', path: 'planner.md' },
    ]
    const names = filterPlannerTree(tree).map((i) => i.name)
    expect(names).toEqual(['planner.md'])
  })

  it('drops arbitrary directories wholesale', () => {
    const tree = [
      { name: 'misc', type: 'directory', path: 'misc', children: [
        { name: 'scratch.md', type: 'file', path: 'misc/scratch.md' },
      ] },
    ]
    expect(filterPlannerTree(tree)).toEqual([])
  })

  it('tolerates empty / nullish input', () => {
    expect(filterPlannerTree([])).toEqual([])
    expect(filterPlannerTree(undefined)).toEqual([])
  })
})
