import fs from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOCS_LIMITS, docBodyByteLength, historyPath, responsePath, reviewSet, validateDocText,
  validateIndexText, validateResponseText,
} from '../../docs-core/src/index.js'
import { SAMPLE_DOC_FILES, SAMPLE_JOURNAL, SAMPLE_PRIMARY_ID, SAMPLE_TASK_ID, SAMPLE_TITLE } from '../../../e2e/fixtures/docs-sample.js'
import { lintDraft, publish, readStatus, writeAtomically } from './publisher.js'

const roots = []
const publishedAt = '2026-10-04T10:00:00Z'
const taskId = 845

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function rootDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-docs-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'journal'), { recursive: true })
  await fs.writeFile(path.join(root, `journal/task-${taskId}.md`), `# Task ${taskId}\n\n${Array.from({ length: 1500 }, (_, i) => `journal${i}`).join(' ')}\n`)
  return root
}

function draft({ status = '**Status: Ready for review.**', additions = '', link = '' } = {}) {
  return [
    `# Task ${taskId}: Sample catch-up task`,
    '',
    status,
    '',
    '## What this is, with no prior context',
    '',
    'A concise summary for a reader with no earlier context.',
    '',
    '## Why it matters',
    '',
    'This helps the task owner make a decision.',
    '',
    '## What changed / what was done',
    '',
    'The current notes are ready.',
    ...(additions ? ['', additions] : []),
    '',
    '## Evidence',
    '',
    `The evidence is in the [supporting notes](${link || 'https://example.com/evidence'}).`,
    '',
    '## Where it stands',
    '',
    'The next step is to review the options.',
    '',
  ].join('\n')
}

async function put(root, relative, text) {
  const filename = path.join(root, relative)
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, text)
}

async function seedSample(root) {
  for (const [relative, text] of Object.entries(SAMPLE_DOC_FILES)) {
    if (relative.startsWith('journal/')) continue
    await put(root, relative, text)
  }
  await put(root, `journal/task-${SAMPLE_TASK_ID}.md`, SAMPLE_JOURNAL)
}

describe('fp-docs draft validation', () => {
  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), /D01 encoding/],
    ['BOM', `\uFEFF${draft()}`, /D01 encoding/],
    ['CRLF', draft().replace(/\n/g, '\r\n'), /D01 encoding/],
    ['corruption marker', draft().replace('concise summary', 'cafÃ© summary'), /D01 encoding/],
    ['raw HTML', draft().replace('A concise summary', '<div>A concise summary</div>'), /D02 grammar/],
    ['missing status', draft({ status: 'Status is ready.' }), /D03 catch-up/],
    ['missing section', draft().replace('## Evidence\n\nThe evidence is in the [supporting notes](https://example.com/evidence).\n\n', ''), /D03 catch-up.*Evidence/],
    ['claim without evidence link', draft({ additions: 'The task is verified.' }), /D03 catch-up.*claim has no evidence link/],
    ['bare task number', draft({ additions: 'See #123 for context.' }), /D03 catch-up.*bare task reference/],
    ['missing document target', draft({ link: 'doc:d-missing001' }), /D04 link.*not listed/],
    ['malformed external URL', draft().replace('https://example.com/evidence', 'http://['), /D04 link.*malformed external URL/],
    ['oversized document', draft().replace('A concise summary', `A ${'x'.repeat(DOCS_LIMITS.docBytes)} summary`), /D07 size/],
  ])('rejects %s', async (_label, text, expected) => {
    const root = await rootDir()
    await expect(lintDraft({ draft: text, root })).rejects.toThrow(expected)
  })

  it('lints supported drafts without modifying any files', async () => {
    const root = await rootDir()
    const result = await lintDraft({ draft: draft(), root })
    expect(result).toMatchObject({ title: `Task ${taskId}: Sample catch-up task`, links: [] })
    expect(await fs.readdir(path.join(root, 'docs')).catch(() => [])).toEqual([])
  })
})

