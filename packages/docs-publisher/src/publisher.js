import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import {
  assignBlockIds, docBodyByteLength, docPath, extractDocLinks, historyPath, journalReadLoad,
  parseDoc, parseDraftBlocks, parseDocHeader, parseDocHref, reviewPath, reviewSet, responsePath, validateDocText,
  validateIndexText, validateResponseText, validateReviewText, DOCS_LIMITS, fencedLineMask,
} from '../../docs-core/src/index.js'
import { deriveDocState } from '../../docs-core/src/review.js'
import { splitLines, walkVisibleLines } from '../../docs-core/src/grammar.js'

const HTML_RE = /<\/?[a-z][^>]*>/i
const CORRUPTION_MARKERS = ['\uFFFD', 'Ã', 'Â', 'â€', 'ðŸ', 'ï¿½']
const REQUIRED_SECTIONS = [
  'What this is, with no prior context',
  'Why it matters',
  'What changed / what was done',
  'Evidence',
  'Where it stands',
]
const ID_RE = /^d-[a-z0-9]{6,}$/

export class DocsPublisherError extends Error {
  constructor(code, detail, action) {
    super(`${code}: ${detail}${action ? `; ${action}` : ''}`)
    this.name = 'DocsPublisherError'
    this.code = code
  }
}

function fail(code, detail, action) {
  throw new DocsPublisherError(code, detail, action)
}

function readText(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('D01 encoding', `${label} is not valid UTF-8`, 'save it as UTF-8 without a BOM')
  }
}

function checkEncoding(text, label = 'draft') {
  if (text.startsWith('\uFEFF')) fail('D01 encoding', `${label} has a UTF-8 BOM`, 'save it as UTF-8 without a BOM')
  if (text.includes('\r')) fail('D01 encoding', `${label} uses CRLF`, 'save it with LF line endings')
  const marker = CORRUPTION_MARKERS.find((item) => text.includes(item))
  if (marker) fail('D01 encoding', `${label} contains the corruption marker ${marker}`, 'restore the source characters manually')
}

