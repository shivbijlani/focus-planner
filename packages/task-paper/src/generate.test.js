import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { generatePaper, generateAll, paperFilename } from './generate.js'

const SENTINEL = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->'

function agentJournal(id, body = 'Current state.') {
  return [
    `# Task ${id}: fixture`,
    '',
    '---',
    SENTINEL,
    '',
    '## \u{1F319} Overnight Agent \u2014 a turn',
    '',
    '<!-- from: overnight-agent -->',
    '',
    '**Status:** In-progress \u00B7 2026-09-02',
    '',
    body,
    '',
    '<!-- /overnight-agent turn-end -->',
  ].join('\n')
}

/** Minimal in-memory fs so these tests never touch a real disk. */
function memfs(files = {}) {
  const store = new Map(Object.entries(files))
  const dirs = new Set()
  return {
    store,
    dirs,
    readFileSync(p) {
      const key = path.normalize(p)
      if (!store.has(key)) {
        const err = new Error(`ENOENT: ${key}`)
        err.code = 'ENOENT'
        throw err
      }
      return store.get(key)
    },
    writeFileSync(p, data) {
      store.set(path.normalize(p), data)
    },
    mkdirSync(p) {
      dirs.add(path.normalize(p))
    },
    readdirSync() {
      return [...store.keys()].map((k) => path.basename(k))
    },
  }
}

const DIR = path.normalize('/planner/journal')
const journalPath = (id) => path.join(DIR, `task-${id}.md`)
const paperPath = (id) => path.join(DIR, 'paper', `task-${id}.html`)

describe('paperFilename', () => {
  it('names the paper after its task', () => {
    expect(paperFilename('468')).toBe('task-468.html')
  })
})

describe('generatePaper', () => {
  it('creates the paper in a paper/ subfolder, leaving the journal untouched', () => {
    // A subfolder is not cosmetic: the planner app and several sweeps enumerate
    // journal\ and key off `task-<id>.md`. A second file per task in that folder
    // invites a reader to pick up the wrong one.
    const fsImpl = memfs({ [journalPath(468)]: agentJournal(468) })
    const before = fsImpl.store.get(journalPath(468))

    const result = generatePaper(journalPath(468), { fsImpl })

    expect(result).toMatchObject({ taskId: '468', written: true, reason: 'created' })
    expect(path.normalize(result.outPath)).toBe(paperPath(468))
    expect(fsImpl.store.get(paperPath(468))).toContain('<!doctype html>')
    expect(fsImpl.store.get(journalPath(468))).toBe(before)
  })

  it('rewrites nothing when the journal has not changed', () => {
    // The steady state on a nightly cadence. Without it, every file in OneDrive
    // churns on every run.
    const fsImpl = memfs({ [journalPath(468)]: agentJournal(468) })
    generatePaper(journalPath(468), { fsImpl })
    const first = fsImpl.store.get(paperPath(468))

    const again = generatePaper(journalPath(468), { fsImpl })

    expect(again).toMatchObject({ written: false, reason: 'unchanged' })
    expect(fsImpl.store.get(paperPath(468))).toBe(first)
  })

  it('rewrites when the journal has changed', () => {
    const fsImpl = memfs({ [journalPath(468)]: agentJournal(468) })
    generatePaper(journalPath(468), { fsImpl })
    fsImpl.store.set(journalPath(468), agentJournal(468, 'A new current state.'))

    const result = generatePaper(journalPath(468), { fsImpl })

    expect(result).toMatchObject({ written: true, reason: 'updated' })
    expect(fsImpl.store.get(paperPath(468))).toContain('A new current state.')
  })

  it('links to the Telegram topic when the journal carries a tg-meta stamp', () => {
    const withMeta = agentJournal(468).replace(
      '# Task 468: fixture',
      '# Task 468: fixture\n<!-- tg-meta chatId=-1004310604015 threadId=2712 -->',
    )
    const fsImpl = memfs({ [journalPath(468)]: withMeta })

    generatePaper(journalPath(468), { fsImpl })

    expect(fsImpl.store.get(paperPath(468))).toContain('https://t.me/c/4310604015/2712')
  })

  it('omits the Telegram link when there is no stamp', () => {
    const fsImpl = memfs({ [journalPath(468)]: agentJournal(468) })
    generatePaper(journalPath(468), { fsImpl })
    expect(fsImpl.store.get(paperPath(468))).not.toContain('t.me/c/')
  })
})

describe('generateAll', () => {
  it('skips journals the agent has never written to', () => {
    const fsImpl = memfs({
      [journalPath(1)]: '# Task 1: untouched\n\nnotes only\n',
      [journalPath(2)]: agentJournal(2),
    })

    const results = generateAll(DIR, { fsImpl })

    expect(results.find((r) => r.taskId === '1')).toMatchObject({ reason: 'no-agent-turn' })
    expect(results.find((r) => r.taskId === '2')).toMatchObject({ written: true })
  })

  it('honours a task-id filter', () => {
    const fsImpl = memfs({
      [journalPath(1)]: agentJournal(1),
      [journalPath(2)]: agentJournal(2),
    })

    const results = generateAll(DIR, { fsImpl, taskIds: ['2'] })

    expect(results.map((r) => r.taskId)).toEqual(['2'])
  })

  it('ignores files that are not task journals', () => {
    const fsImpl = memfs({
      [path.join(DIR, 'README.md')]: '# not a journal',
      [path.join(DIR, 'task-5.md')]: agentJournal(5),
    })

    expect(generateAll(DIR, { fsImpl }).map((r) => r.taskId)).toEqual(['5'])
  })

  it('reports an unreadable journal without aborting the sweep', () => {
    // These run unattended; one bad file must never cost the whole run.
    const fsImpl = memfs({ [journalPath(1)]: agentJournal(1), [journalPath(2)]: agentJournal(2) })
    const realRead = fsImpl.readFileSync.bind(fsImpl)
    fsImpl.readFileSync = (p) => {
      if (path.normalize(p) === journalPath(1)) throw new Error('boom')
      return realRead(p)
    }

    const results = generateAll(DIR, { fsImpl })

    expect(results.find((r) => r.taskId === '1')).toMatchObject({ reason: 'error' })
    expect(results.find((r) => r.taskId === '2')).toMatchObject({ written: true })
  })

  it('processes journals in task-id order, not string order', () => {
    const fsImpl = memfs({
      [journalPath(10)]: agentJournal(10),
      [journalPath(9)]: agentJournal(9),
    })

    expect(generateAll(DIR, { fsImpl }).map((r) => r.taskId)).toEqual(['9', '10'])
  })
})
