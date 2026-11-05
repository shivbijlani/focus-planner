import { describe, expect, it } from 'vitest'
import { cleanupCategory, isSidebarClutter, makeFileArchive } from './fileCleanup.js'
import { hideSidebarClutter } from '../fileTreeFilter.js'

describe('technical clutter and cleanup', () => {
  it('offers only recognized tool outputs and old backup copies, never recovery or live files', () => {
    expect(cleanupCategory('.playwright-mcp/console.log')).toBe('Tooling leftovers')
    expect(cleanupCategory('ig-home.md')).toBe('Tooling leftovers')
    expect(cleanupCategory('user-settings.md.bak-20260907')).toBe('Old backup copies')
    for (const path of ['planner.md', 'journal/task-1.md', 'journal/task-1-briefing.md', 'docs/report.bak', 'sync-conflicts/planner.md.bak-123', 'agent-lore.md', 'planner-rave.md']) {
      expect(cleanupCategory(path)).toBeNull()
    }
  })
  it('hides technical files without losing supporting journals or personal directories', () => {
    const tree = [
      { type: 'file', name: 'AGENTS.md', path: 'AGENTS.md' },
      { type: 'directory', name: '.playwright-mcp', path: '.playwright-mcp', children: [] },
      { type: 'directory', name: 'sync-conflicts', path: 'sync-conflicts', children: [] },
      { type: 'directory', name: 'Career', path: 'Career', children: [{ type: 'file', name: 'notes.md', path: 'Career/notes.md' }] },
      { type: 'directory', name: 'journal', path: 'journal', children: [{ type: 'file', name: 'task-1-briefing.md', path: 'journal/task-1-briefing.md' }] },
    ]
    const filtered = hideSidebarClutter(tree)
    expect(filtered.map(item => item.name)).toEqual(['Career', 'journal'])
    expect(filtered[1].children).toHaveLength(1)
    expect(tree).toHaveLength(5)
    expect(isSidebarClutter('user-settings.md')).toBe(true)
  })
  it('archives every selected path with its exact content', async () => {
    const result = JSON.parse(await makeFileArchive(['a.bak', 'b.bak'], async path => `body:${path}`))
    expect(result.files).toEqual({ 'a.bak': 'body:a.bak', 'b.bak': 'body:b.bak' })
    await expect(makeFileArchive(['a.bak'], async () => { throw new Error('read failed') })).rejects.toThrow('read failed')
  })
})
