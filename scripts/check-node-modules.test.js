import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyNodeModules, buildReport, checkNodeModules } from './check-node-modules.mjs'

// GH #321. `git worktree remove --force` deletes THROUGH a node_modules junction
// and leaves the shared install EXISTING BUT EMPTY. Every existence check is true
// for that state, so the failure travels to another session and arrives as
// "'vitest' is not recognized" -- which reads like a broken change.
//
// These tests pin the one distinction that stops the misattribution: empty is not
// the same as missing, and it is not the same as fine.

const fakeIo = (byDir) => ({
  readdirSync(dir) {
    if (!(dir in byDir)) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`)
      err.code = 'ENOENT'
      throw err
    }
    const v = byDir[dir]
    if (v instanceof Error) throw v
    return v
  },
})

describe('classifyNodeModules', () => {
  it('reports populated when there are entries', () => {
    const io = fakeIo({ '/repo/node_modules': ['vitest', 'vite', '.bin'] })
    expect(classifyNodeModules('/repo/node_modules', io)).toEqual({ state: 'populated', count: 3 })
  })

  it('reports empty -- not missing -- for a directory that exists with nothing in it', () => {
    // The whole point. `fs.existsSync` is TRUE here, which is why the bug is silent.
    const io = fakeIo({ '/repo/node_modules': [] })
    expect(classifyNodeModules('/repo/node_modules', io)).toEqual({ state: 'empty', count: 0 })
  })

  it('reports missing when the directory is absent', () => {
    expect(classifyNodeModules('/repo/node_modules', fakeIo({}))).toEqual({ state: 'missing', count: 0 })
  })

  it('does not treat an unreadable directory as empty', () => {
    // Misreading a permissions error as "emptied" would raise a false #321 alarm.
    const boom = new Error('EACCES: permission denied')
    boom.code = 'EACCES'
    const io = fakeIo({ '/repo/node_modules': boom })
    expect(classifyNodeModules('/repo/node_modules', io).state).toBe('unreadable')
  })
})

describe('buildReport', () => {
  it('fails ONLY for the empty state', () => {
    expect(buildReport({ state: 'empty', count: 0 }, '/repo/node_modules').ok).toBe(false)
    expect(buildReport({ state: 'populated', count: 9 }, '/repo/node_modules').ok).toBe(true)
    expect(buildReport({ state: 'missing', count: 0 }, '/repo/node_modules').ok).toBe(true)
    expect(buildReport({ state: 'unreadable', count: -1 }, '/repo/node_modules').ok).toBe(true)
  })

  it('names the issue and the repair, so the reader does not debug their own change', () => {
    const r = buildReport({ state: 'empty', count: 0 }, '/repo/node_modules')
    expect(r.message).toContain('#321')
    expect(r.message).toContain('npm ci')
    expect(r.message).toContain('Nothing you changed is broken')
  })

  it('points at the safe teardown so the cause stops recurring', () => {
    const r = buildReport({ state: 'empty', count: 0 }, '/repo/node_modules')
    expect(r.message).toContain('scripts/remove-worktree.ps1')
  })

  it('stays silent when everything is fine', () => {
    // A guard that prints on every healthy run is a guard people stop reading.
    expect(buildReport({ state: 'populated', count: 281 }, '/repo/node_modules').quiet).toBe(true)
    expect(buildReport({ state: 'missing', count: 0 }, '/repo/node_modules').quiet).toBe(false)
  })
})

describe('checkNodeModules against a real directory', () => {
  it('flags an emptied install and clears a populated one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm321-'))
    try {
      const nm = path.join(root, 'node_modules')

      expect(checkNodeModules(root).ok).toBe(true) // absent: not an error

      fs.mkdirSync(nm)
      const emptied = checkNodeModules(root)
      expect(emptied.ok).toBe(false)
      expect(emptied.dir).toBe(nm)

      fs.mkdirSync(path.join(nm, 'vitest'))
      expect(checkNodeModules(root).ok).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
