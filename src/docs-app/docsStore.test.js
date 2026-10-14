import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCS_LIMITS, docPath, reviewPath } from '../../packages/docs-core/src/index.js'

const { files } = vi.hoisted(() => ({ files: {} }))
vi.mock('../storage/storage.js', () => ({
  read: async (path) => files[path] ?? '',
  write: async (path, content) => { files[path] = content },
  getActiveProvider: () => null,
}))

import { draftKey, loadDrafts, saveDrafts, markRead, validateReviewSet } from './docsStore.js'

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

  describe('Scoped Docs drafts', () => {
    const a = { accountId: 'tenant/alice', sourceId: 'folder/one' }
    const b = { accountId: 'tenant/bob', sourceId: 'folder/one' }
    const c = { accountId: 'tenant/alice', sourceId: 'folder/two' }
    let stored

    beforeEach(() => {
      stored = new Map()
      vi.stubGlobal('localStorage', {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
        removeItem: (key) => stored.delete(key),
      })
    })

    it('isolates identical document IDs across accounts and sources', () => {
      saveDrafts(primaryId, [{ id: 'alice-one' }], a)
      saveDrafts(primaryId, [{ id: 'bob-one' }], b)
      saveDrafts(primaryId, [{ id: 'alice-two' }], c)
      expect(new Set([draftKey(primaryId, a), draftKey(primaryId, b), draftKey(primaryId, c)]).size).toBe(3)
      expect(loadDrafts(primaryId, a)).toEqual([{ id: 'alice-one' }])
      expect(loadDrafts(primaryId, b)).toEqual([{ id: 'bob-one' }])
      expect(loadDrafts(primaryId, c)).toEqual([{ id: 'alice-two' }])
    })

    it('does not attribute legacy consumer drafts to any account or source', () => {
      stored.set(`fp-docs-drafts:${primaryId}`, '[{"id":"legacy"}]')
      for (const scope of [a, b, c]) expect(loadDrafts(primaryId, scope)).toEqual([])
      expect(stored.get(`fp-docs-drafts:${primaryId}`)).toContain('legacy')
    })

    it('refuses missing scope and delimiter collisions', () => {
      expect(() => loadDrafts(primaryId)).toThrow('accountId and sourceId')
      expect(draftKey(primaryId, { accountId: 'a:b', sourceId: 'c' }))
        .not.toBe(draftKey(primaryId, { accountId: 'a', sourceId: 'b:c' }))
    })

    it('reports malformed or inaccessible drafts instead of hiding data loss', () => {
      stored.set(draftKey(primaryId, a), '{}')
      expect(() => loadDrafts(primaryId, a)).toThrow("Couldn't load Docs drafts")
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('Access denied') },
        setItem: () => { throw new Error('Quota exceeded') },
        removeItem: () => { throw new Error('Access denied') },
      })
      expect(() => loadDrafts(primaryId, a)).toThrow('Access denied')
      expect(() => saveDrafts(primaryId, [{}], a)).toThrow('Quota exceeded')
      expect(() => saveDrafts(primaryId, [], a)).toThrow('Access denied')
    })
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
