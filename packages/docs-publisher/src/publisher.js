import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import fs from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
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

function withoutInlineCode(line) {
  return line.replace(/(`+).*?\1/g, '')
}

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

function draftModel(text, { primary = true } = {}) {
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
    const prose = withoutInlineCode(line)
    if (!isFenced && HTML_RE.test(prose)) {
      fail('D02 grammar', `unsupported raw HTML: ${line.trim()}`, 'convert it to supported Markdown')
    }
    if (!isFenced && /~~/.test(prose)) {
      fail('D02 grammar', `unsupported Markdown construct: ${line.trim()}`, 'use the journal renderer Markdown subset')
    }
  }

  const blocks = parseDraftBlocks(text)
  if (!blocks.length) fail('D03 catch-up', 'draft body is empty', 'add a status sentence and catch-up content')
  const proseLines = visible.filter((item) => !item.fenced).map((item) => withoutInlineCode(item.line))
  const bodyText = proseLines.join('\n')
  const firstVisible = visible.find((item) => item.line.trim())?.line.trim() || ''
  if (primary && !/^\*\*[^*]+\*\*/.test(firstVisible)) {
    fail('D03 catch-up', 'primary document must start with a bold status sentence', 'add **Status: …** directly after the title')
  }
  const headings = proseLines
    .map((line) => line.match(/^#{2,6}\s+(.+)$/)?.[1]?.trim().toLowerCase())
    .filter(Boolean)
  const normalizedBody = bodyText.toLowerCase().replace(/\s+/g, ' ')
  let sectionIndex = -1
  for (const section of primary ? REQUIRED_SECTIONS : []) {
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
  for (const line of primary ? linesWithClaims : []) {
    if (/^\s*#{1,6}\s/.test(line)) continue
    if (/\b(?:verified|fixed|done)\b/i.test(line) && !/\[[^\]]+\]\((?:https?:|mailto:|doc:)[^)]+\)/i.test(line)) {
      fail('D03 catch-up', `claim has no evidence link: ${line.trim()}`, 'link each verified, fixed, or done claim to evidence')
    }
  }
  const bareTask = primary ? bodyText.match(/(?:^|\s)#([1-9][0-9]*)(?=\s|$|[.,;:])/) : null
  if (bareTask) fail('D03 catch-up', `bare task reference #${bareTask[1]}`, 'replace it with a link or ordinary prose')

  const linkSource = visible.map(({ line, fenced }) => fenced ? '' : withoutInlineCode(line)).join('\n')
  const links = extractDocLinks(linkSource)
  const markdownLinks = [...linkSource.matchAll(/\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
  for (const [, href] of markdownLinks) {
    if (href.startsWith('doc:')) {
      if (!parseDocHref(href)) fail('D04 link', `malformed Docs link: ${href}`, 'use doc:<valid-id>[#bN]')
    } else {
      try {
        if (!/^(https?:|mailto:)/i.test(href)) throw new Error('unsupported URL scheme')
        const url = new URL(href)
        if (!url.protocol || url.username || url.password) throw new Error('invalid or credential-bearing URL')
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
  let text
  try {
    text = readText(bytes, 'docs/index.json')
  } catch {
    fail('D09 data', 'docs/index.json is not valid UTF-8', 'repair docs/index.json before publishing')
  }
  let index
  try {
    index = validateIndexText(text)
  } catch (error) {
    if (/D07 size/.test(error.message)) fail('D07 size', error.message, 'reduce docs/index.json')
    fail('D09 data', error.message, 'repair docs/index.json before publishing')
  }
  if (!index) fail('D09 data', 'docs/index.json is empty', 'restore a valid Docs index before publishing')
  return { filename, text, index }
}

async function readFileText(root, relative, io = fs.promises) {
  const bytes = await readOptional(io, path.join(root, relative))
  if (bytes == null) return null
  try {
    return readText(bytes, relative)
  } catch (error) {
    if (relative.startsWith('docs/')) {
      fail('D09 data', `${relative} is not valid UTF-8`, 'repair the named Docs file')
    }
    throw error
  }
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
    if (/publisher stamp|title does not match/.test(error.message)) {
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
  return {
    text: content.endsWith('\n') ? content : `${content}\n`,
    blocks: assigned.blocks,
    nextBlockId: assigned.nextId,
  }
}

async function highestUsedBlockId(root, id, currentDoc, io, nextBlockId = 1) {
  let max = Math.max(0, Number(nextBlockId) - 1 || 0)
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

function telegramUrlFrom(journal) {
  const fields = String(journal || '').match(/<!--\s*tg-meta\b([\s\S]*?)-->/i)?.[1]
  if (!fields) return undefined
  const username = fields.match(/\busername=(["']?)([^"'\s>]+)\1/i)?.[2]?.replace(/^@/, '')
  if (username && /^[A-Za-z0-9_]{5,32}$/.test(username)) return `https://t.me/${username}`
  const chatId = fields.match(/\bchatId=(["']?)(-?\d+)\1/i)?.[2]
  const threadId = fields.match(/\bthreadId=(["']?)(\d+)\1/i)?.[2]
  if (!chatId || !threadId || !chatId.startsWith('-100')) return undefined
  return `https://t.me/c/${chatId.replace(/^-100/, '')}/${threadId}`
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
  const traversalId = 'd-lintdraft'
  const traversalIndex = { docs: { ...index.docs, [traversalId]: { links: model.links } } }
  let total = Buffer.byteLength(input)
  for (const id of reviewSet(traversalIndex, traversalId, 3).slice(1)) {
    const text = await readFileText(root, docPath(id), io)
    if (!text) fail('D04 link', `linked document ${id} is missing`, 'publish the target or remove the link')
    const responseText = await readFileText(root, responsePath(id), io)
    try {
      const response = validateResponseText(responseText)
      validateDocText(text, { docId: id, entry: index.docs[id], response })
      validateReviewText(await readFileText(root, reviewPath(id), io))
    } catch (error) {
      if (/D07 size/.test(error.message)) fail('D07 size', error.message, 'reduce the linked data; do not truncate it')
      fail('D09 data', error.message, `repair docs/${id} before linting`)
    }
    total += docBodyByteLength(text)
    if (total > DOCS_LIMITS.reviewSetBytes) {
      fail('D07 size', `task review set exceeds ${DOCS_LIMITS.reviewSetBytes} bytes`, 'reduce the draft or linked documents')
    }
  }
  if (checkLinks) await checkExternalLinks(input)
  return { title: model.title, links: model.links }
}

async function checkExternalLinks(text) {
  const urls = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1])
  for (const url of urls) {
    try {
      await checkExternalUrl(url)
    } catch (error) {
      fail('D04 link', `external URL is unreachable: ${url} (${error.message})`, 'repair or remove the link')
    }
  }
}

async function checkExternalUrl(url, redirects = 0) {
  const parsed = new URL(url)
  if (parsed.username || parsed.password) throw new Error('URLs with embedded credentials are not checked')
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || isPrivateAddress(hostname)) {
    throw new Error('private or local network targets are not checked')
  }
  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true })
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('hostname resolves to a private or local network')
    }
  }
  const response = await fetch(parsed, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  })
  if (response.status >= 300 && response.status < 400) {
    if (redirects >= 5) throw new Error('too many redirects')
    const location = response.headers.get('location')
    if (!location) throw new Error(`HTTP ${response.status} without a redirect target`)
    const next = new URL(location, parsed)
    if (!['http:', 'https:'].includes(next.protocol)) throw new Error('redirect uses an unsafe URL scheme')
    return checkExternalUrl(next.href, redirects + 1)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  function isPrivateAddress(hostname) {
    const family = isIP(hostname)
    if (family === 4) {
      const [a, b] = hostname.split('.').map(Number)
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127) || a >= 224
    }
    if (family === 6) {
      const address = hostname.toLowerCase()
      if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7))
      return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd')
        || /^fe[89ab]/.test(address) || address.startsWith('::ffff:127.') || address.startsWith('::ffff:10.')
        || address.startsWith('::ffff:192.168.')
    }
    return false
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
      const item = { ...change, temp, previous: null }
      staged.push(item)
      await io.writeFile(temp, change.content, { flag: 'wx' })
      item.previous = await readOptional(io, change.path)
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
    for (const directory of [...new Set(createdDirectories)].sort((a, b) => b.length - a.length)) {
      await io.rmdir(directory).catch(() => {})
    }
    throw error
  } finally {
    for (const change of staged) await io.rm(change.temp, { force: true }).catch(() => {})
  }
}

async function ensureReviewSetSize(root, index, primaryId, io, pending = new Map()) {
  let total = 0
  for (const id of reviewSet(index, primaryId, 3)) {
    const staged = pending.get(id)
    const text = staged?.docText ?? await readFileText(root, docPath(id), io)
    if (!text) fail('D04 link', `linked document ${id} is missing`, 'publish the target or remove the link')
    const responseText = staged
      ? JSON.stringify(staged.response)
      : await readFileText(root, responsePath(id), io)
    let response
    try {
      response = validateResponseText(responseText)
      validateDocText(text, { docId: id, entry: index.docs[id], response })
    } catch (error) {
      if (/D07 size/.test(error.message)) fail('D07 size', error.message, `reduce docs/${id}`)
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
  checkLinks = false, linked = [], io = fs.promises, now, makeId,
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
  if (checkLinks) await checkExternalLinks(input)

  const { index: oldIndex } = await loadIndex(root, io)
  const taskId = String(Number(task))
  const oldId = oldIndex.tasks[taskId]
  const journalText = await readFileText(root, `journal/task-${taskId}.md`, io)
  if (!oldId && Object.hasOwn(oldIndex.tasks, taskId)) {
    fail('D09 data', `task ${taskId} is bound inconsistently`, 'repair the Docs index')
  }
  if (!oldId) {
    if (!journalText) fail('D08 binding', `journal/task-${taskId}.md does not exist`, 'create the task journal before publishing')
    const load = journalReadLoad(journalText, await catchupThreshold(root, io))
    if (!load.reached && !force) {
      fail('D08 binding', `task ${taskId} has ${load.words} visible words; threshold is ${load.threshold}`, 'wait for the threshold or pass --force intentionally')
    }
  }

  const published = nowIso(now)
  const usedIds = new Set(Object.keys(oldIndex.docs))
  const allocateId = () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = makeId ? makeId() : `d-${randomBytes(5).toString('hex')}`
      if (!ID_RE.test(candidate)) fail('D11 linked input', `generated invalid document id ${candidate}`, 'use a valid lowercase document id')
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate)
        return candidate
      }
    }
    fail('D11 linked input', 'could not allocate a unique document id', 'retry the publish')
  }

  const aliasIds = new Map()
  const preparedLinked = []
  const updatedIds = new Set(oldId ? [oldId] : [])
  for (const linkedInput of linked || []) {
    const hasAlias = typeof linkedInput.alias === 'string'
    const hasId = typeof linkedInput.id === 'string'
    if (hasAlias === hasId) fail('D11 linked input', 'each --linked input must name either a new alias or an existing id', 'use new:<alias>=FILE or <id>=FILE')
    if (hasAlias) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(linkedInput.alias) || aliasIds.has(linkedInput.alias)) {
        fail('D11 linked input', `invalid or duplicate new alias: ${linkedInput.alias}`, 'use a unique lowercase alias')
      }
      const id = allocateId()
      aliasIds.set(linkedInput.alias, id)
      preparedLinked.push({ id, alias: linkedInput.alias, draft: linkedInput.draft, existing: false })
      updatedIds.add(id)
      continue
    }
    const id = linkedInput.id
    const entry = oldIndex.docs[id]
    if (!ID_RE.test(id) || !entry || entry.primary || updatedIds.has(id)) {
      fail('D11 linked input', `invalid, missing, primary, or duplicate linked document id: ${id}`, 'use an existing supporting document id')
    }
    const linkedBaseRev = linkedInput.baseRev
    if (linkedBaseRev == null) {
      fail('D11 linked input', `linked document ${id} requires --linked-base-rev`, 'pass the current linked revision')
    }
    if (Number(linkedBaseRev) !== entry.rev) {
      fail('D06 concurrency', `--linked-base-rev for ${id} expected ${linkedBaseRev}, current revision is ${entry.rev}`, 'read the current revision and republish')
    }
    preparedLinked.push({ id, baseRev: linkedBaseRev, draft: linkedInput.draft, existing: true })
    updatedIds.add(id)
  }
  const rewriteAliases = (source) => {
    return source.replace(/doc:new:([A-Za-z0-9_-]+)(#b[1-9][0-9]*)?/g, (whole, alias, block = '') => {
      const id = aliasIds.get(alias)
      if (!id) fail('D11 linked input', `draft references undeclared new alias: ${alias}`, 'add --linked new:<alias>=FILE')
      return `doc:${id}${block}`
    })
  }

  const allDrafts = [
    { id: oldId || allocateId(), primary: true, draft: input, baseRev, existing: !!oldId },
    ...preparedLinked.map((target) => ({ ...target, primary: false })),
  ]
  const nextIndex = {
    version: 1,
    tasks: { ...oldIndex.tasks, [taskId]: allDrafts[0].id },
    docs: { ...oldIndex.docs },
  }
  const pending = new Map()
  const historyWrites = []
  const output = []

  for (const target of allDrafts) {
    const targetInput = Buffer.isBuffer(target.draft) ? readText(target.draft, `draft for ${target.id}`) : String(target.draft ?? '')
    checkEncoding(targetInput, `draft for ${target.id}`)
    if (Buffer.byteLength(targetInput) > DOCS_LIMITS.docBytes) {
      fail('D07 size', `draft for ${target.id} exceeds ${DOCS_LIMITS.docBytes} bytes`, 'reduce the draft; it will not be truncated')
    }
    const source = rewriteAliases(targetInput)
    const model = draftModel(source, { primary: target.primary })
    const oldEntry = target.existing ? oldIndex.docs[target.id] : null
    let oldDocText = null
    let oldResponse = null
    let oldParsed = null
    let historySnapshot = null
    if (oldEntry) {
      oldDocText = await readFileText(root, docPath(target.id), io)
      const responseText = await readFileText(root, responsePath(target.id), io)
      if (!oldDocText || !responseText) {
        fail('D09 data', `published files for ${target.id} are incomplete`, 'restore doc.md and response.json from a complete revision')
      }
      try {
        oldResponse = validateResponseText(responseText)
        detectExistingEdit(oldDocText, target.id, oldEntry, oldResponse)
        const publishedSnapshot = await readFileText(root, historyPath(target.id, oldEntry.rev), io)
        if (publishedSnapshot && publishedSnapshot !== oldDocText) {
          fail('D10 external edit', `docs/${target.id}/doc.md differs from its published snapshot`, 'review the edit and pass --adopt-external-edit explicitly')
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
            if (stamp?.id !== target.id || stamp.rev !== oldEntry.rev) throw new Error('external document identity or revision does not match the index')
            const adopted = oldDocText.replace(/^<!--.*?-->/, `<!-- docs v1 id=${target.id} rev=${oldEntry.rev} published=${stamp.published} by=fp-docs -->`)
            validateDocText(adopted, { docId: target.id, entry: oldEntry, response: oldResponse })
            const adoptedDraft = adopted
              .split('\n')
              .slice(1)
              .filter((line) => !/^<!--\s*@b[1-9][0-9]*\s*-->$/.test(line))
              .join('\n')
            const adoptedModel = draftModel(adoptedDraft, { primary: target.primary })
            if (adoptedModel.title !== oldEntry.title) throw new Error('external document title does not match the index')
            validateLinks(adoptedModel.links, oldIndex, target.id)
            oldDocText = adopted
            historySnapshot = adopted
            oldParsed = parseDoc(adopted)
          } catch (adoptError) {
            fail('D10 external edit', adoptError.message, 'repair the external edit before adopting it')
          }
        } else if (error instanceof DocsPublisherError) throw error
        else fail('D09 data', error.message, `repair docs/${target.id} before publishing`)
      }
      if (target.baseRev != null && Number(target.baseRev) !== oldEntry.rev) {
        const flag = target.primary ? '--base-rev' : '--linked-base-rev'
        fail('D06 concurrency', `${flag} expected ${target.baseRev}, current revision is ${oldEntry.rev}`, 'read the current revision and republish')
      }
    }

    const nextRev = (oldEntry?.rev || 0) + 1
    const maxBlockId = oldEntry ? await highestUsedBlockId(root, target.id, oldParsed, io, oldEntry.nextBlockId) : 0
    const { text: docText, blocks, nextBlockId } = draftWithAnchors(model, target.id, nextRev, published, oldParsed, maxBlockId)
    const entry = {
      ...(oldEntry || {}),
      title: model.title,
      ...(target.primary ? { task: Number(task), primary: true } : { primary: false }),
      rev: nextRev,
      updatedAt: published,
      links: model.links,
      nextBlockId,
    }
    if (!target.primary) {
      delete entry.task
      delete entry.telegramUrl
    } else {
      entry.telegramUrl = entry.telegramUrl || telegramUrlFrom(journalText)
    }
    nextIndex.docs[target.id] = entry
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
    pending.set(target.id, { docText, response, entry, oldDocText, oldEntry, historySnapshot })
    output.push({ id: target.id, rev: nextRev, blocks, index: nextIndex, docText, response })
    if (oldDocText) {
      historyWrites.push({ path: path.join(root, historyPath(target.id, oldEntry.rev)), content: historySnapshot || oldDocText })
    }
    historyWrites.push({ path: path.join(root, historyPath(target.id, nextRev)), content: docText })
  }

  for (const [docId, entry] of Object.entries(nextIndex.docs)) {
    if (entry.links.some((link) => !nextIndex.docs[link])) {
      fail('D04 link', `${docId} links to a missing document`, 'publish the target or remove the link')
    }
  }
  for (const target of allDrafts) {
    const staged = pending.get(target.id)
    try {
      validateDocText(staged.docText, { docId: target.id, entry: staged.entry, response: staged.response })
      validateResponseText(JSON.stringify(staged.response))
    } catch (error) {
      if (/D07 size/.test(error.message)) fail('D07 size', error.message.replace(/^D07 size:\s*/, ''), 'reduce published data')
      fail('D09 data', error.message, 'repair the named field before publishing')
    }
  }
  try {
    validateIndexText(encodeIndex(nextIndex))
  } catch (error) {
    if (/D07 size/.test(error.message)) fail('D07 size', error.message, 'reduce docs/index.json')
    fail('D09 data', error.message, 'repair the Docs index before publishing')
  }
  for (const primaryId of Object.values(nextIndex.tasks)) {
    await ensureReviewSetSize(root, nextIndex, primaryId, io, pending)
  }

  const changes = [
    ...historyWrites,
    ...allDrafts.map((target) => ({
      path: path.join(root, docPath(target.id)),
      content: pending.get(target.id).docText,
    })),
    ...allDrafts.map((target) => ({
      path: path.join(root, responsePath(target.id)),
      content: `${JSON.stringify(pending.get(target.id).response, null, 2)}\n`,
    })),
    { path: path.join(root, 'docs/index.json'), content: encodeIndex(nextIndex) },
  ]
  await writeAtomically(changes, { io })
  for (const target of allDrafts) await trimHistory(root, target.id, io)
  return { ...output[0], linked: output.slice(1) }
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
  const readLoad = journalReadLoad(journalText, threshold ?? await catchupThreshold(root, io))
  const { index } = await loadIndex(root, io)
  const primaryId = index.tasks[taskId] || null
  const primary = primaryId ? index.docs[primaryId] : null
  const docs = []
  let openCount = 0
  let reviewSetBytes = 0
  if (primaryId) {
    for (const id of reviewSet(index, primaryId, 3)) {
      const entry = index.docs[id]
      const [docText, reviewText, responseText] = await Promise.all([
        readFileText(root, docPath(id), io),
        readFileText(root, reviewPath(id), io),
        readFileText(root, responsePath(id), io),
      ])
      try {
        const review = validateReviewText(reviewText)
        const response = validateResponseText(responseText)
        if (!docText) fail('D04 link', `linked document ${id} is missing`, 'publish the target or remove the link')
        validateDocText(docText, { docId: id, entry, response })
        reviewSetBytes += docBodyByteLength(docText)
        if (reviewSetBytes > DOCS_LIMITS.reviewSetBytes) {
          fail('D07 size', `task review set exceeds ${DOCS_LIMITS.reviewSetBytes} bytes`, 'reduce the linked documents')
        }
        const state = deriveDocState({ entry, review, response })
        openCount += state.openCount
        docs.push({
          id,
          rev: entry.rev,
          state: state.state,
          readRev: state.readRev,
          unread: state.unread,
          readStatus: state.unread ? 'unread' : 'read',
          openCount: state.openCount,
          needsYou: state.needsYou,
        })
      } catch (error) {
        if (error instanceof DocsPublisherError) throw error
        if (/D07 size/.test(error.message)) fail('D07 size', error.message, `reduce docs/${id}`)
        fail('D09 data', error.message, `repair docs/${id} before reading status`)
      }

    }
  }
  return {
    task: Number(task),
    journal: readLoad,
    threshold: readLoad.reached ? 'reached' : 'not reached',
    primary: primary ? { id: primaryId, rev: primary.rev, title: primary.title, ...docs[0] } : null,
    linkedDocs: docs.slice(1),
    docs,
    openCount,
  }
}

async function catchupThreshold(root, io) {
  const settings = await readFileText(root, 'user-settings.md', io)
  const configured = settings?.match(/Catch-up doc threshold[^0-9]{0,24}([1-9][0-9]*)/i)?.[1]
  const parsed = Number(configured)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
