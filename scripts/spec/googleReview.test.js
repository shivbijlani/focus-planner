import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createGoogleReview } from './googleReview.mjs'

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  documentId: 'existing-doc',
  approverEmail: 'reviewer@example.com',
  repo: 'example/planner',
}
const input = {
  revision: 7,
  snapshotSha: 'a'.repeat(40),
  contentHash: 'b'.repeat(64),
  pages: { 'Home.md': '# Home\nExact content 🐸\n', 'Design.md': '# Design\nDetails\n' },
  summary: 'A readable summary 🐸\nOnly this frozen revision is under review.',
  createdAt: '2026-09-14T12:00:00.000Z',
}
const presentedAt = '2026-09-15T01:00:00.000Z'
const publication = {
  revision: 7,
  contentHash: input.contentHash,
  acceptedSha: 'c'.repeat(40),
  wikiSha: 'd'.repeat(40),
  publishedAt: '2026-09-15T02:00:00.000Z',
}
const digest = text => createHash('sha256').update(text).digest('hex')
const ok = body => ({ ok: true, status: 200, json: async () => body })
const failure = status => ({ ok: false, status, json: async () => ({ error: 'sensitive error' }) })

function fixture(options = {}) {
  const state = {
    text: 'Existing human notes\n',
    revisionId: 'docs-revision-1',
    writes: [],
    comments: [{
      id: 'comment-1',
      content: 'Keep my original comment',
      author: { displayName: 'Human', emailAddress: config.approverEmail },
      createdTime: '2026-09-14T10:00:00Z',
      modifiedTime: '2026-09-14T11:00:00Z',
      deleted: false,
      resolved: false,
      replies: [{
        id: 'reply-1',
        content: 'Original reply',
        author: { displayName: 'Other human', emailAddress: 'other@example.com' },
        createdTime: '2026-09-14T10:30:00Z',
        modifiedTime: '2026-09-14T11:30:00Z',
        deleted: false,
        action: 'reopen',
      }],
    }],
  }
  const fetchImpl = vi.fn(async (rawUrl, request) => {
    const url = new URL(rawUrl)
    expect(request.redirect).toBe('error')
    if (url.href === 'https://oauth2.googleapis.com/token') {
      return options.authResponse || ok({ access_token: 'ephemeral-token', token_type: 'Bearer' })
    }
    expect(request.headers.Authorization).toBe('Bearer ephemeral-token')
    if (url.hostname === 'www.googleapis.com') {
      expect(url.pathname).toBe('/drive/v3/files/existing-doc/comments')
      expect(request.method).toBeUndefined()
      return options.commentResponse
        ? options.commentResponse(url)
        : ok({ comments: state.comments })
    }
    expect(url.hostname).toBe('docs.googleapis.com')
    if (request.method === 'POST') {
      expect(url.pathname).toBe('/v1/documents/existing-doc:batchUpdate')
      const batch = JSON.parse(request.body)
      state.writes.push(batch)
      if (options.conflict) return failure(400)
      expect(batch.writeControl).toEqual({ requiredRevisionId: state.revisionId })
      const [insertion, ...formatting] = batch.requests
      if (insertion.replaceAllText) {
        if (options.receiptFailure) return failure(503)
        const replacement = insertion.replaceAllText
        expect(batch.requests).toHaveLength(1)
        expect(replacement.containsText).toEqual({ text: '[Wiki review 7 presentation pending]', matchCase: true })
        expect(replacement.tabsCriteria).toEqual(options.tabId ? { tabIds: [options.tabId] } : undefined)
        if (!options.dropReceipt) state.text = state.text.replace(replacement.containsText.text, replacement.replaceText)
        state.revisionId = 'docs-revision-3'
        if (options.receiptResponseLost) throw new Error('Connection lost after receipt persisted')
        return ok({ documentId: config.documentId, replies: [{ replaceAllText: { occurrencesChanged: 1 } }] })
      }
      const { index, tabId } = insertion.insertText.location
      expect(tabId).toBe(options.tabId)
      expect(index).toBe(state.text.length)
      const previousText = state.text
      const isPublication = insertion.insertText.text.includes('[Wiki publication 7]')
      state.text = state.text.slice(0, index - 1) + insertion.insertText.text + state.text.slice(index - 1)
      for (const operation of formatting) {
        const { range, textStyle, fields } = operation.updateTextStyle
        expect(range.tabId).toBe(options.tabId)
        expect(fields).toBe('link')
        const label = state.text.slice(range.startIndex - 1, range.endIndex - 1)
        if (isPublication) {
          expect([
            `https://github.com/${config.repo}/commit/${publication.acceptedSha}`,
            `https://github.com/${config.repo}/wiki`,
          ]).toContain(label)
          expect(textStyle.link.url).toBe(label)
        } else {
          expect(Object.keys(input.pages)).toContain(label)
          expect(textStyle.link.url).toBe(`https://github.com/${config.repo}/blob/${input.snapshotSha}/pages/${label}`)
        }
      }
      state.revisionId = `docs-revision-${state.writes.length + 1}`
      if (options.dropWrite) state.text = 'Existing human notes\n'
      if (isPublication && options.dropPublication) state.text = previousText
      if (isPublication && options.publicationResponseLost) throw new Error('Publication response lost')
      return ok({ documentId: config.documentId, replies: [] })
    }
    expect(url.pathname).toBe('/v1/documents/existing-doc')
    expect(url.searchParams.get('includeTabsContent')).toBe('true')
    expect(url.searchParams.get('suggestionsViewMode')).toBe('PREVIEW_WITHOUT_SUGGESTIONS')
    if (options.documentResponse) return options.documentResponse(state)
    const body = {
      content: [
        { endIndex: 1, sectionBreak: {} },
        { startIndex: 1, endIndex: state.text.length + 1, paragraph: { elements: [{ textRun: { content: state.text } }] } },
      ],
    }
    return ok({
      documentId: config.documentId,
      revisionId: state.revisionId,
      ...(options.tabId ? { tabs: [{ tabProperties: { tabId: options.tabId }, documentTab: { body } }] } : { body }),
    })
  })
  const adapter = createGoogleReview({ ...config, fetchImpl, now: options.now || (() => new Date(presentedAt)) })
  return { adapter, state, fetchImpl }
}

