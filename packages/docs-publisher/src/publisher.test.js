import fs from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOCS_LIMITS, docBodyByteLength, historyPath, responsePath, reviewSet, validateDocText,
  validateIndexText, validateResponseText, validateReviewText,
} from '../../docs-core/src/index.js'
import {
  SAMPLE_DOC_FILES, SAMPLE_JOURNAL, SAMPLE_LINKED_ID, SAMPLE_PRIMARY_ID, SAMPLE_TASK_ID, SAMPLE_TITLE,
} from '../../../e2e/fixtures/docs-sample.js'
import { lintDraft, publish, readComments, readStatus, writeAtomically } from './publisher.js'

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

function reviewFile(comments) {
  return JSON.stringify({
    version: 1,
    comments,
    reviews: { rv_batch: { submittedAt: publishedAt, rev: 1 } },
    readRev: 0,
  })
}

function comment({ block = 'b1', quote, prefix = '', suffix = '', offset = 0, status = 'open' }) {
  return {
    rev: 1,
    anchor: { block, quote, prefix, suffix, offset },
    intent: 'question',
    body: 'Please clarify.',
    createdAt: publishedAt,
    reviewId: 'rv_batch',
    status,
    clock: 1,
    ...(status === 'reopened' ? { reopenedAt: publishedAt, reopenedRev: 1 } : {}),
  }
}

async function seedCommentReviews(root) {
  await seedSample(root)
  const primaryResponse = JSON.parse(SAMPLE_DOC_FILES[`docs/${SAMPLE_PRIMARY_ID}/response.json`])
  primaryResponse.dispositions.c_resolved = { status: 'answered', rev: 1, blocks: ['b1'] }
  await put(root, `docs/${SAMPLE_PRIMARY_ID}/response.json`, JSON.stringify(primaryResponse))
  await put(root, `docs/${SAMPLE_PRIMARY_ID}/review.json`, reviewFile({
    c_exact: comment({ quote: 'Sample reader', prefix: 'Status: ', suffix: ' is ready.', offset: 8 }),
    c_moved: comment({ block: 'b9', quote: 'This seeded task' }),
    c_outdated: comment({ block: 'b7', quote: 'text no longer present' }),
    c_resolved: comment({ quote: 'Sample reader' }),
    c_reopened: comment({ block: 'b2', quote: 'This seeded task', offset: 8, status: 'reopened' }),
  }))
  await put(root, `docs/${SAMPLE_LINKED_ID}/review.json`, reviewFile({
    c_linked: comment({ quote: 'This linked sample document' }),
  }))
}

