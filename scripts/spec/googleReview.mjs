import { createHash } from 'node:crypto'

const docsRoot = 'https://docs.googleapis.com/v1/documents/'
const driveRoot = 'https://www.googleapis.com/drive/v3/files/'
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
}

function rejectReservedMarkers(text, name) {
  if (/\[\s*Wiki\s+(?:review|publication)\b/i.test(text)) {
    throw new Error(`${name} contains reserved wiki markers`)
  }
}

function markers(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid wiki revision')
  return [`[Wiki review ${revision} start]`, `[Wiki review ${revision} end]`]
}

function markedSpan(text, start, end, label) {
  const from = text.indexOf(start)
  const to = text.indexOf(end)
  if (from === -1 && to === -1) return null
  if (from === -1 || to < from || text.indexOf(start, from + start.length) !== -1 ||
      text.indexOf(end, to + end.length) !== -1) {
    throw new Error(`Ambiguous or incomplete ${label} markers`)
  }
  return text.slice(from, to + end.length)
}

function reviewSpan(text, revision) {
  return markedSpan(text, ...markers(revision), 'wiki review')
}

function publicationSpan(text, revision) {
  return markedSpan(text, `[Wiki publication ${revision}]`, `[Wiki publication ${revision} end]`, 'wiki publication')
}

function assertOutsideReviews(text, position) {
  const open = new Set()
  for (const match of text.slice(0, position).matchAll(/\[Wiki review (\d+) (start|end)\]/g)) {
    if (match[2] === 'start' && !open.has(match[1])) open.add(match[1])
    else if (match[2] === 'end' && open.has(match[1])) open.delete(match[1])
    else throw new Error('Ambiguous frozen review markers around publication')
  }
  if (open.size) throw new Error('Cannot record publication inside an incomplete frozen review')
}

function documentText(content) {
  if (!Array.isArray(content)) throw new Error('Incomplete Google document content')
  return content.map(element => {
    if (element.paragraph) {
      if (!Array.isArray(element.paragraph.elements)) throw new Error('Incomplete Google paragraph')
      return element.paragraph.elements.map(run => {
        if (!run.textRun) return ''
        if (typeof run.textRun.content !== 'string') throw new Error('Incomplete Google text run')
        return run.textRun.content
      }).join('')
    }
    if (element.table) {
      if (!Array.isArray(element.table.tableRows)) throw new Error('Incomplete Google table')
      return element.table.tableRows.map(row => {
        if (!Array.isArray(row.tableCells)) throw new Error('Incomplete Google table row')
        return row.tableCells.map(cell => documentText(cell.content)).join('')
      }).join('')
    }
    if (element.tableOfContents) return documentText(element.tableOfContents.content)
    return ''
  }).join('')
}

function documentBodies(document) {
  if (document.tabs !== undefined) {
    if (!Array.isArray(document.tabs) || !document.tabs.length) throw new Error('Incomplete Google tabs')
    const bodies = []
    const visit = tabs => {
      for (const tab of tabs) {
        const tabId = tab.tabProperties?.tabId
        if (!tab.documentTab?.body || typeof tabId !== 'string' || !tabId) {
          throw new Error('Incomplete Google document tab')
        }
        bodies.push({ body: tab.documentTab.body, tabId })
        if (tab.childTabs !== undefined) {
          if (!Array.isArray(tab.childTabs)) throw new Error('Incomplete Google child tabs')
          visit(tab.childTabs)
        }
      }
    }
    visit(document.tabs)
    return bodies
  }
  if (!document.body) throw new Error('Missing Google document body')
  return [{ body: document.body }]
}

function presentationMarker(revision, presentedAt) {
  return presentedAt
    ? `[Wiki review ${revision} presented at ${presentedAt}]`
    : `[Wiki review ${revision} presentation pending]`
}

function recoverPresentationTime(text, revision) {
  const pattern = new RegExp(`\\[Wiki review ${revision} presented at ([^\\]]+)\\]`, 'g')
  const matches = [...text.matchAll(pattern)]
  if (matches.length !== 1) throw new Error('Wiki review has no unique completed presentation receipt')
  const value = matches[0][1]
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error('Invalid wiki review presentation receipt')
  }
  return value
}