function draftModel(text) {
  checkEncoding(text)
  const lines = splitLines(text)
  const parsed = parseDoc(text)
  const fenced = fencedLineMask(lines)
  if (!parsed.title || lines.filter((line, index) => !fenced[index] && /^#\s/.test(line)).length !== 1) {
    fail('D03 catch-up', 'draft must start with one H1 title', 'add a single # title at the top')
  }
  const titleIndex = lines.findIndex((line) => /^#\s/.test(line))
  if (titleIndex !== 0) fail('D03 catch-up', 'draft title must be its first line', 'move the H1 title to the top')
  const contentLines = lines.slice(titleIndex + 1)

  const visible = []
  walkVisibleLines(contentLines, {
    onLine: (line, info) => visible.push({ line, fenced: info.fenced }),
  })
  for (const { line, fenced: isFenced } of visible) {
    if (!isFenced && HTML_RE.test(line)) {
      fail('D02 grammar', `unsupported raw HTML: ${line.trim()}`, 'convert it to supported Markdown')
    }
    if (!isFenced && /~~/.test(line)) {
      fail('D02 grammar', `unsupported Markdown construct: ${line.trim()}`, 'use the journal renderer Markdown subset')
    }
  }

  const blocks = parseDraftBlocks(text)
  if (!blocks.length) fail('D03 catch-up', 'draft body is empty', 'add a status sentence and catch-up content')
  const bodyText = visible.map((item) => item.line).join('\n')
  const firstVisible = visible.find((item) => item.line.trim())?.line.trim() || ''
  if (!/^\*\*[^*]+\*\*/.test(firstVisible)) {
    fail('D03 catch-up', 'primary document must start with a bold status sentence', 'add **Status: …** directly after the title')
  }
  const headings = visible
    .map(({ line }) => line.match(/^#{2,6}\s+(.+)$/)?.[1]?.trim().toLowerCase())
    .filter(Boolean)
  const normalizedBody = bodyText.toLowerCase().replace(/\s+/g, ' ')
  let sectionIndex = -1
  for (const section of REQUIRED_SECTIONS) {
    const nextIndex = headings.indexOf(section.toLowerCase())
    if (!normalizedBody.includes(section.toLowerCase()) || nextIndex === -1) {
      fail('D03 catch-up', `required catch-up section is missing: ${section}`, `add the ${section} section when applicable`)
    }
    if (nextIndex <= sectionIndex) {
      fail('D03 catch-up', `required catch-up section is out of order: ${section}`, `place ${section} in the specified order`)
    }
    sectionIndex = nextIndex
  }
  const linesWithClaims = bodyText.split('\n')
  for (const line of linesWithClaims) {
    if (/^\s*#{1,6}\s/.test(line)) continue
    if (/\b(?:verified|fixed|done)\b/i.test(line) && !/\[[^\]]+\]\((?:https?:|mailto:|doc:)[^)]+\)/i.test(line)) {
      fail('D03 catch-up', `claim has no evidence link: ${line.trim()}`, 'link each verified, fixed, or done claim to evidence')
    }
  }
  const bareTask = bodyText.match(/(?:^|\s)#([1-9][0-9]*)(?=\s|$|[.,;:])/)
  if (bareTask) fail('D03 catch-up', `bare task reference #${bareTask[1]}`, 'replace it with a link or ordinary prose')

  const links = extractDocLinks(text)
  const markdownLinks = [...text.matchAll(/\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
  for (const [, href] of markdownLinks) {
    if (href.startsWith('doc:')) {
      if (!parseDocHref(href)) fail('D04 link', `malformed Docs link: ${href}`, 'use doc:<valid-id>[#bN]')
    } else {
      try {
        if (!new URL(href).protocol) throw new Error('invalid')
      } catch {
        fail('D04 link', `malformed external URL: ${href}`, 'use a well-formed absolute URL')
      }
    }
  }
  return { title: parsed.title, blocks, links, raw: text }
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now ?? new Date()
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

async function readOptional(io, filename) {
  try {
    return await io.readFile(filename)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function loadIndex(root, io = fs.promises) {
  const filename = path.join(root, 'docs', 'index.json')
  const bytes = await readOptional(io, filename)
  if (!bytes) return { filename, text: null, index: { version: 1, tasks: {}, docs: {} } }
  const text = readText(bytes, 'docs/index.json')
  try {
    return { filename, text, index: validateIndexText(text) }
  } catch (error) {
    if (/D07 size/.test(error.message)) fail('D07 size', error.message, 'reduce docs/index.json')
    fail('D09 data', error.message, 'repair docs/index.json before publishing')
  }
}

async function readFileText(root, relative, io = fs.promises) {
  const bytes = await readOptional(io, path.join(root, relative))
  return bytes == null ? null : readText(bytes, relative)
}

function validateLinks(links, index, creatingId = null) {
  for (const id of links) {
    if (!index.docs[id] && id !== creatingId) {
      fail('D04 link', `doc:${id} is not listed in docs/index.json`, 'publish the target first')
    }
  }
}

function detectExistingEdit(docText, id, entry, response) {
  try {
    validateDocText(docText, { docId: id, entry, response })
  } catch (error) {
    if (/publisher stamp|revision does not match/.test(error.message)) {
      fail('D10 external edit', `docs/${id}/doc.md differs from its publisher stamp or published revision`, 'review the edit and pass --adopt-external-edit explicitly')
    }
    fail('D09 data', error.message, 'repair the document and its matching response/index files')
  }
}

function draftWithAnchors(model, id, rev, published, previous, maxUsedId) {
  const assigned = assignBlockIds(model.blocks, previous?.blocks || [], maxUsedId + 1)
  const content = [
    `<!-- docs v1 id=${id} rev=${rev} published=${published} by=fp-docs -->`,
    `# ${model.title}`,
    '',
    ...assigned.blocks.flatMap((block) => [`<!-- @${block.id} -->`, ...block.lines, '']),
  ].join('\n')
  return { text: content.endsWith('\n') ? content : `${content}\n`, blocks: assigned.blocks }
}

async function highestUsedBlockId(root, id, currentDoc, io) {
  let max = 0
  for (const block of currentDoc?.blocks || []) max = Math.max(max, Number(block.id.slice(1)) || 0)
  const directory = path.join(root, 'docs', id, 'history')
  try {
    for (const filename of await io.readdir(directory)) {
      const match = filename.match(/^r(\d{4,})\.md$/)
      if (!match) continue
      const text = await readFileText(root, path.join('docs', id, 'history', filename), io)
      for (const block of parseDoc(text).blocks) max = Math.max(max, Number(block.id.slice(1)) || 0)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return max
}

function encodeIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`
}

export async function lintDraft({ draft, root, io = fs.promises, checkLinks = false }) {
  const input = Buffer.isBuffer(draft) ? readText(draft, 'draft') : String(draft ?? '')
  checkEncoding(input)
  if (Buffer.byteLength(input) > DOCS_LIMITS.docBytes) {
    fail('D07 size', `draft exceeds ${DOCS_LIMITS.docBytes} bytes`, 'reduce the draft; it will not be truncated')
  }
  const model = draftModel(input)
  const { index } = await loadIndex(root, io)
  validateLinks(model.links, index)
  if (checkLinks) await checkExternalLinks(input)
  return { title: model.title, links: model.links }
}

async function checkExternalLinks(text) {
  const urls = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1])
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      fail('D04 link', `external URL is unreachable: ${url} (${error.message})`, 'repair or remove the link')
    }
  }
}

export async function writeAtomically(changes, { io = fs.promises } = {}) {
  const staged = []
  const committed = []
  const createdDirectories = []
  try {
    for (const change of changes) {
      const directory = path.dirname(change.path)
      const missing = []
      let current = directory
      while (current) {
        try {
          await io.stat(current)
          break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          missing.push(current)
          const parent = path.dirname(current)
          if (parent === current) break
          current = parent
        }
      }
      await io.mkdir(directory, { recursive: true })
      createdDirectories.push(...missing)
      const temp = `${change.path}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`
      await io.writeFile(temp, change.content, { flag: 'wx' })
      const previous = await readOptional(io, change.path)
      staged.push({ ...change, temp, previous })
    }
    for (const change of staged) {
      await io.rename(change.temp, change.path)
      committed.push(change)
    }
  } catch (error) {
    for (const change of committed.reverse()) {
      if (change.previous == null) await io.rm(change.path, { force: true }).catch(() => {})
      else {
        const restore = `${change.path}.restore-${process.pid}-${randomBytes(5).toString('hex')}`
        await io.writeFile(restore, change.previous)
        await io.rename(restore, change.path)
      }
    }
    for (const change of staged) await io.rm(change.temp, { force: true }).catch(() => {})
    for (const directory of createdDirectories.reverse()) await io.rmdir(directory).catch(() => {})
    throw error
  } finally {
    for (const change of staged) await io.rm(change.temp, { force: true }).catch(() => {})
  }
}

async function ensureReviewSetSize(root, index, primaryId, io, currentText, currentResponse) {
  let total = 0
  for (const id of reviewSet(index, primaryId, 3)) {
    const text = id === primaryId ? currentText : await readFileText(root, docPath(id), io)
    if (!text) fail('D04 link', `linked document ${id} is missing`, 'publish the target or remove the link')
    const responseText = id === primaryId
      ? JSON.stringify(currentResponse)
      : await readFileText(root, responsePath(id), io)
    let response
    try {
      response = validateResponseText(responseText)
      validateDocText(text, { docId: id, entry: index.docs[id], response })
    } catch (error) {
      fail('D09 data', error.message, `repair docs/${id} before publishing`)
    }
    total += docBodyByteLength(text)
    if (total > DOCS_LIMITS.reviewSetBytes) {
      fail('D07 size', `task review set exceeds ${DOCS_LIMITS.reviewSetBytes} bytes`, 'reduce the draft or linked documents')
    }
    const reviewText = await readFileText(root, reviewPath(id), io)
    try {
      validateReviewText(reviewText)
    } catch (error) {
      if (/D07 size/.test(error.message)) {
        fail('D07 size', error.message, 'reduce review.json; do not truncate it')
      }
      fail('D09 data', error.message, `repair docs/${id}/review.json before publishing`)
    }
  }
}

export async function publish({
  root, task, draft, summary, baseRev, force = false, adoptExternalEdit = false,
  checkLinks = false, io = fs.promises, now, makeId,
}) {
  if (!Number.isSafeInteger(Number(task)) || Number(task) < 1) {
    fail('D08 binding', 'task must be a positive integer', 'pass --task N')
  }
  if (typeof summary !== 'string' || !summary.trim()) {
    fail('D09 data', 'publish requires a non-empty --summary', 'pass --summary TEXT')
  }
  const input = Buffer.isBuffer(draft) ? readText(draft, 'draft') : String(draft ?? '')
  checkEncoding(input)
  if (Buffer.byteLength(input) > DOCS_LIMITS.docBytes) {
    fail('D07 size', `draft exceeds ${DOCS_LIMITS.docBytes} bytes`, 'reduce the draft; it will not be truncated')
  }
  const model = draftModel(input)
  if (checkLinks) await checkExternalLinks(input)

  const { index: oldIndex, text: oldIndexText } = await loadIndex(root, io)
  const taskId = String(Number(task))
  const oldId = oldIndex.tasks[taskId]
  const id = oldId || (makeId ? makeId() : `d-${randomBytes(5).toString('hex')}`)
  if (!ID_RE.test(id)) fail('D09 data', `generated invalid document id ${id}`, 'use a valid lowercase document id')
  const oldEntry = oldIndex.docs[id]
  if (oldEntry?.primary && oldEntry.task !== Number(task)) {
    fail('D08 binding', `${id} is already the primary for task ${oldEntry.task}`, 'publish against the task already bound to this document')
  }
  if (!oldId && Object.hasOwn(oldIndex.tasks, taskId)) {
    fail('D09 data', `task ${taskId} is bound inconsistently`, 'repair the Docs index')
  }

  let oldDocText = oldEntry ? await readFileText(root, docPath(id), io) : null
  const oldResponseText = oldEntry ? await readFileText(root, responsePath(id), io) : null
  let oldResponse = null
  let oldParsed = null
  let historySnapshot = null
  if (oldEntry) {
    if (!oldDocText || !oldResponseText) {
      fail('D09 data', `published files for ${id} are incomplete`, 'restore doc.md and response.json from a complete revision')
    }
    try {
      oldResponse = validateResponseText(oldResponseText)
      detectExistingEdit(oldDocText, id, oldEntry, oldResponse)
      const publishedSnapshot = await readFileText(root, historyPath(id, oldEntry.rev), io)
      if (publishedSnapshot && publishedSnapshot !== oldDocText) {
        fail('D10 external edit', `docs/${id}/doc.md differs from its published snapshot`, 'review the edit and pass --adopt-external-edit explicitly')
      }
      oldParsed = parseDoc(oldDocText)
      historySnapshot = oldDocText
    } catch (error) {
      if (error instanceof DocsPublisherError && error.code === 'D10 external edit') {
        if (!adoptExternalEdit) throw error
        try {
          oldParsed = parseDoc(oldDocText)
          if (!oldParsed.title || !oldParsed.blocks.length) throw new Error('external document is not valid Markdown')
          const stamp = parseDocHeader(oldDocText)
          if (stamp?.id !== id || stamp.rev !== oldEntry.rev) throw new Error('external document identity or revision does not match the index')
          const adopted = oldDocText.replace(/^<!--.*?-->/, `<!-- docs v1 id=${id} rev=${oldEntry.rev} published=${stamp.published} by=fp-docs -->`)
          validateDocText(adopted, { docId: id, entry: oldEntry, response: oldResponse })
          oldDocText = adopted
          historySnapshot = adopted
          oldParsed = parseDoc(adopted)
        } catch (adoptError) {
          fail('D10 external edit', adoptError.message, 'repair the external edit before adopting it')
        }
      } else throw error
    }
    if (baseRev != null && Number(baseRev) !== oldEntry.rev) {
      fail('D06 concurrency', `--base-rev expected ${baseRev}, current revision is ${oldEntry.rev}`, 'read the current revision and republish')
    }
  } else {
    const journal = await readFileText(root, `journal/task-${taskId}.md`, io)
    if (!journal) fail('D08 binding', `journal/task-${taskId}.md does not exist`, 'create the task journal before publishing')
    const load = journalReadLoad(journal)
    if (!load.reached && !force) {
      fail('D08 binding', `task ${taskId} has ${load.words} visible words; threshold is ${load.threshold}`, 'wait for the threshold or pass --force intentionally')
    }
    if (oldIndex.tasks[taskId]) fail('D08 binding', `task ${taskId} already has primary ${oldIndex.tasks[taskId]}`, 'update the bound primary instead')
  }

  const nextRev = (oldEntry?.rev || 0) + 1
  const published = nowIso(now)
  const maxBlockId = oldEntry ? await highestUsedBlockId(root, id, oldParsed, io) : 0
  const { text: docText, blocks } = draftWithAnchors(model, id, nextRev, published, oldParsed, maxBlockId)
  const entry = {
    ...(oldEntry || {}),
    title: model.title,
    task: Number(task),
    primary: true,
    rev: nextRev,
    updatedAt: published,
    links: model.links,
  }
  const index = {
    version: 1,
    tasks: { ...oldIndex.tasks, [taskId]: id },
    docs: { ...oldIndex.docs, [id]: entry },
  }
  validateLinks(entry.links, index, id)
  for (const [docId, linked] of Object.entries(index.docs)) {
    if (linked.links.some((link) => !index.docs[link])) {
      fail('D04 link', `${docId} links to a missing document`, 'publish the target or remove the link')
    }
  }

  const response = {
    version: 1,
    rev: nextRev,
    revisions: [
      { rev: nextRev, at: published, summary: summary.trim() },
      ...(oldResponse?.revisions || []),
    ].slice(0, 20),
    dispositions: oldResponse?.dispositions || {},
    ackedReview: oldResponse?.ackedReview ?? null,
  }
  try {
    validateDocText(docText, { docId: id, entry, response })
    validateResponseText(JSON.stringify(response))
    validateIndexText(encodeIndex(index))
  } catch (error) {
    if (/D07 size/.test(error.message)) fail('D07 size', error.message.replace(/^D07 size:\s*/, ''), 'reduce published data')
    fail('D09 data', error.message, 'repair the named field before publishing')
  }
  if (oldIndexText && Buffer.byteLength(oldIndexText) > DOCS_LIMITS.indexBytes) {
    fail('D07 size', `docs/index.json exceeds ${DOCS_LIMITS.indexBytes} bytes`, 'reduce the index')
  }
  await ensureReviewSetSize(root, index, id, io, docText, response)

  const changes = []
  if (oldDocText) {
    const snapshot = { path: path.join(root, historyPath(id, oldEntry.rev)), content: historySnapshot || oldDocText }
    changes.push(snapshot)
  } else {
    changes.push({ path: path.join(root, historyPath(id, nextRev)), content: docText })
  }
  changes.push(
    { path: path.join(root, docPath(id)), content: docText },
    { path: path.join(root, responsePath(id)), content: `${JSON.stringify(response, null, 2)}\n` },
    { path: path.join(root, 'docs/index.json'), content: `${encodeIndex(index)}` },
  )
  await writeAtomically(changes, { io })
  await trimHistory(root, id, io)
  return { id, rev: nextRev, blocks, index, docText, response }
}

async function trimHistory(root, id, io) {
  const directory = path.join(root, 'docs', id, 'history')
  let files
  try {
    files = await io.readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const history = files
    .map((filename) => ({ filename, rev: Number(filename.match(/^r(\d{4,})\.md$/)?.[1]) }))
    .filter((item) => Number.isInteger(item.rev))
    .sort((a, b) => b.rev - a.rev)
  for (const item of history.slice(20)) await io.rm(path.join(directory, item.filename), { force: true })
}

export async function readStatus({ root, task, io = fs.promises, threshold } = {}) {
  const taskId = String(Number(task))
  const journalText = await readFileText(root, `journal/task-${taskId}.md`, io)
  if (journalText == null) fail('D08 binding', `journal/task-${taskId}.md does not exist`, 'create the task journal first')
  const settings = await readFileText(root, 'user-settings.md', io)
  const configured = settings?.match(/Catch-up doc threshold\s*[:|]\s*(\d+)/i)?.[1]
  const readLoad = journalReadLoad(journalText, threshold ?? (Number(configured) || undefined))
  const { index } = await loadIndex(root, io)
  const primaryId = index.tasks[taskId] || null
  const primary = primaryId ? index.docs[primaryId] : null
  const docs = []
  let openCount = 0
  if (primaryId) {
    for (const id of reviewSet(index, primaryId, 3)) {
      const entry = index.docs[id]
      const [reviewText, responseText] = await Promise.all([
        readFileText(root, reviewPath(id), io),
        readFileText(root, responsePath(id), io),
      ])
      try {
        const review = validateReviewText(reviewText)
        const response = validateResponseText(responseText)
        const state = deriveDocState({ entry, review, response })
        openCount += state.openCount
        docs.push({ id, rev: entry.rev, state: state.state, readRev: state.readRev, openCount: state.openCount })
      } catch (error) {
        fail('D09 data', error.message, `repair docs/${id} before reading status`)
      }
    }
  }
  return {
    task: Number(task),
    journal: readLoad,
    threshold: readLoad.reached ? 'reached' : 'not reached',
    primary: primary ? { id: primaryId, rev: primary.rev, title: primary.title } : null,
    linkedDocs: docs.slice(1),
    docs,
    openCount,
  }
}
