import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OneDriveProvider } from './onedrive-provider.js'

// Regression coverage for task #371: journals silently disappeared from the
// hamburger file tree / journal enumeration / id allocation once the journal
// folder crossed Microsoft Graph's 200-item page limit, because the providers
// read only the first page of `children` and never followed @odata.nextLink.
//
// These tests mock the Graph API with a folder large enough to span multiple
// pages and assert that EVERY file comes back — proving the pagination fix
// (_listAllChildren following @odata.nextLink) works with a lot of files.

const GRAPH_PAGE_SIZE = 200 // Graph default children page size
const TOTAL_JOURNALS = 450 // spans 3 pages (200 + 200 + 50)

/** Build task-<n>.md journal driveItems for n = 1..count. */
function makeJournalItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `task-${i + 1}.md`,
    lastModifiedDateTime: '2026-07-20T00:00:00Z',
    eTag: `etag-${i + 1}`,
  }))
}

/**
 * Return a Graph children response page for `items`, honoring a synthetic
 * `${tokenParam}=<page>` cursor and emitting @odata.nextLink until exhausted.
 * This is exactly the paging shape the real provider must follow.
 */
function pagedResponse(url, items, tokenParam) {
  const m = url.match(new RegExp(`${tokenParam}=(\\d+)`))
  const page = m ? parseInt(m[1], 10) : 0
  const start = page * GRAPH_PAGE_SIZE
  const slice = items.slice(start, start + GRAPH_PAGE_SIZE)
  const hasNext = start + GRAPH_PAGE_SIZE < items.length
  const body = { value: slice }
  if (hasNext) {
    // Strip any existing cursor before appending the next one.
    const base = url.replace(new RegExp(`[?&]${tokenParam}=\\d+`), '')
    const baseSep = base.includes('?') ? '&' : '?'
    body['@odata.nextLink'] = `${base}${baseSep}${tokenParam}=${page + 1}`
  }
  return { ok: true, status: 200, json: async () => body }
}

describe('OneDriveProvider pagination (task #371)', () => {
  let provider
  let journalItems
  let fetchMock

  beforeEach(() => {
    // Node test env has no localStorage; the constructor reads it via _loadTokens.
    const store = new Map()
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    }

    journalItems = makeJournalItems(TOTAL_JOURNALS)

    fetchMock = vi.fn(async (url) => {
      const u = String(url)
      // Root children — a single 'journal' folder (never paginates here).
      if (/approot\/children/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ value: [{ name: 'journal', folder: {} }] }) }
      }
      // journal folder children — the large, multi-page listing.
      if (u.includes('/journal:/children') || u.includes('__jp__')) {
        return pagedResponse(u, journalItems, '__jp__')
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) }
    })
    globalThis.fetch = fetchMock

    provider = new OneDriveProvider()
    // Mark tokens valid so _ensureToken() short-circuits (no OAuth in tests).
    provider._token = 'test-token'
    provider._expiresAt = Date.now() + 3_600_000
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.fetch
    delete globalThis.localStorage
  })

  it('journalIds() returns every id across all pages', async () => {
    const ids = await provider.journalIds()
    expect(ids.size).toBe(TOTAL_JOURNALS)
    // The very files that used to fall off the listing (past page 1 and past page 2).
    expect(ids.has(1)).toBe(true)
    expect(ids.has(201)).toBe(true)
    expect(ids.has(TOTAL_JOURNALS)).toBe(true)
  })

  it('maxJournalId() sees ids beyond the first page (prevents id collisions)', async () => {
    const max = await provider.maxJournalId()
    expect(max).toBe(TOTAL_JOURNALS)
  })

  it('follows @odata.nextLink instead of stopping at the first page', async () => {
    await provider.journalIds()
    const journalCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes('/journal:/children') || String(u).includes('__jp__'),
    )
    // 450 items / 200 per page => 3 fetches. Pre-fix this was exactly 1.
    expect(journalCalls.length).toBe(3)
  })

  it('listFlat() surfaces the journals that feed the hamburger file tree', async () => {
    const entries = await provider.listFlat()
    const journalEntries = entries.filter((e) => e.path.startsWith('journal/'))
    expect(journalEntries.length).toBe(TOTAL_JOURNALS)
    expect(journalEntries.some((e) => e.path === `journal/task-${TOTAL_JOURNALS}.md`)).toBe(true)
  })

  it('getFiles() tree includes all journals under the journal folder', async () => {
    const tree = await provider.getFiles()
    const journalDir = tree.find((n) => n.name === 'journal' && n.type === 'directory')
    expect(journalDir).toBeTruthy()
    expect(journalDir.children.length).toBe(TOTAL_JOURNALS)
  })

  it('still works when the folder fits on a single page (no nextLink)', async () => {
    journalItems = makeJournalItems(5)
    const ids = await provider.journalIds()
    expect(ids.size).toBe(5)
    const journalCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes('/journal:/children') || String(u).includes('__jp__'),
    )
    expect(journalCalls.length).toBe(1)
  })
})