describe('fp-docs publish', () => {
  it('publishes a reader-valid first revision and carries block ids on republish', async () => {
    const root = await rootDir()
    const first = await publish({ root, task: taskId, draft: draft(), summary: 'First publish', force: true, now: publishedAt, makeId: () => 'd-sample845' })
    const republished = await publish({
      root, task: taskId, draft: draft({ additions: 'A newly added detail.' }), summary: 'Updated details',
      baseRev: 1, now: '2026-10-04T10:01:00Z',
    })
    expect(republished.rev).toBe(2)
    for (const previous of first.blocks) {
      const match = republished.blocks.find((block) => block.lines.join('\n') === previous.lines.join('\n'))
      expect(match.id).toBe(previous.id)
    }
    expect(republished.blocks.find((block) => block.lines[0] === 'A newly added detail.').id).toBe('b12')
    expect(await fs.readFile(path.join(root, historyPath(first.id, 1)), 'utf8')).toBe(first.docText)
    const indexText = await fs.readFile(path.join(root, 'docs/index.json'), 'utf8')
    const responseText = await fs.readFile(path.join(root, responsePath(first.id)), 'utf8')
    const index = validateIndexText(indexText)
    const response = validateResponseText(responseText)
    const body = await fs.readFile(path.join(root, `docs/${first.id}/doc.md`), 'utf8')
    expect(validateDocText(body, { docId: first.id, entry: index.docs[first.id], response }).title).toBe(index.docs[first.id].title)
    expect(response.revisions.map((revision) => revision.rev)).toEqual([2, 1])
  })

  it('retains only twenty prior revision snapshots', async () => {
    const root = await rootDir()
    await publish({ root, task: taskId, draft: draft(), summary: 'Initial', force: true, makeId: () => 'd-sample845' })
    for (let rev = 2; rev <= 22; rev++) {
      await publish({
        root, task: taskId, draft: draft({ additions: `Revision ${rev}.` }), summary: `Revision ${rev}`,
        baseRev: rev - 1, now: new Date(Date.UTC(2026, 9, 4, 10, rev)),
      })
    }
    const files = await fs.readdir(path.join(root, 'docs/d-sample845/history'))
    expect(files.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `r${String(i + 2).padStart(4, '0')}.md`))
  })

  it('refuses a changed publisher stamp unless explicitly adopted', async () => {
    const root = await rootDir()
    const first = await publish({ root, task: taskId, draft: draft(), summary: 'Initial', force: true, makeId: () => 'd-sample845' })
    const docPathname = path.join(root, `docs/${first.id}/doc.md`)
    const edited = first.docText.replace('by=fp-docs', 'by=hand-edit')
    await fs.writeFile(docPathname, edited)
    await expect(publish({ root, task: taskId, draft: draft(), summary: 'Update', baseRev: 1 }))
      .rejects.toThrow(/D10 external edit/)
    expect(await fs.readFile(docPathname, 'utf8')).toBe(edited)
    const adopted = await publish({
      root, task: taskId, draft: draft(), summary: 'Adopted update', baseRev: 1, adoptExternalEdit: true,
    })
    expect(adopted.rev).toBe(2)
  })

  it('refuses a body-only hand edit even when the publisher stamp is left intact', async () => {
    const root = await rootDir()
    const first = await publish({ root, task: taskId, draft: draft(), summary: 'Initial', force: true, makeId: () => 'd-sample845' })
    const docPathname = path.join(root, `docs/${first.id}/doc.md`)
    const edited = first.docText.replace('A concise summary', 'A hand-edited summary')
    await fs.writeFile(docPathname, edited)
    await expect(publish({ root, task: taskId, draft: draft(), summary: 'Update', baseRev: 1 }))
      .rejects.toThrow(/D10 external edit/)
    expect(await fs.readFile(docPathname, 'utf8')).toBe(edited)
  })

  it('validates and writes the e2e sample through the existing Docs reader validators', async () => {
    const root = await rootDir()
    await seedSample(root)
    const sampleDraft = draft({ link: `doc:d-support845` })
    const result = await publish({
      root, task: SAMPLE_TASK_ID, draft: sampleDraft, summary: 'Publisher e2e fixture',
      baseRev: 1, now: publishedAt,
    })
    const index = validateIndexText(await fs.readFile(path.join(root, 'docs/index.json'), 'utf8'))
    const response = validateResponseText(await fs.readFile(path.join(root, responsePath(SAMPLE_PRIMARY_ID)), 'utf8'))
    const doc = await fs.readFile(path.join(root, `docs/${SAMPLE_PRIMARY_ID}/doc.md`), 'utf8')
    expect(result.id).toBe(SAMPLE_PRIMARY_ID)
    expect(validateDocText(doc, { docId: SAMPLE_PRIMARY_ID, entry: index.docs[SAMPLE_PRIMARY_ID], response }).title).toBe(SAMPLE_TITLE)
  })

  it('status reports the shared threshold result and primary revision', async () => {
    const root = await rootDir()
    await publish({ root, task: taskId, draft: draft(), summary: 'Initial', force: true, makeId: () => 'd-sample845' })
    const status = await readStatus({ root, task: taskId })
    expect(status).toMatchObject({
      task: taskId,
      threshold: 'reached',
      primary: { id: 'd-sample845', rev: 1 },
      linkedDocs: [],
      openCount: 0,
    })
  })
})

describe('fp-docs CLI', () => {
  it('prints JSON status and rejects non-canonical task ids', async () => {
    const root = await rootDir()
    const cli = path.resolve('packages/docs-publisher/bin/fp-docs.js')
    const env = { ...process.env, PLANNER_PATH: root }
    const result = spawnSync(process.execPath, [cli, 'status', '--task', String(taskId), '--json'], { encoding: 'utf8', env })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ task: taskId, threshold: 'reached', primary: null })
    const invalid = spawnSync(process.execPath, [cli, 'status', '--task', `0${taskId}`], { encoding: 'utf8', env })
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toMatch(/canonical positive integer/)
  })
})