describe('fp-docs draft validation', () => {
  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), /D01 encoding/],
    ['BOM', `\uFEFF${draft()}`, /D01 encoding/],
    ['CRLF', draft().replace(/\n/g, '\r\n'), /D01 encoding/],
    ['corruption marker', draft().replace('concise summary', 'cafÃ© summary'), /D01 encoding/],
    ['raw HTML', draft().replace('A concise summary', '<div>A concise summary</div>'), /D02 grammar/],
    ['unsupported strikethrough', draft().replace('concise summary', '~~concise~~ summary'), /D02 grammar/],
    ['missing status', draft({ status: 'Status is ready.' }), /D03 catch-up/],
    ['missing section', draft().replace('## Evidence\n\nThe evidence is in the [supporting notes](https://example.com/evidence).\n\n', ''), /D03 catch-up.*Evidence/],
    ['claim without evidence link', draft({ additions: 'The task is verified.' }), /D03 catch-up.*claim has no evidence link/],
    ['bare task number', draft({ additions: 'See #123 for context.' }), /D03 catch-up.*bare task reference/],
    ['missing document target', draft({ link: 'doc:d-missing001' }), /D04 link.*not listed/],
    ['malformed external URL', draft().replace('https://example.com/evidence', 'http://['), /D04 link.*malformed external URL/],
    ['unsafe URL scheme', draft().replace('https://example.com/evidence', 'javascript:alert(1)'), /D04 link.*malformed external URL/],
    ['oversized document', draft().replace('A concise summary', `A ${'x'.repeat(DOCS_LIMITS.docBytes)} summary`), /D07 size/],
  ])('rejects %s', async (_label, text, expected) => {
    const root = await rootDir()
    await expect(lintDraft({ draft: text, root })).rejects.toThrow(expected)
  })

  it('lints supported drafts without modifying any files', async () => {
    const root = await rootDir()
    const result = await lintDraft({ draft: draft(), root })
    expect(result).toMatchObject({ title: `Task ${taskId}: Sample catch-up task`, links: [] })
    await expect(lintDraft({
      draft: draft().replace('A concise summary', 'Use `~~text~~` and `[doc](doc:d-missing)` as code examples'),
      root,
    })).resolves.toMatchObject({ title: `Task ${taskId}: Sample catch-up task`, links: [] })
    expect(await fs.readdir(path.join(root, 'docs')).catch(() => [])).toEqual([])
  })

  it('identifies a malformed index as a data error', async () => {
    const root = await rootDir()
    await put(root, 'docs/index.json', '{')
    await expect(lintDraft({ draft: draft(), root })).rejects.toThrow(/D09 data.*not valid JSON/)
    await put(root, 'docs/index.json', '')
    await expect(lintDraft({ draft: draft(), root })).rejects.toThrow(/D09 data.*is empty/)
  })

  it('does not probe local addresses when --check-links is requested', async () => {
    const root = await rootDir()
    await expect(lintDraft({
      draft: draft().replace('https://example.com/evidence', 'http://127.0.0.1/metadata'),
      root,
      checkLinks: true,
    })).rejects.toThrow(/D04 link.*private or local network targets/)
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
    expect(republished.index.docs[first.id].nextBlockId).toBe(13)
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
    expect(files.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `r${String(i + 3).padStart(4, '0')}.md`))
  })

  it('does not reuse retired block ids after their snapshots rotate out', async () => {
    const root = await rootDir()
    const expanded = `${draft()}\n${Array.from({ length: 100 }, (_, i) => `Historical paragraph ${i}.`).join('\n\n')}\n`
    const first = await publish({
      root, task: taskId, draft: expanded, summary: 'Many blocks', force: true, makeId: () => 'd-sample845',
    })
    expect(first.index.docs[first.id].nextBlockId).toBe(112)
    await publish({ root, task: taskId, draft: draft(), summary: 'Retire old blocks', baseRev: 1 })
    for (let rev = 3; rev <= 23; rev++) {
      await publish({
        root, task: taskId, draft: draft(), summary: `Revision ${rev}`, baseRev: rev - 1,
      })
    }
    const final = await publish({
      root, task: taskId, draft: `${draft()}\nLate new paragraph.\n`, summary: 'New block', baseRev: 23,
    })
    expect(final.blocks.at(-1).id).toBe('b112')
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
    const adopted = await publish({
      root, task: taskId, draft: draft(), summary: 'Adopted body edit', baseRev: 1, adoptExternalEdit: true,
    })
    expect(adopted.rev).toBe(2)
  })

  it('validates and writes the e2e sample through the existing Docs reader validators', async () => {
    const root = await rootDir()
    await seedSample(root)
    const draftWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-docs-draft-'))
    roots.push(draftWorkspace)
    const sampleDraft = path.join(draftWorkspace, 'sample-draft.md')
    await fs.writeFile(sampleDraft, draft({ link: 'doc:d-support845' }))
    const cli = path.resolve('packages/docs-publisher/bin/fp-docs.js')
    const result = spawnSync(process.execPath, [
      cli, 'publish', '--task', String(SAMPLE_TASK_ID), '--draft', sampleDraft,
      '--summary', 'Publisher e2e fixture', '--base-rev', '1',
    ], { encoding: 'utf8', env: { ...process.env, PLANNER_PATH: root } })
    expect(result.status, result.stderr).toBe(0)
    const index = validateIndexText(await fs.readFile(path.join(root, 'docs/index.json'), 'utf8'))
    const response = validateResponseText(await fs.readFile(path.join(root, responsePath(SAMPLE_PRIMARY_ID)), 'utf8'))
    const reviewText = await fs.readFile(path.join(root, `docs/${SAMPLE_PRIMARY_ID}/review.json`), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const review = validateReviewText(reviewText)
    const doc = await fs.readFile(path.join(root, `docs/${SAMPLE_PRIMARY_ID}/doc.md`), 'utf8')
    expect(result.stdout).toMatch(new RegExp(`Published ${SAMPLE_PRIMARY_ID} revision 2`))
    expect(validateDocText(doc, { docId: SAMPLE_PRIMARY_ID, entry: index.docs[SAMPLE_PRIMARY_ID], response }).title).toBe(SAMPLE_TITLE)
    expect(review.readRev).toBe(0)
  })

  it('creates a supporting doc from a new alias and rewrites doc:new links', async () => {
    const root = await rootDir()
    const ids = ['d-support845', 'd-primary845']
    const result = await publish({
      root,
      task: taskId,
      draft: draft({ link: 'doc:new:notes' }),
      linked: [{ alias: 'notes', draft: '# Supporting notes\n\nContext for the primary document.\n' }],
      summary: 'Publish with supporting notes',
      force: true,
      makeId: () => ids.shift(),
    })
    expect(result.id).toBe('d-primary845')
    expect(result.index.docs[result.id].links).toEqual(['d-support845'])
    const linked = await fs.readFile(path.join(root, 'docs/d-primary845/doc.md'), 'utf8')
    expect(linked).toContain('(doc:d-support845)')
    expect(validateIndexText(await fs.readFile(path.join(root, 'docs/index.json'), 'utf8')).docs['d-support845'].primary).toBe(false)
    expect(validateResponseText(await fs.readFile(path.join(root, 'docs/d-support845/response.json'), 'utf8')).rev).toBe(1)
  })

  it('copies a Telegram deep link from task journal metadata into the primary index entry', async () => {
    const root = await rootDir()
    await put(root, `journal/task-${taskId}.md`, SAMPLE_JOURNAL)
    const result = await publish({
      root, task: taskId, draft: draft(), summary: 'Primary with Telegram metadata',
      force: true, makeId: () => 'd-sample845',
    })
    expect(result.index.docs[result.id].telegramUrl).toBe('https://t.me/focusplanner_sample')
  })

  it('requires and checks the base revision when updating a linked document', async () => {
    const root = await rootDir()
    await seedSample(root)
    const linkedDraft = '# Supporting sample notes\n\nUpdated linked context.\n'
    await expect(publish({
      root, task: taskId, draft: draft({ link: 'doc:d-support845' }), summary: 'Update linked',
      baseRev: 1, linked: [{ id: 'd-support845', draft: linkedDraft }],
    })).rejects.toThrow(/D11 linked input.*requires --linked-base-rev/)
    await expect(publish({
      root, task: taskId, draft: draft({ link: 'doc:d-support845' }), summary: 'Stale linked update',
      baseRev: 1, linked: [{ id: 'd-support845', baseRev: 2, draft: linkedDraft }],
    })).rejects.toThrow(/D06 concurrency.*--linked-base-rev/)
    const result = await publish({
      root, task: taskId, draft: draft({ link: 'doc:d-support845' }), summary: 'Update linked',
      baseRev: 1, linked: [{ id: 'd-support845', baseRev: 1, draft: linkedDraft }],
    })
    expect(result.linked[0]).toMatchObject({ id: 'd-support845', rev: 2 })
    expect(validateResponseText(await fs.readFile(path.join(root, 'docs/d-support845/response.json'), 'utf8')).rev).toBe(2)
  })

  it('returns open and reopened comments grouped by review-set doc with re-anchored placements', async () => {
    const root = await rootDir()
    await seedCommentReviews(root)
    const result = await readComments({ root, task: SAMPLE_TASK_ID })
    expect(result.task).toBe(SAMPLE_TASK_ID)
    expect(result.docs.map(({ id }) => id)).toEqual([SAMPLE_PRIMARY_ID, SAMPLE_LINKED_ID])
    expect(result.docs[0]).toMatchObject({ title: SAMPLE_TITLE, rev: 1 })
    const primaryComments = Object.fromEntries(result.docs[0].comments.map((item) => [item.id, item]))
    expect(primaryComments.c_exact.placement).toEqual({ status: 'anchored', block: 'b1', start: 8, endBlock: 'b1', end: 21 })
    expect(primaryComments.c_moved.placement).toMatchObject({ status: 'moved', block: 'b2', start: 8 })
    expect(primaryComments.c_outdated.placement).toEqual({ status: 'outdated' })
    expect(primaryComments.c_reopened).toMatchObject({ status: 'reopened', placement: { status: 'anchored', block: 'b2', start: 8 } })
    expect(primaryComments).not.toHaveProperty('c_resolved')
    expect(result.docs[1].comments[0]).toMatchObject({
      id: 'c_linked', placement: { status: 'anchored', block: 'b1' },
    })
  })

  it('status reports the shared threshold result and primary revision', async () => {
    const root = await rootDir()
    await publish({ root, task: taskId, draft: draft(), summary: 'Initial', force: true, makeId: () => 'd-sample845' })
    const status = await readStatus({ root, task: taskId })
    expect(status).toMatchObject({
      task: taskId,
      threshold: 'reached',
      primary: { id: 'd-sample845', rev: 1, readStatus: 'unread' },
      linkedDocs: [],
      openCount: 0,
    })
  })

  it('uses the configured threshold for first publication', async () => {
    const root = await rootDir()
    await put(root, `journal/task-${taskId}.md`, 'one two three')
    await put(root, 'user-settings.md', '| Catch-up doc threshold | 3 |')
    const result = await publish({ root, task: taskId, draft: draft(), summary: 'Threshold met' })
    expect(result.rev).toBe(1)
  })
})

