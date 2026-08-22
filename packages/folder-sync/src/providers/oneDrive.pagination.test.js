import { afterEach, describe, expect, it, vi } from 'vitest'
import { listFolderRecursive } from './oneDrive.js'

// Regression test for task #371: journals past Microsoft Graph's first
// `/children` page were silently dropped, so high-ID journals (e.g.
// task-370/371) never synced into the local mirror and never showed in the
// sidebar. `listFolderRecursive` must follow `@odata.nextLink` across pages.

const APPROOT = 'https://graph.microsoft.com/v1.0/me/drive/special/approot'

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

describe('listFolderRecursive pagination', () => {
  it('follows @odata.nextLink so files past the first page are not dropped', async () => {
    // Root has one file + the journal folder. The journal folder is paginated:
    // page 1 carries an @odata.nextLink; page 2 holds the overflow journals.
    const page2Url = `${APPROOT}:/journal:/children?$select=name,lastModifiedDateTime,file,folder&$skiptoken=PAGE2`

    const fetchMock = vi.fn(async (url) => {
      const u = String(url)
      if (u === `${APPROOT}/children?$select=name,lastModifiedDateTime,file,folder`) {
        return jsonResponse({
          value: [
            { name: 'planner.md', file: {}, lastModifiedDateTime: '2026-01-01T00:00:00Z' },
            { name: 'journal', folder: { childCount: 4 } },
          ],
        })
      }
      if (u === `${APPROOT}:/journal:/children?$select=name,lastModifiedDateTime,file,folder`) {
        return jsonResponse({
          '@odata.nextLink': page2Url,
          value: [
            { name: 'task-1.md', file: {}, lastModifiedDateTime: '2026-01-02T00:00:00Z' },
            { name: 'task-367.md', file: {}, lastModifiedDateTime: '2026-07-01T00:00:00Z' },
          ],
        })
      }
      if (u === page2Url) {
        return jsonResponse({
          value: [
            { name: 'task-370.md', file: {}, lastModifiedDateTime: '2026-07-20T00:00:00Z' },
            { name: 'task-371.md', file: {}, lastModifiedDateTime: '2026-07-22T00:00:00Z' },
          ],
        })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const files = await listFolderRecursive('tok', '')
    const names = files.map(f => f.name).sort()

    expect(names).toEqual([
      'journal/task-1.md',
      'journal/task-367.md',
      'journal/task-370.md',
      'journal/task-371.md',
      'planner.md',
    ])
    // The overflow-page journals — the ones the bug used to hide — are present.
    expect(names).toContain('journal/task-370.md')
    expect(names).toContain('journal/task-371.md')
    // Root + journal page 1 + journal page 2 = 3 requests.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns [] when the app folder does not exist yet (first-page 404)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await listFolderRecursive('tok', '')).toEqual([])
  })
})