describe('fp-docs size limits and atomic writes', () => {
  it('refuses an oversized index, review file, and review-set body aggregate', async () => {
    const root = await rootDir()
    const oversizedIndex = JSON.stringify({
      version: 1, tasks: {}, docs: {}, unused: 'x'.repeat(DOCS_LIMITS.indexBytes),
    })
    await put(root, 'docs/index.json', oversizedIndex)
    await expect(lintDraft({ draft: draft(), root })).rejects.toThrow(/D07 size/)

    const clean = await rootDir()
    await publish({ root: clean, task: taskId, draft: draft(), summary: 'Initial', force: true, makeId: () => 'd-sample845' })
    await put(clean, 'docs/d-sample845/review.json', JSON.stringify({
      version: 1, comments: {}, reviews: {}, readRev: 0, unused: 'x'.repeat(DOCS_LIMITS.reviewBytes),
    }))
    await expect(publish({ root: clean, task: taskId, draft: draft(), summary: 'Update', baseRev: 1 }))
      .rejects.toThrow(/D07 size/)
  })

  it('refuses a review set larger than two MiB across the depth-three traversal', async () => {
    const root = await rootDir()
    const ids = Array.from({ length: 14 }, (_, i) => `d-linked${String(i).padStart(2, '0')}`)
    const linksFor = (index) => {
      const left = index * 2 + 2
      return [left, left + 1].filter((child) => child < ids.length).map((child) => ids[child])
    }
    const docMap = {}
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const links = linksFor(i)
      docMap[id] = { title: `Supporting ${i}`, primary: false, rev: 1, updatedAt: publishedAt, links }
      await put(root, `docs/${id}/doc.md`, [
        `<!-- docs v1 id=${id} rev=1 published=${publishedAt} by=fp-docs -->`,
        `# Supporting ${i}`,
        '',
        '<!-- @b1 -->',
        'x'.repeat(180 * 1024),
        '',
      ].join('\n'))
      await put(root, `docs/${id}/response.json`, JSON.stringify({
        version: 1, rev: 1, revisions: [{ rev: 1, at: publishedAt, summary: 'Initial' }], dispositions: {},
      }))
    }
    const children = [ids[0], ids[1]]
    const index = {
      version: 1, tasks: {}, docs: {
        ...docMap,
        'd-root845': { title: `Task ${taskId}: Sample catch-up task`, task: taskId, primary: true, rev: 1, updatedAt: publishedAt, links: children },
      },
    }
    index.tasks[String(taskId)] = 'd-root845'
    await put(root, 'docs/index.json', JSON.stringify(index))
    await put(root, 'docs/d-root845/doc.md', [
      `<!-- docs v1 id=d-root845 rev=1 published=${publishedAt} by=fp-docs -->`,
      `# Task ${taskId}: Sample catch-up task`,
      '',
      '<!-- @b1 -->',
      '**Status: Ready.**',
      '',
    ].join('\n'))
    await put(root, 'docs/d-root845/response.json', JSON.stringify({
      version: 1, rev: 1, revisions: [{ rev: 1, at: publishedAt, summary: 'Initial' }], dispositions: {},
    }))
    expect(reviewSet(index, 'd-root845', 3)).toHaveLength(15)
    const aggregateBytes = await Promise.all(reviewSet(index, 'd-root845', 3).map(async (id) =>
      docBodyByteLength(await fs.readFile(path.join(root, `docs/${id}/doc.md`), 'utf8'))))
    expect(aggregateBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(DOCS_LIMITS.reviewSetBytes)
    await expect(publish({
      root, task: taskId, draft: draft({
        link: `doc:${ids[0]}`,
        additions: `[another supporting note](doc:${ids[1]})`,
      }), summary: 'Update', baseRev: 1,
    })).rejects.toThrow(/D07 size/)
  })

  it('restores earlier files if an injected rename failure interrupts the staged write', async () => {
    const root = await rootDir()
    const first = path.join(root, 'a.txt')
    const second = path.join(root, 'b.txt')
    await fs.writeFile(first, 'old-a')
    await fs.writeFile(second, 'old-b')
    let renames = 0
    const io = new Proxy(fs, {
      get(target, property) {
        if (property === 'rename') return async (...args) => {
          renames++
          if (renames === 2) throw new Error('injected rename failure')
          return fs.rename(...args)
        }
        const value = target[property]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(writeAtomically([
      { path: first, content: 'new-a' },
      { path: second, content: 'new-b' },
    ], { io })).rejects.toThrow('injected rename failure')
    expect(await fs.readFile(first, 'utf8')).toBe('old-a')
    expect(await fs.readFile(second, 'utf8')).toBe('old-b')
  })
})