function buildReview({ revision, snapshotSha, contentHash, pages, summary, createdAt }, repo, approverEmail, presentedAt) {
  const [start, end] = markers(revision)
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(snapshotSha)) throw new Error('Snapshot must be a full commit SHA')
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Invalid snapshot content digest')
  requireString(summary, 'summary')
  rejectReservedMarkers(summary, 'Summary')
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid creation time')
  rejectReservedMarkers(createdAt, 'Creation time')
  if (!pages || typeof pages !== 'object' || Array.isArray(pages) || !Object.keys(pages).length) {
    throw new Error('Review pages are required')
  }
  const filenames = Object.keys(pages).sort()
  for (const filename of filenames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(filename) || filename.includes('..') ||
        typeof pages[filename] !== 'string') throw new Error('Invalid review page')
    rejectReservedMarkers(pages[filename], `Page ${filename}`)
  }
  const approvalText = `Approve wiki revision ${revision}`
  let text = [
    start,
    `Wiki revision ${revision} — approval review`,
    `Prepared: ${createdAt}`,
    presentationMarker(revision, presentedAt),
    'Do not approve a pending presentation. Wait for its presented-at timestamp.',
    '',
    'Summary',
    summary,
    '',
    'Full page previews (review every page before approving)',
    '',
  ].join('\n')
  const links = []
  for (const filename of filenames) {
    const url = `https://github.com/${repo}/blob/${snapshotSha}/pages/${filename}`
    text += '• '
    const offset = text.length
    text += filename
    links.push({ offset, length: filename.length, url })
    text += `\n  ${url}\n  Page SHA-256: ${hash(pages[filename])}\n`
  }
  text += [
    '',
    `Snapshot commit: ${snapshotSha}`,
    `Snapshot digest (SHA-256): ${contentHash}`,
    '',
    `Approval: ${approverEmail} must add a Google Doc comment containing exactly:`,
    approvalText,
    '',
    'Scope: Approval covers only this frozen snapshot and the full page previews listed above.',
    'No unseen versions, later edits, or future revisions are approved.',
    end,
  ].join('\n')
  return { text, links, approvalText }
}

function buildPublication({ revision, contentHash, acceptedSha, wikiSha, publishedAt }, repo) {
  markers(revision)
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Invalid publication content digest')
  for (const sha of [acceptedSha, wikiSha]) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) throw new Error('Publication requires full commit SHAs')
  }
  const date = new Date(publishedAt)
  if (typeof publishedAt !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== publishedAt) {
    throw new Error('Invalid publication time')
  }
  const text = [
    `[Wiki publication ${revision}]`,
    `Wiki revision ${revision} — published`,
    `Published at: ${publishedAt}`,
    'Outcome: Published successfully; remote wiki bytes verified by the publication controller.',
    `Snapshot digest (SHA-256): ${contentHash}`,
    `Accepted commit: ${acceptedSha}`,
    `Wiki commit: ${wikiSha}`,
    `Accepted commit link: https://github.com/${repo}/commit/${acceptedSha}`,
    `Published wiki: https://github.com/${repo}/wiki`,
    'This receipt records the publication outcome; the frozen approval review is unchanged.',
    `[Wiki publication ${revision} end]`,
  ].join('\n')
  const urls = [`https://github.com/${repo}/commit/${acceptedSha}`, `https://github.com/${repo}/wiki`]
  return { text, links: urls.map(url => ({ offset: text.indexOf(url), length: url.length, url })) }
}

/**
 * A pre-bound Google Doc review surface. Credentials stay in memory; comment
 * authorship and approval policy are deliberately the controller's responsibility.
 */
