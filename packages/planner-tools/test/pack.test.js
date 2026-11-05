import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRelease } from '../scripts/pack.mjs'
import { BOARD } from './fakeGraph.js'

describe('release archive', () => {
  it('is reproducible, self-contained and runs outside the repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-tools-'))
    try {
      const a = buildRelease(path.join(dir, 'a'))
      const b = buildRelease(path.join(dir, 'b'))
      expect(a.sha256).toBe(b.sha256)
      expect(a.files).toEqual(expect.arrayContaining(['src/focusPlanOps.js', 'src/journalChat.js', 'packages/folder-sync/src/merge.js', 'MANIFEST.json']))
      expect(a.files.some(f => /agent-gate|user-settings|storage\//.test(f))).toBe(false)
      const extract = path.join(dir, 'x')
      fs.mkdirSync(extract)
      expect(spawnSync('tar', ['-xzf', a.file, '-C', extract]).status).toBe(0)
      const bin = path.join(extract, 'package', 'packages', 'planner-tools', 'bin', 'planner.js')
      expect(spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('1.1.0')
      const out = spawnSync(process.execPath, [bin, 'plan'], {
        encoding: 'utf8', cwd: extract,
        input: JSON.stringify({ tool: 'find_tasks', arguments: { query: 'hotel' }, snapshots: { 'planner.md': { content: BOARD, id: 'a', etag: 'b' } } }),
      })
      expect(JSON.parse(out.stdout).result.tasks[0].id).toBe('33')
      // Docs tools run the shipped publisher and docs-core outside the repository.
      const docs = spawnSync(process.execPath, [bin, 'plan'], {
        encoding: 'utf8', cwd: extract,
        input: JSON.stringify({ tool: 'docs_read', arguments: { taskId: '31' }, snapshots: {
          'docs/index.json': { content: '{"version":1,"tasks":{},"docs":{}}', id: 'i', etag: 'e' },
          'journal/task-31.md': { content: '# Task 31: Book flights\n\nNotes.\n', id: 'j', etag: 'f' },
        } }),
      })
      expect(JSON.parse(docs.stdout)).toMatchObject({ state: 'read_complete', result: { taskId: '31', primary: null } })
      expect(a.files).toEqual(expect.arrayContaining(['packages/docs-publisher/src/publisher.js', 'node_modules/@focus/docs-core/index.js']))
      const shippedPublisher = fs.readFileSync(path.join(extract, 'package', 'packages', 'docs-publisher', 'src', 'publisher.js'), 'utf8')
      expect(shippedPublisher).toBe(fs.readFileSync(path.resolve(import.meta.dirname, '../../docs-publisher/src/publisher.js'), 'utf8').replace(/\r\n/g, '\n'))
      const shipped = fs.readFileSync(path.join(extract, 'package', 'src', 'focusPlanOps.js'), 'utf8')
      const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../../src/focusPlanOps.js'), 'utf8').replace(/\r\n/g, '\n')
      expect(shipped).toBe(source)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