describe('recordPublication', () => {
  it.each([undefined, 'tab-primary'])('appends a publication outcome outside the frozen review with clickable evidence (tab %s)', async tabId => {
    const { adapter, state } = fixture({ tabId })
    const review = await adapter.present(input)
    const previousText = state.text
    const originalComments = structuredClone(state.comments)
    const result = await adapter.recordPublication(publication)
    expect(result).toEqual({
      publishedAt: publication.publishedAt,
      publicationTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(state.text).toContain(previousText.trimEnd())
    expect(state.text.indexOf('[Wiki publication 7]')).toBeGreaterThan(state.text.indexOf('[Wiki review 7 end]'))
    expect(state.text).toContain('Wiki revision 7 — published')
    expect(state.text).toContain('Outcome: Published successfully; remote wiki bytes verified by the publication controller.')
    expect(state.text).toContain(`Accepted commit: ${publication.acceptedSha}`)
    expect(state.text).toContain(`Wiki commit: ${publication.wikiSha}`)
    expect(state.text).toContain(`Published at: ${publication.publishedAt}`)
    expect(state.comments).toEqual(originalComments)
    expect(state.writes).toHaveLength(3)
    expect(state.writes[2].requests).toHaveLength(3)
    expect(state.writes[2].writeControl).toEqual({ requiredRevisionId: 'docs-revision-3' })
    expect(await adapter.verifyReview({ revision: 7, reviewTextHash: review.reviewTextHash })).toBe(true)
  })

  it('is idempotent with identical values after state-save failure and unrelated human notes', async () => {
    const { adapter, state, fetchImpl } = fixture()
    const review = await adapter.present(input)
    const first = await adapter.recordPublication(publication)
    state.text += 'New human notes\n'
    const restarted = createGoogleReview({ ...config, fetchImpl })
    expect(await restarted.recordPublication({ ...publication })).toEqual(first)
    expect(state.writes).toHaveLength(3)
    expect(state.text.match(/\[Wiki publication 7\]/g)).toHaveLength(1)
    expect(await restarted.verifyReview({ revision: 7, reviewTextHash: review.reviewTextHash })).toBe(true)
  })

  it('recovers a completed publication append even if its response was lost', async () => {
    const { adapter, state } = fixture({ publicationResponseLost: true })
    await adapter.present(input)
    await expect(adapter.recordPublication(publication)).rejects.toThrow('publication append request failed')
    const recovered = await adapter.recordPublication(publication)
    expect(recovered.publishedAt).toBe(publication.publishedAt)
    expect(state.writes).toHaveLength(3)
  })

  it.each([
    { acceptedSha: 'e'.repeat(40) },
    { wikiSha: 'e'.repeat(40) },
    { publishedAt: '2026-09-15T03:00:00.000Z' },
  ])('rejects changed expected publication values instead of appending twice', async change => {
    const { adapter, state } = fixture()
    await adapter.present(input)
    await adapter.recordPublication(publication)
    await expect(adapter.recordPublication({ ...publication, ...change })).rejects.toThrow('receipt differs')
    expect(state.writes).toHaveLength(3)
  })

  it('rejects a publication digest differing from its frozen review', async () => {
    const { adapter, state } = fixture()
    await adapter.present(input)
    await expect(adapter.recordPublication({ ...publication, contentHash: 'e'.repeat(64) })).rejects.toThrow('digest differs')
    expect(state.writes).toHaveLength(2)
  })

  it('requires its completed frozen review before recording publication', async () => {
    const { adapter, state } = fixture()
    await expect(adapter.recordPublication(publication)).rejects.toThrow('without its frozen review')
    expect(state.writes).toHaveLength(0)
  })

  it('does not append inside any incomplete review', async () => {
    const { adapter, state } = fixture()
    await adapter.present(input)
    state.text += '[Wiki review 8 start]\n'
    await expect(adapter.recordPublication(publication)).rejects.toThrow('inside an incomplete frozen review')
    expect(state.writes).toHaveLength(2)
  })

  it('does not accept a publication receipt moved inside a frozen review', async () => {
    const { adapter, state } = fixture()
    await adapter.present(input)
    await adapter.recordPublication(publication)
    state.text = state.text.replace('[Wiki publication 7]', '[Wiki review 8 start]\n[Wiki publication 7]') + '[Wiki review 8 end]\n'
    await expect(adapter.recordPublication(publication)).rejects.toThrow('inside an incomplete frozen review')
    expect(state.writes).toHaveLength(3)
  })

  it.each([
    '[Wiki publication 7]',
    '[Wiki publication 7 end]',
    '[Wiki publication 7]\n[Wiki publication 7]\n[Wiki publication 7 end]',
  ])('fails closed on incomplete or duplicate publication markers', async extra => {
    const { adapter, state } = fixture()
    await adapter.present(input)
    state.text += `${extra}\n`
    await expect(adapter.recordPublication(publication)).rejects.toThrow('publication markers')
    expect(state.writes).toHaveLength(2)
  })

  it('detects tampering anywhere within the existing publication receipt', async () => {
    const { adapter, state } = fixture()
    await adapter.present(input)
    await adapter.recordPublication(publication)
    state.text = state.text.replace('Published successfully', 'Publication failed')
    await expect(adapter.recordPublication(publication)).rejects.toThrow('receipt differs')
    expect(state.writes).toHaveLength(3)
  })

  it('requires append readback evidence', async () => {
    const { adapter } = fixture({ dropPublication: true })
    await adapter.present(input)
    await expect(adapter.recordPublication(publication)).rejects.toThrow('publication append verification failed')
  })

  it('does not retry a publication write when the Docs revision precondition fails', async () => {
    const options = {}
    const { adapter, state } = fixture(options)
    const review = await adapter.present(input)
    const previousText = state.text
    options.conflict = true
    await expect(adapter.recordPublication(publication)).rejects.toThrow('HTTP 400')
    expect(state.text).toBe(previousText)
    expect(state.writes).toHaveLength(3)
    expect(await adapter.verifyReview({ revision: 7, reviewTextHash: review.reviewTextHash })).toBe(true)
  })

  it.each([
    { revision: -1 },
    { contentHash: 'not-a-digest' },
    { acceptedSha: 'main' },
    { wikiSha: 'abc123' },
    { publishedAt: 'not-a-date' },
    { publishedAt: null },
  ])('validates receipt input before network calls', async change => {
    const { adapter, fetchImpl } = fixture()
    await expect(adapter.recordPublication({ ...publication, ...change })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('Google review configuration and OAuth', () => {
  it.each(Object.keys(config))('requires a nonempty %s', key => {
    expect(() => createGoogleReview({ ...config, [key]: ' ' })).toThrow(`${key} is required`)
  })

  it.each([
    ['documentId', 'https://docs.google.com/document/d/id/edit'],
    ['repo', 'owner/repo/extra'],
    ['repo', '../repo'],
    ['approverEmail', 'not-an-email'],
  ])('rejects unsafe %s configuration', (key, value) => {
    expect(() => createGoogleReview({ ...config, [key]: value })).toThrow()
  })

  it('refreshes only at the fixed Google endpoint and never writes credentials to Docs', async () => {
    const { adapter, fetchImpl } = fixture()
    await adapter.present(input)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
    })
    const apiCalls = fetchImpl.mock.calls.slice(1)
    expect(apiCalls.every(([, request]) => !request.body?.includes(config.clientSecret))).toBe(true)
    expect(apiCalls.every(([endpoint]) => !endpoint.includes('ephemeral-token'))).toBe(true)
  })

  it.each([
    failure(401),
    ok({}),
    ok({ access_token: ' ', token_type: 'Bearer' }),
    ok({ access_token: 'token', token_type: 'other' }),
    ok({ error: { message: 'secret' } }),
    { ok: true, json: async () => { throw new Error('refresh') } },
  ])('fails closed on an unusable OAuth response', async authResponse => {
    const { adapter, fetchImpl } = fixture({ authResponse })
    await expect(adapter.read()).rejects.toThrow('Google OAuth refresh')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not expose credential-bearing fetch failures', async () => {
    const adapter = createGoogleReview({
      ...config,
      fetchImpl: async () => { throw new Error(`${config.clientSecret} ${config.refreshToken}`) },
    })
    await expect(adapter.read()).rejects.toThrow('Google OAuth refresh request failed')
  })
})

describe('read', () => {
  it('returns the document revision and all paginated comments with untouched replies and author metadata', async () => {
    const second = { id: 'comment-2', content: 'Another comment', deleted: true, replies: [] }
    const { adapter, state, fetchImpl } = fixture({
      commentResponse: url => url.searchParams.has('pageToken')
        ? ok({ comments: [second] })
        : ok({ comments: state.comments, nextPageToken: 'opaque + / page' }),
    })
    const result = await adapter.read()
    expect(result).toEqual({
      revisionId: 'docs-revision-1',
      text: 'Existing human notes\n',
      comments: [...state.comments, second],
    })
    const calls = fetchImpl.mock.calls.filter(([url]) => url.includes('/comments'))
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1][0]).searchParams.get('pageToken')).toBe('opaque + / page')
    expect(new URL(calls[0][0]).searchParams.get('fields')).toBe('nextPageToken,comments(*)')
    expect(new URL(calls[0][0]).searchParams.get('includeDeleted')).toBe('true')
  })

  it('concatenates paragraph runs, nested table cells and table of contents text in order', async () => {
    const paragraph = (...runs) => ({ paragraph: { elements: runs.map(content => ({ textRun: { content } })) } })
    const table = content => ({ table: { tableRows: [{ tableCells: [{ content }] }] } })
    const { adapter } = fixture({
      documentResponse: () => ok({
        documentId: config.documentId,
        revisionId: 'r1',
        body: {
          content: [
            paragraph('First ', 'line\n'),
            table([paragraph('Cell\n'), table([paragraph('Nested\n')])]),
            { tableOfContents: { content: [paragraph('Contents\n')] } },
            paragraph('Last\n'),
          ],
        },
      }),
    })
    expect((await adapter.read()).text).toBe('First line\nCell\nNested\nContents\nLast\n')
  })

  it('includes child tab bodies without dropping other tabs', async () => {
    const tab = (tabId, text, childTabs = []) => ({
      tabProperties: { tabId },
      documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] } },
      childTabs,
    })
    const { adapter } = fixture({
      documentResponse: () => ok({
        documentId: config.documentId,
        revisionId: 'r1',
        tabs: [tab('first', 'A\n', [tab('child', 'B\n')]), tab('second', 'C\n')],
      }),
    })
    expect((await adapter.read()).text).toBe('A\nB\nC\n')
  })

  it.each([
    {},
    { comments: null },
    { comments: [], nextPageToken: '' },
    { comments: [], nextPageToken: 42 },
    { comments: [], incompleteSearch: true },
    { comments: [{ content: 'Missing ID' }] },
    { comments: [{ id: 'id', replies: {} }] },
  ])('rejects malformed or incomplete comments', async response => {
    const { adapter } = fixture({ commentResponse: () => ok(response) })
    await expect(adapter.read()).rejects.toThrow()
  })

  it('rejects a repeated pagination token instead of silently truncating', async () => {
    const { adapter } = fixture({ commentResponse: () => ok({ comments: [], nextPageToken: 'cycle' }) })
    await expect(adapter.read()).rejects.toThrow('repeated')
  })

  it('fails rather than returning partial comments when a later page fails', async () => {
    const { adapter } = fixture({
      commentResponse: url => url.searchParams.has('pageToken')
        ? failure(403)
        : ok({ comments: [{ id: 'first' }], nextPageToken: 'next' }),
    })
    await expect(adapter.read()).rejects.toThrow('HTTP 403')
  })

  it.each([
    {},
    { documentId: 'wrong-document', revisionId: 'r', body: { content: [] } },
    { documentId: config.documentId, body: { content: [] } },
    { documentId: config.documentId, revisionId: 'r', body: {} },
    { documentId: config.documentId, revisionId: 'r', tabs: [] },
    { documentId: config.documentId, revisionId: 'r', body: { content: [{ table: {} }] } },
  ])('rejects incomplete or wrong document responses', async response => {
    const { adapter } = fixture({ documentResponse: () => ok(response) })
    await expect(adapter.read()).rejects.toThrow()
  })
})