export function createGoogleReview({
  clientId, clientSecret, refreshToken, documentId, approverEmail, repo,
  fetchImpl = fetch, now = () => new Date(),
}) {
  for (const [name, value] of Object.entries({ clientId, clientSecret, refreshToken, documentId, approverEmail, repo })) {
    requireString(value, name)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(documentId)) throw new Error('Invalid Google document ID')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(approverEmail)) throw new Error('Invalid approver email')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid repository')
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new Error('Invalid adapter dependencies')
  const documentUrl = `${docsRoot}${encodeURIComponent(documentId)}`

  async function request(url, options, label) {
    let response
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error' })
    } catch {
      throw new Error(`${label} request failed`)
    }
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`)
    let result
    try {
      result = await response.json()
    } catch {
      throw new Error(`${label} returned invalid JSON`)
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) {
      throw new Error(`${label} returned an invalid response`)
    }
    return result
  }

  async function authorize() {
    const result = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
    }, 'Google OAuth refresh')
    if (typeof result.access_token !== 'string' || !result.access_token.trim() ||
        (result.token_type && result.token_type.toLowerCase() !== 'bearer')) {
      throw new Error('Google OAuth refresh returned no usable access token')
    }
    return { Authorization: `Bearer ${result.access_token}` }
  }

  async function getDocument(headers) {
    const url = `${documentUrl}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`
    const document = await request(url, { headers }, 'Google Docs read')
    if (document.documentId !== documentId || typeof document.revisionId !== 'string' || !document.revisionId) {
      throw new Error('Google Docs read returned an incomplete or different document')
    }
    const bodies = documentBodies(document)
    return {
      revisionId: document.revisionId,
      text: bodies.map(({ body }) => documentText(body.content)).join(''),
      target: bodies[0],
    }
  }

  async function getComments(headers) {
    const comments = []
    const seen = new Set()
    let pageToken
    do {
      const url = new URL(`${driveRoot}${encodeURIComponent(documentId)}/comments`)
      url.searchParams.set('fields', 'nextPageToken,comments(*)')
      url.searchParams.set('pageSize', '100')
      url.searchParams.set('includeDeleted', 'true')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const result = await request(url.toString(), { headers }, 'Google Drive comments read')
      if (!Array.isArray(result.comments) || result.incompleteSearch === true ||
          result.comments.some(comment => !comment || typeof comment.id !== 'string' ||
            (comment.replies !== undefined && !Array.isArray(comment.replies)))) {
        throw new Error('Incomplete Google Drive comments')
      }
      comments.push(...result.comments)
      pageToken = result.nextPageToken
      if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || seen.has(pageToken))) {
        throw new Error('Invalid or repeated Google Drive comments page token')
      }
      if (pageToken) seen.add(pageToken)
      if (seen.size > 10000) throw new Error('Google Drive comments pagination limit exceeded')
    } while (pageToken)
    return comments
  }

  function presentationTime() {
    const value = now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid presentation time')
    return value.toISOString()
  }

  async function appendSection(headers, document, section, label) {
    const { body, tabId } = document.target
    const index = body.content.at(-1)?.endIndex - 1
    if (!Number.isSafeInteger(index) || index < 1) throw new Error('Missing Google Docs append index')
    const requests = [{
      insertText: { location: { index, ...(tabId ? { tabId } : {}) }, text: `\n${section.text}\n` },
    }, ...section.links.map(link => ({
      updateTextStyle: {
        range: {
          startIndex: index + 1 + link.offset,
          endIndex: index + 1 + link.offset + link.length,
          ...(tabId ? { tabId } : {}),
        },
        textStyle: { link: { url: link.url } },
        fields: 'link',
      },
    }))]
    await request(`${documentUrl}:batchUpdate`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writeControl: { requiredRevisionId: document.revisionId }, requests }),
    }, label)
  }

  return {
    async read() {
      const headers = await authorize()
      const [document, comments] = await Promise.all([getDocument(headers), getComments(headers)])
      return { revisionId: document.revisionId, text: document.text, comments }
    },

    async present(input) {
      let expected = buildReview(input, repo, approverEmail)
      const headers = await authorize()
      const document = await getDocument(headers)
      const existing = reviewSpan(document.text, input.revision)
      let presentedAt
      if (existing !== null) {
        presentedAt = recoverPresentationTime(existing, input.revision)
        expected = buildReview(input, repo, approverEmail, presentedAt)
        if (existing !== expected.text) throw new Error('Existing wiki review differs from the frozen snapshot')
      }
      if (existing === null) {
        const { tabId } = document.target
        await appendSection(headers, document, expected, 'Google Docs review append')
        const updated = await getDocument(headers)
        if (reviewSpan(updated.text, input.revision) !== expected.text) throw new Error('Google Docs review append verification failed')
        // The cutoff is chosen only AFTER the complete preview is confirmed
        // visible, then persisted inside its checksum-protected marker span.
        // A crash before this receipt exists cannot safely recover a cutoff.
        presentedAt = presentationTime()
        expected = buildReview(input, repo, approverEmail, presentedAt)
        await request(`${documentUrl}:batchUpdate`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            writeControl: { requiredRevisionId: updated.revisionId },
            requests: [{
              replaceAllText: {
                containsText: { text: presentationMarker(input.revision), matchCase: true },
                replaceText: presentationMarker(input.revision, presentedAt),
                ...(tabId ? { tabsCriteria: { tabIds: [tabId] } } : {}),
              },
            }],
          }),
        }, 'Google Docs presentation receipt')
        const completed = await getDocument(headers)
        if (reviewSpan(completed.text, input.revision) !== expected.text) {
          throw new Error('Google Docs presentation receipt verification failed')
        }
      }
      return { presentedAt, reviewTextHash: hash(expected.text), approvalText: expected.approvalText }
    },

    async recordPublication(input) {
      const expected = buildPublication(input, repo)
      const headers = await authorize()
      const document = await getDocument(headers)
      const review = reviewSpan(document.text, input.revision)
      if (review === null) throw new Error('Cannot record publication without its frozen review')
      recoverPresentationTime(review, input.revision)
      if (!review.includes(`\nSnapshot digest (SHA-256): ${input.contentHash}\n`)) {
        throw new Error('Publication digest differs from the frozen review')
      }
      const existing = publicationSpan(document.text, input.revision)
      if (existing !== null) {
        if (existing !== expected.text) throw new Error('Existing wiki publication receipt differs')
        assertOutsideReviews(document.text, document.text.indexOf(existing))
      } else {
        const targetText = documentText(document.target.body.content)
        assertOutsideReviews(targetText, targetText.length)
        await appendSection(headers, document, expected, 'Google Docs publication append')
        const updated = await getDocument(headers)
        if (publicationSpan(updated.text, input.revision) !== expected.text || reviewSpan(updated.text, input.revision) !== review) {
          throw new Error('Google Docs publication append verification failed')
        }
      }
      return { publishedAt: input.publishedAt, publicationTextHash: hash(expected.text) }
    },

    async verifyReview({ revision, reviewTextHash }) {
      markers(revision)
      if (!/^[a-f0-9]{64}$/.test(reviewTextHash)) throw new Error('Invalid review text hash')
      const document = await getDocument(await authorize())
      const span = reviewSpan(document.text, revision)
      if (span === null || hash(span) !== reviewTextHash) throw new Error('Wiki review is missing or its text checksum does not match')
      recoverPresentationTime(span, revision)
      return true
    },
  }
}