describe('fp-docs CLI', () => {
  it('prints grouped comments as JSON without modifying publisher files', async () => {
    const root = await rootDir()
    await seedCommentReviews(root)
    const cli = path.resolve('packages/docs-publisher/bin/fp-docs.js')
    const env = { ...process.env, PLANNER_PATH: root }
    const paths = [
      'docs/index.json',
      `docs/${SAMPLE_PRIMARY_ID}/review.json`,
      `docs/${SAMPLE_PRIMARY_ID}/doc.md`,
      `docs/${SAMPLE_PRIMARY_ID}/response.json`,
    ]
    const before = await Promise.all(paths.map((relative) => fs.readFile(path.join(root, relative), 'utf8')))
    const result = spawnSync(process.execPath, [
      cli, 'comments', '--task', String(SAMPLE_TASK_ID), '--json',
    ], { encoding: 'utf8', env })
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.task).toBe(SAMPLE_TASK_ID)
    expect(output.docs.map(({ id }) => id)).toEqual([SAMPLE_PRIMARY_ID, SAMPLE_LINKED_ID])
    expect(output.docs[0].comments.map(({ id }) => id)).toContain('c_exact')
    expect(output.docs[1].comments.map(({ id }) => id)).toContain('c_linked')
    expect(await Promise.all(paths.map((relative) => fs.readFile(path.join(root, relative), 'utf8')))).toEqual(before)
  })

  it('prints JSON status and rejects non-canonical task ids', async () => {
    const root = await rootDir()
    const cli = path.resolve('packages/docs-publisher/bin/fp-docs.js')
    const env = { ...process.env, PLANNER_PATH: root }
    const result = spawnSync(process.execPath, [cli, 'status', '--task', String(taskId), '--json'], { encoding: 'utf8', env })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ task: taskId, threshold: 'reached', primary: null })
    const invalid = spawnSync(process.execPath, [cli, 'status', '--task', `0${taskId}`], { encoding: 'utf8', env })
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toMatch(/canonical positive integer/)
  })

  it('runs publish with the documented new linked-doc flag', async () => {
    const root = await rootDir()
    const primaryFile = path.join(root, 'primary.md')
    const linkedFile = path.join(root, 'linked.md')
    await fs.writeFile(primaryFile, draft({ link: 'doc:new:notes' }))
    await fs.writeFile(linkedFile, '# Supporting notes\n\nLinked context.\n')
    const cli = path.resolve('packages/docs-publisher/bin/fp-docs.js')
    const result = spawnSync(process.execPath, [
      cli, 'publish', '--task', String(taskId), '--draft', primaryFile,
      '--summary', 'CLI publish', '--force', '--linked', `new:notes=${linkedFile}`,
    ], { encoding: 'utf8', env: { ...process.env, PLANNER_PATH: root } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/Published d-[a-z0-9]+ revision 1/)
    const index = validateIndexText(await fs.readFile(path.join(root, 'docs/index.json'), 'utf8'))
    const primary = index.docs[index.tasks[String(taskId)]]
    expect(primary.links).toHaveLength(1)
    expect(index.docs[primary.links[0]].primary).toBe(false)
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
    await expect(lintDraft({
      root,
      draft: draft({ link: `doc:${ids[0]}`, additions: `[another note](doc:${ids[1]})` }),
    })).rejects.toThrow(/D07 size/)
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

  it('removes newly created directories after a failed atomic publish', async () => {
    const root = await rootDir()
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
      { path: path.join(root, 'docs/new/a.txt'), content: 'a' },
      { path: path.join(root, 'docs/new/b.txt'), content: 'b' },
    ], { io })).rejects.toThrow('injected rename failure')
    await expect(fs.access(path.join(root, 'docs'))).rejects.toThrow()
  })
})
