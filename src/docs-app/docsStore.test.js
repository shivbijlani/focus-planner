import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCS_LIMITS, docPath, reviewPath } from '../../packages/docs-core/src/index.js'

const { files } = vi.hoisted(() => ({ files: {} }))
vi.mock('../storage/storage.js', () => ({
  read: async (path) => files[path] ?? '',
  write: async (path, content) => { files[path] = content },
  getActiveProvider: () => null,
}))

import { markRead, validateReviewSet } from './docsStore.js'

const at = '2026-10-01T12:00:00Z'
const primaryId = 'd-primary001'

function docEntry(id, primary, links = []) {
  return {
    title: primary ? 'Primary' : id,
    ...(primary ? { task: 845 } : {}),
    primary,
    rev: 1,
    updatedAt: at,
    links,
  }
}

function docText(id, title, body) {
  return `<!-- docs v1 id=${id} rev=1 published=${at} by=fp-docs -->\n# ${title}\n\n<!-- @b1 -->\n${body}\n`
}

describe('Docs storage readers', () => {
  beforeEach(() => {
    for (const key of Object.keys(files)) delete files[key]
  })

  it('refuses a task review set larger than the aggregate body limit', async () => {
    const linkedIds = Array.from({ length: 9 }, (_, i) => `d-linked${String(i).padStart(3, '0')}`)
    const docs = { [primaryId]: docEntry(primaryId, true, linkedIds) }
    const texts = {
      [docPath(primaryId)]: docText(primaryId, 'Primary', 'x'.repeat(240_000)),
    }
    for (const id of linkedIds) {
      docs[id] = docEntry(id, false)
      texts[docPath(id)] = docText(id, id, 'x'.repeat(240_000))
    }
    const index = { version: 1, tasks: { '845': primaryId }, docs }
    await expect(validateReviewSet(index, primaryId, async (path) => texts[path]))
      .rejects.toThrow(`D07 size: task review set exceeds ${DOCS_LIMITS.reviewSetBytes} bytes`)
  })

  it('marks each opened revision read without moving readRev backwards', async () => {
    const path = reviewPath(primaryId)
    await markRead(primaryId, 2)
    expect(JSON.parse(files[path]).readRev).toBe(2)
    await markRead(primaryId, 4)
    expect(JSON.parse(files[path]).readRev).toBe(4)
    await markRead(primaryId, 3)
    expect(JSON.parse(files[path]).readRev).toBe(4)
  })
})