describe('present and verifyReview', () => {
  it.each([undefined, 'tab-primary'])('appends and verifies a linked, readable review without destroying human content (tab %s)', async tabId => {
    const { adapter, state, fetchImpl } = fixture({ tabId })
    const originalComments = structuredClone(state.comments)
    const result = await adapter.present(input)
    expect(result).toEqual({
      presentedAt,
      reviewTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      approvalText: 'Approve wiki revision 7',
    })
    expect(state.text).toMatch(/^Existing human notes/)
    expect(state.text).toContain('[Wiki review 7 start]')
    expect(state.text).toContain('[Wiki review 7 end]')
    expect(state.text).toContain('Wiki revision 7 — approval review')
    expect(state.text).toContain(input.summary)
    expect(state.text).toContain(`Snapshot digest (SHA-256): ${input.contentHash}`)
    expect(state.text).toContain(`Page SHA-256: ${digest(input.pages['Home.md'])}`)
    expect(state.text).toContain('No unseen versions, later edits, or future revisions are approved.')
    expect(state.text.indexOf('Design.md')).toBeLessThan(state.text.indexOf('Home.md'))
    expect(state.comments).toEqual(originalComments)
    expect(state.writes).toHaveLength(2)
    expect(state.writes[0].requests).toHaveLength(3)
    expect(state.writes[1].writeControl).toEqual({ requiredRevisionId: 'docs-revision-2' })
    expect(state.text).toContain(`[Wiki review 7 presented at ${presentedAt}]`)
    expect(state.text).not.toContain('[Wiki review 7 presentation pending]')
    expect(await adapter.verifyReview({ revision: 7, reviewTextHash: result.reviewTextHash })).toBe(true)
    const apiWrites = fetchImpl.mock.calls.filter(([, request]) => request.method === 'POST')
    expect(apiWrites.every(([url]) => url.endsWith('/token') || url.endsWith('existing-doc:batchUpdate'))).toBe(true)
  })

  it('is exactly idempotent even after a controller restart or unrelated human edits', async () => {
    const { adapter, state, fetchImpl } = fixture()
    const first = await adapter.present(input)
    state.text += 'An unrelated human note\n'
    const restartTime = '2026-09-15T02:00:00.000Z'
    const restarted = createGoogleReview({ ...config, fetchImpl, now: () => new Date(restartTime) })
    const second = await restarted.present({ ...input, pages: { 'Design.md': input.pages['Design.md'], 'Home.md': input.pages['Home.md'] } })
    expect(second).toEqual(first)
    expect(state.writes).toHaveLength(2)
    expect(state.text.match(/\[Wiki review 7 start\]/g)).toHaveLength(1)
    expect(await restarted.verifyReview({ revision: 7, reviewTextHash: first.reviewTextHash })).toBe(true)
  })

  it.each([
    { summary: 'A different summary' },
    { contentHash: 'c'.repeat(64) },
    { snapshotSha: 'c'.repeat(40) },
    { pages: { 'Home.md': 'Different exact bytes\n' } },
    { createdAt: '2026-09-14T13:00:00.000Z' },
  ])('rejects an existing revision whose expected presentation changed', async change => {
    const { adapter, state } = fixture()
    await adapter.present(input)
    await expect(adapter.present({ ...input, ...change })).rejects.toThrow('differs')
    expect(state.writes).toHaveLength(2)
  })

  it('does not replace a conflicting revision or retry an unguarded write', async () => {
    const { adapter, state } = fixture({ conflict: true })
    await expect(adapter.present(input)).rejects.toThrow('HTTP 400')
    expect(state.text).toBe('Existing human notes\n')
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0].writeControl.requiredRevisionId).toBe('docs-revision-1')
  })

  it('requires readback proof rather than trusting an acknowledged but missing write', async () => {
    const { adapter } = fixture({ dropWrite: true })
    await expect(adapter.present(input)).rejects.toThrow('append verification failed')
  })

  it('rejects tampered review text and never overwrites it', async () => {
    const { adapter, state } = fixture()
    const result = await adapter.present(input)
    state.text = state.text.replace('A readable summary', 'An altered summary')
    await expect(adapter.verifyReview({ revision: 7, reviewTextHash: result.reviewTextHash })).rejects.toThrow('checksum')
    await expect(adapter.present(input)).rejects.toThrow('differs')
    expect(state.writes).toHaveLength(2)
  })

  it('throws for missing reviews or mismatched hashes so callers cannot ignore false', async () => {
    const { adapter } = fixture()
    await expect(adapter.verifyReview({ revision: 7, reviewTextHash: 'd'.repeat(64) })).rejects.toThrow('checksum')
    await adapter.present(input)
    await expect(adapter.verifyReview({ revision: 7, reviewTextHash: 'd'.repeat(64) })).rejects.toThrow('checksum')
  })

  it('recovers the original cutoff after a completed receipt response was lost, without excluding a later approval', async () => {
    const { adapter, state, fetchImpl } = fixture({ receiptResponseLost: true })
    await expect(adapter.present(input)).rejects.toThrow('presentation receipt request failed')
    state.comments.push({
      id: 'approval-after-presentation',
      content: 'Approve wiki revision 7',
      createdTime: '2026-09-15T01:01:00.000Z',
      author: { emailAddress: config.approverEmail },
    })
    const restarted = createGoogleReview({
      ...config, fetchImpl,
      now: () => { throw new Error('A retry must not invent a new timestamp') },
    })
    const result = await restarted.present(input)
    expect(result.presentedAt).toBe(presentedAt)
    expect(Date.parse(result.presentedAt)).toBeLessThan(Date.parse(state.comments.at(-1).createdTime))
    expect(Date.parse(result.presentedAt)).toBeGreaterThan(Date.parse(state.comments[0].createdTime))
    expect(state.writes).toHaveLength(2)
    expect(await restarted.verifyReview({ revision: 7, reviewTextHash: result.reviewTextHash })).toBe(true)
  })

  it('chooses the timestamp only after the complete preview was read back', async () => {
    const now = vi.fn(() => {
      expect(state.text).toContain('[Wiki review 7 end]')
      expect(state.text).toContain('[Wiki review 7 presentation pending]')
      expect(state.writes).toHaveLength(1)
      expect(fetchImpl.mock.calls.at(-1)[0]).toContain('includeTabsContent=true')
      return new Date(presentedAt)
    })
    const { adapter, state, fetchImpl } = fixture({ now })
    await adapter.present(input)
    expect(now).toHaveBeenCalledTimes(1)
  })

  it('recovers an exact pending preview with a new post-readback floor that excludes earlier approvals', async () => {
    const options = { receiptFailure: true }
    const { adapter, state, fetchImpl } = fixture(options)
    await expect(adapter.present(input)).rejects.toThrow('HTTP 503')
    expect(state.text).toContain('[Wiki review 7 presentation pending]')
    const pendingSpan = state.text.slice(state.text.indexOf('[Wiki review 7 start]'), state.text.indexOf('[Wiki review 7 end]') + '[Wiki review 7 end]'.length)
    await expect(adapter.verifyReview({ revision: 7, reviewTextHash: digest(pendingSpan) })).rejects.toThrow('completed presentation receipt')
    state.comments.push({
      id: 'approval-before-recovery',
      content: 'Approve wiki revision 7',
      createdTime: '2026-09-15T01:01:00.000Z',
      author: { emailAddress: config.approverEmail },
    })
    options.receiptFailure = false
    const recoveryTime = '2026-09-16T00:00:00.000Z'
    const now = vi.fn(() => {
      expect(state.text).toContain(pendingSpan)
      expect(fetchImpl.mock.calls.at(-1)[0]).toContain('includeTabsContent=true')
      expect(state.writes).toHaveLength(2)
      return new Date(recoveryTime)
    })
    const restarted = createGoogleReview({ ...config, fetchImpl, now })
    const result = await restarted.present(input)
    expect(result.presentedAt).toBe(recoveryTime)
    expect(Date.parse(state.comments.at(-1).createdTime)).toBeLessThan(Date.parse(result.presentedAt))
    expect(state.text.match(/\[Wiki review 7 start\]/g)).toHaveLength(1)
    expect(state.writes).toHaveLength(3)
    expect(state.writes[2].requests[0]).toHaveProperty('replaceAllText')
    expect(await restarted.verifyReview({ revision: 7, reviewTextHash: result.reviewTextHash })).toBe(true)
    expect(await restarted.present(input)).toEqual(result)
    expect(now).toHaveBeenCalledTimes(1)
    expect(state.writes).toHaveLength(3)
  })

  it('never recovers a pending preview whose exact content changed', async () => {
    const options = { receiptFailure: true }
    const { adapter, state } = fixture(options)
    await expect(adapter.present(input)).rejects.toThrow('HTTP 503')
    options.receiptFailure = false
    state.text = state.text.replace('A readable summary', 'An altered summary')
    await expect(adapter.present(input)).rejects.toThrow('completed presentation receipt')
    expect(state.text).toContain('An altered summary')
    expect(state.text).toContain('[Wiki review 7 presentation pending]')
    expect(state.writes).toHaveLength(2)
  })

  it('requires receipt readback rather than trusting a successful response', async () => {
    const { adapter } = fixture({ dropReceipt: true })
    await expect(adapter.present(input)).rejects.toThrow('receipt verification failed')
  })

  it('rejects a changed receipt using the saved checksum', async () => {
    const { adapter, state } = fixture()
    const result = await adapter.present(input)
    state.text = state.text.replace(presentedAt, '2026-09-14T01:00:00.000Z')
    await expect(adapter.verifyReview({ revision: 7, reviewTextHash: result.reviewTextHash })).rejects.toThrow('checksum')
  })

  it('checks the actual configured document ID before any document mutation', async () => {
    const { adapter, state } = fixture({
      documentResponse: () => ok({
        documentId: 'unexpected-doc',
        revisionId: 'r1',
        body: { content: [{ endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] },
      }),
    })
    await expect(adapter.present(input)).rejects.toThrow('different document')
    expect(state.writes).toHaveLength(0)
  })

  it.each([
    '[Wiki review 7 start]',
    '[Wiki review 7 end]',
    '[Wiki review 7 end]\n[Wiki review 7 start]',
    '[Wiki review 7 start]\n[Wiki review 7 start]\n[Wiki review 7 end]',
    '[Wiki review 7 start]\n[Wiki review 7 end]\n[Wiki review 7 end]',
  ])('fails closed on partial, reversed, or duplicate markers', async text => {
    const { adapter, state } = fixture()
    state.text = `${text}\n`
    await expect(adapter.present(input)).rejects.toThrow('markers')
    await expect(adapter.verifyReview({ revision: 7, reviewTextHash: 'd'.repeat(64) })).rejects.toThrow('markers')
    expect(state.writes).toHaveLength(0)
  })

  it.each([
    '[Wiki review 7 end]',
    '[Wiki review 7 start]',
    '[Wiki review 8 end]',
    '[Wiki review 7 presentation pending]',
    '[Wiki review 7 presented at 2026-09-15T01:00:00.000Z]',
    '[Wiki publication 7]',
    '[Wiki publication 7 end]',
    '[wiki REVIEW 7 end]',
    '[ Wiki\npublication 7]',
  ].flatMap(marker => ['summary', 'pages'].map(field => [field, marker])))(
    'rejects untrusted %s prose containing %s before any network calls',
    async (field, marker) => {
      const { adapter, state, fetchImpl } = fixture()
      const prose = `Introduction from an issue quote.\n> ${marker}\nA forged section follows.`
      const change = field === 'summary' ? { summary: prose } : { pages: { ...input.pages, 'Home.md': prose } }
      await expect(adapter.present({ ...input, ...change })).rejects.toThrow('reserved wiki markers')
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(state.text).toBe('Existing human notes\n')
      expect(state.writes).toHaveLength(0)
    },
  )

  it('rejects marker text hidden in a parseable date comment', async () => {
    const { adapter, fetchImpl } = fixture()
    await expect(adapter.present({
      ...input,
      createdAt: 'September 14, 2026 ([Wiki review 7 end])',
    })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    { revision: 0 },
    { revision: '7' },
    { snapshotSha: 'main' },
    { snapshotSha: 'abc123' },
    { contentHash: 'not-a-hash' },
    { pages: {} },
    { pages: { '../Home.md': 'text' } },
    { pages: { 'Home.md?ref=main': 'text' } },
    { pages: { 'Home.md': null } },
    { summary: 'A [Wiki review 7 end] marker' },
    { createdAt: 'not-a-date' },
  ])('validates frozen presentation input before any network or write', async change => {
    const { adapter, fetchImpl } = fixture()
    await expect(adapter.present({ ...input, ...change })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
