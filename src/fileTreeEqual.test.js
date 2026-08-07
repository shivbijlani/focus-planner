import { describe, expect, it } from 'vitest'

import { sameFileTree } from './fileTreeEqual.js'

describe('sameFileTree', () => {
  const tree = () => [
    { name: 'planner.md', type: 'file', path: 'planner.md' },
    {
      name: 'journal',
      type: 'directory',
      path: 'journal',
      children: [
        { name: 'task-1.md', type: 'file', path: 'journal/task-1.md' },
      ],
    },
  ]

  it('treats separately loaded but structurally identical trees as equal', () => {
    expect(sameFileTree(tree(), tree())).toBe(true)
  })

  it('detects additions and path changes', () => {
    const added = tree()
    added[1].children.push({ name: 'task-2.md', type: 'file', path: 'journal/task-2.md' })
    expect(sameFileTree(tree(), added)).toBe(false)

    const renamed = tree()
    renamed[0].path = 'other.md'
    expect(sameFileTree(tree(), renamed)).toBe(false)
  })
})
