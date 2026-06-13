import { describe, expect, it } from 'vitest'

import { parseTodos, listFiles } from './fsa.js'

describe('parseTodos', () => {
  it('parses checkbox todos at the start of a journal', () => {
    const todos = parseTodos('- [ ] First item\n- [x] Done item')
    expect(todos).toEqual([
      { done: false, text: 'First item' },
      { done: true, text: 'Done item' },
    ])
  })

  it('parses a leading checkbox todo when content starts with UTF-8 BOM', () => {
    const todos = parseTodos('\uFEFF- [ ] First item\n- TODO: Second item')
    expect(todos).toEqual([
      { done: false, text: 'First item' },
      { done: false, text: 'Second item' },
    ])
  })
})

describe('listFiles', () => {
  it('returns an empty list when the directory handle is null', async () => {
    // Regression: the Settings file manager crashed with
    // "Cannot read properties of null (reading 'entries')" when an FSA source's
    // handle was not restored. listFiles must tolerate a null handle.
    await expect(listFiles(null)).resolves.toEqual([])
  })
})
