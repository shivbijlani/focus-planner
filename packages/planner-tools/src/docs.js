// Docs (native catch-up documents) for agents over OneDrive (#836 follow-up).
//
// The draft -> comment -> better draft loop: the user comments on a published
// Docs revision from the Docs app; an agent reads the comments, publishes the
// next revision with a disposition per comment, and leaves a journal pointer.
//
// Nothing here re-implements the Docs format. Every read and publish runs the
// sanctioned publisher (`packages/docs-publisher`) and `docs-core`, unchanged,
// against an in-memory view of the OneDrive files (`SnapshotIo`). The publish
// becomes the exact set of files it would have written, which the normal plan
// loop turns into conditional Graph PUTs (If-Match / If-None-Match: *). The
// publisher's local process lock is replaced by those preconditions.
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  docPath, historyPath, parseDoc, parseDocHeader, extractDocLinks, deriveDocState, responsePath, reviewPath,
  validateIndexText, validateResponseText, validateReviewText, reviewSet,
} from '../../docs-core/src/index.js'
import {
  DocsPublisherError, publishUnlocked, readComments, readStatus,
} from '../../docs-publisher/src/publisher.js'
import { ToolError, requireValue } from './errors.js'
import { DOCS_INDEX, isReadable, journalPath } from './paths.js'

export const DOCS_APP_URL = 'https://plannermd.com/docs.html'
const ROOT = '/planner'

export const docUrl = (id) => `${DOCS_APP_URL}#/d/${id}`

function enoent(name) {
  const error = new Error(`ENOENT: ${name}`)
  error.code = 'ENOENT'
  return error
}

/**
 * A `fs.promises`-shaped view of OneDrive snapshots for the publisher.
 *
 * Reads of files that were not fetched yet are answered as missing and
 * recorded; the caller then asks for all of them at once (`missing`) and
 * re-runs, so a plan never rests on a guessed read. Writes land in an overlay;
 * `changes()` lists the files whose final content differs from OneDrive.
 */
export class SnapshotIo {
  constructor(snapshots, { historyFilter } = {}) {
    this.snapshots = snapshots
    this.overlay = new Map()
    this.temps = new Map()
    this.order = []
    this.missing = new Set()
    this.historyFilter = historyFilter
  }

  name(file) {
    const normalized = String(file).replace(/\\/g, '/')
    const prefix = `${ROOT}/`
    if (!normalized.startsWith(prefix)) throw new ToolError('POLICY_DENIED', 'Docs access outside the planner folder.')
    return normalized.slice(prefix.length)
  }

  text(name) {
    if (this.overlay.has(name)) return this.overlay.get(name)
    if (this.temps.has(name)) return this.temps.get(name)
    // Configuration (user-settings.md, agent-gate.md, ...) is never readable: the
    // publisher sees it as absent and uses its defaults (e.g. the 1,500-word threshold).
    if (!isReadable(name)) return null
    if (!Object.hasOwn(this.snapshots, name)) {
      this.missing.add(name)
      return null
    }
    return this.snapshots[name].content
  }

  put(name, content) {
    if (!this.order.includes(name)) this.order.push(name)
    this.overlay.set(name, content)
  }

  async readFile(file) {
    const value = this.text(this.name(file))
    if (value == null) throw enoent(file)
    return Buffer.from(value, 'utf8')
  }

  async writeFile(file, content) {
    const name = this.name(file)
    if (!/\.tmp-/.test(name) && !/\.restore-/.test(name)) throw new ToolError('POLICY_DENIED', `Unexpected direct write to ${name}.`)
    this.temps.set(name, Buffer.isBuffer(content) ? content.toString('utf8') : String(content))
  }

  async rename(from, to) {
    const source = this.name(from)
    const target = this.name(to)
    if (!this.temps.has(source)) throw enoent(from)
    this.put(target, this.temps.get(source))
    this.temps.delete(source)
  }

  async rm(file) {
    const name = this.name(file)
    if (this.temps.delete(name)) return
    throw new ToolError('POLICY_DENIED', `Planner tools never delete ${name}.`)
  }

  async readdir(dir) {
    const name = `${this.name(dir).replace(/\/$/, '')}/`
    const created = this.order.filter(n => n.startsWith(name)).map(n => n.slice(name.length))
    const existing = (this.historyFilter?.(name) || []).filter(n => this.text(`${name}${n}`) != null)
    const names = [...new Set([...existing, ...created])]
    if (!names.length) throw enoent(dir)
    return names
  }

  async stat() { return {} }
  async mkdir() {}
  async rmdir() {}

  changes() {
    return this.order
      .filter(name => this.overlay.get(name) !== (this.snapshots[name]?.content ?? null))
      .map(name => ({ name, content: this.overlay.get(name) }))
  }
}

function needReads(io) {
  if (io.missing.size) throw new ToolError('NEEDS_READS', 'More files are needed.', [...io.missing])
}

function docsIndex(snapshots) {
  if (!Object.hasOwn(snapshots, DOCS_INDEX)) throw new ToolError('NEEDS_READS', 'Docs index needed.', [DOCS_INDEX])
  const text = snapshots[DOCS_INDEX].content
  if (text == null) return null
  try {
    return validateIndexText(text)
  } catch (error) {
    throw new ToolError('DOCS_DATA', `docs/index.json is invalid (${error.message}); open the Docs app or run fp-docs to repair it.`)
  }
}

function requireDocs(snapshots) {
  const index = docsIndex(snapshots)
  if (!index) throw new ToolError('DOCS_DISABLED', 'Docs is not enabled in this planner (no docs/index.json). Ask the user to enable Docs.')
  return index
}

/**
 * The files a task's Docs review set needs, so one round fetches them together
 * instead of the publisher discovering them one by one.
 */
function reviewSetFiles(index, taskId) {
  const primary = index.tasks[taskId]
  const ids = primary ? reviewSet(index, primary, 3) : []
  return [journalPath(taskId), ...ids.flatMap(id => [docPath(id), reviewPath(id), responsePath(id), historyPath(id, index.docs[id].rev)])]
}

function prefetch(snapshots, names) {
  const missing = names.filter(name => isReadable(name) && !Object.hasOwn(snapshots, name))
  if (missing.length) throw new ToolError('NEEDS_READS', 'Docs files needed.', missing)
}

function publisherError(error) {
  if (error instanceof DocsPublisherError) {
    return new ToolError('DOCS_REFUSED', error.message, { publisherCode: error.code })
  }
  return error
}

/** Editable Markdown for a published body: the title and blocks without stamps or block anchors. */
export function draftSource(docText) {
  const parsed = parseDoc(docText)
  return `# ${parsed.title}\n\n${parsed.blocks.map(b => b.lines.join('\n')).join('\n\n')}\n`
}

function blockList(docText) {
  return parseDoc(docText).blocks.map((b, i) => ({
    id: b.id,
    ordinal: i + 1,
    kind: b.kind,
    preview: b.lines.join(' ').replace(/\s+/g, ' ').slice(0, 160),
  }))
}

const historyOnlyCurrent = (index) => (dir) => {
  const id = dir.match(/^docs\/(d-[a-z0-9]+)\/history\/$/)?.[1]
  const entry = id && index?.docs[id]
  return entry ? [`r${String(entry.rev).padStart(4, '0')}.md`] : []
}

function taskIdArg(value) {
  const id = typeof value === 'number' ? String(value) : value
  requireValue(typeof id === 'string' && /^\d{1,6}$/.test(id.trim()), 'taskId must be a task number such as "356" (use find_tasks to look it up).')
  return String(Number(id.trim()))
}

// ── docs_read ──────────────────────────────────────────────────────────────

const READ_GUIDANCE = 'Address every open comment: edit the draft text the comment points at (anchor.quote in that doc) and reply in prose in the doc itself. Then call docs_publish with each doc\'s full revised draft, its baseRev, and one disposition per comment (answered/done/declined resolve it; needs-you asks the user back). Never claim the draft is updated until docs_publish returns already_applied.'

export const docsRead = {
  readOnly: true,
  needs: () => [DOCS_INDEX],
  async compute(args, snapshots) {
    const taskId = taskIdArg(args.taskId)
    const index = requireDocs(snapshots)
    prefetch(snapshots, reviewSetFiles(index, taskId))
    const io = new SnapshotIo(snapshots, { historyFilter: historyOnlyCurrent(index) })
    let status
    let comments
    try {
      status = await readStatus({ root: ROOT, task: taskId, io })
      comments = await readComments({ root: ROOT, task: taskId, io })
    } catch (error) {
      needReads(io)
      throw publisherError(error)
    }
    needReads(io)
    const includeDrafts = args.includeDrafts !== false
    const docs = status.docs.map((doc) => {
      const text = io.text(docPath(doc.id))
      const entry = index.docs[doc.id]
      return {
        id: doc.id,
        title: entry.title,
        primary: !!entry.primary,
        rev: doc.rev,
        url: docUrl(doc.id),
        state: doc.state,
        pendingReviews: doc.pendingReviews,
        openComments: doc.openCount,
        needsYou: doc.needsYou,
        links: entry.links,
        ...(includeDrafts ? { draft: draftSource(text), blocks: blockList(text) } : {}),
      }
    })
    return {
      taskId,
      enabled: true,
      primary: status.primary ? { id: status.primary.id, title: status.primary.title, rev: status.primary.rev, url: docUrl(status.primary.id) } : null,
      journalWords: status.journal.words,
      threshold: status.threshold,
      openComments: status.openCount,
      docs,
      comments: comments.docs.map(d => ({
        doc: d.id,
        title: d.title,
        rev: d.rev,
        comments: d.comments.map(c => ({
          id: c.id, state: c.state, intent: c.intent, body: c.body, quote: c.anchor?.quote,
          block: c.placement?.block ?? c.anchor?.block, outdated: c.placement?.status === 'outdated',
          reviewId: c.reviewId, createdAt: c.createdAt,
        })),
      })),
      guidance: status.primary ? READ_GUIDANCE : 'This task has no Docs document yet. Create one with docs_publish (draft = the full catch-up, plus linked supporting drafts).',
    }
  },
}

// ── docs_publish ───────────────────────────────────────────────────────────

function textArg(value, field, max) {
  requireValue(typeof value === 'string' && value.trim() && value.length <= max, `${field} must be non-empty text of at most ${max} characters.`)
  return value.replace(/\r\n?/g, '\n')
}

function linkedArg(value) {
  if (value == null) return []
  requireValue(Array.isArray(value) && value.length <= 20, 'linked must be an array of at most 20 supporting drafts.')
  return value.map((item, i) => {
    requireValue(item && typeof item === 'object', `linked[${i}] must be an object.`)
    const draft = textArg(item.draft, `linked[${i}].draft`, 262144)
    if (item.alias != null) {
      requireValue(item.id == null, `linked[${i}] takes either alias (new doc) or id (existing doc), not both.`)
      return { alias: item.alias, draft }
    }
    requireValue(typeof item.id === 'string' && Number.isInteger(item.baseRev), `linked[${i}] updating an existing doc needs id and baseRev (from docs_read).`)
    return { id: item.id, baseRev: item.baseRev, draft }
  })
}

function dispositionsArg(value) {
  if (value == null) return []
  requireValue(Array.isArray(value) && value.length <= 500, 'dispositions must be an array.')
  return value.map((d, i) => {
    requireValue(d && typeof d === 'object' && typeof d.id === 'string', `dispositions[${i}] needs the comment id.`)
    requireValue(Array.isArray(d.blocks) && d.blocks.length && d.blocks.every(b => typeof b === 'string'), `dispositions[${i}].blocks must list the response block ids ("bN") or draft ordinals ("@N").`)
    return {
      ...(d.doc ? { doc: String(d.doc) } : {}),
      id: d.id,
      status: d.status,
      blocks: d.blocks,
      ...(d.note != null ? { note: String(d.note).slice(0, 500) } : {}),
    }
  })
}

/**
 * Make a set of Docs files consistent again after an interrupted publish.
 * The publisher writes history, doc.md, response.json, then index.json; Graph
 * has no multi-file transaction, so an interruption can leave a body or a
 * response one revision ahead of the index. A body written without its
 * response is rolled back to its history snapshot; a body and response written
 * without the index are rolled forward into the index. Anything else is left
 * for a human (DOCS_TORN), never guessed.
 */
function repairTorn(io, index) {
  let next = null
  for (const [id, entry] of Object.entries(index.docs)) {
    const docText = io.text(docPath(id))
    const responseText = io.text(responsePath(id))
    if (docText == null || responseText == null) continue
    const docRev = parseDocHeader(docText)?.rev
    let response
    try { response = validateResponseText(responseText) } catch { continue }
    if (docRev === entry.rev && response.rev === entry.rev) continue
    if (docRev === entry.rev + 1 && response.rev === entry.rev) {
      const snapshot = io.text(historyPath(id, entry.rev))
      if (snapshot == null) throw new ToolError('DOCS_TORN', `docs/${id} is one revision ahead of its response and has no history snapshot; repair it with fp-docs.`)
      io.put(docPath(id), snapshot)
      continue
    }
    if (docRev === entry.rev + 1 && response.rev === entry.rev + 1) {
      const parsed = parseDoc(docText)
      const review = validateReviewText(io.text(reviewPath(id)))
      const maxBlock = Math.max(0, ...parsed.blocks.map(b => Number(b.id.slice(1)) || 0))
      next = next || structuredClone(index)
      const repaired = {
        ...entry,
        title: parsed.title,
        rev: response.rev,
        updatedAt: parseDocHeader(docText).published || response.revisions[0].at,
        links: extractDocLinks(docText),
        nextBlockId: Math.max(entry.nextBlockId || 1, maxBlock + 1),
      }
      if (entry.primary) repaired.openDispositions = { 'needs-you': deriveDocState({ entry: repaired, review, response }).needsYou }
      next.docs[id] = repaired
      continue
    }
    throw new ToolError('DOCS_TORN', `docs/${id} body r${docRev}, response r${response.rev} and index r${entry.rev} disagree; repair it with fp-docs before publishing.`)
  }
  if (next) io.put(DOCS_INDEX, `${JSON.stringify(next, null, 2)}\n`)
  return next || index
}

function findOperation(io, index, taskId, operationId) {
  const primary = index.tasks[taskId]
  if (!primary) return null
  const response = io.text(responsePath(primary))
  if (response == null) return null
  const parsed = validateResponseText(response)
  const revision = parsed.revisions.find(r => r.op === operationId)
  if (!revision || parsed.rev !== index.docs[primary].rev) return null
  return { id: primary, rev: revision.rev, title: index.docs[primary].title, current: revision.rev === parsed.rev }
}

/** Claim submitted reviews the agent is answering (the Docs app shows "Working"). */
function acknowledgePending(io, index, primaryId) {
  for (const id of reviewSet(index, primaryId, 3)) {
    const reviewText = io.text(reviewPath(id))
    const responseText = io.text(responsePath(id))
    if (reviewText == null || responseText == null) continue
    const review = validateReviewText(reviewText)
    const response = validateResponseText(responseText)
    const { pendingReviews } = deriveDocState({ entry: index.docs[id], review, response })
    if (!pendingReviews.length) continue
    io.put(responsePath(id), `${JSON.stringify({ ...response, ackedReview: pendingReviews.at(-1) }, null, 2)}\n`)
  }
}

const WRITE_RANK = (name) => (/\/history\//.test(name) ? 0 : name.endsWith('/doc.md') ? 1 : name.endsWith('/response.json') ? 2 : name === DOCS_INDEX ? 3 : 4)

export function makeDocsPublish({ appendJournal, operationIdArg, authorArg, timeZoneArg }) {
  return {
    needs: (args) => [DOCS_INDEX, ...docsNeedsJournal(args)],
    async compute(args, snapshots, ctx) {
      const operationId = operationIdArg(args.operationId)
      const taskId = taskIdArg(args.taskId)
      const summary = textArg(args.summary, 'summary', 500).trim()
      const author = args.author == null ? null : authorArg(args.author)
      const timeZone = author ? timeZoneArg(args.timeZone) : null
      const linked = linkedArg(args.linked)
      const dispositions = dispositionsArg(args.dispositions)
      const partial = args.partial === true
      const reason = partial ? textArg(args.reason, 'reason', 500) : ''
      const index0 = requireDocs(snapshots)
      const primaryId = index0.tasks[taskId] || null
      const linkedFiles = linked.filter(l => l.id && index0.docs[l.id]).flatMap(l => [docPath(l.id), responsePath(l.id), reviewPath(l.id), historyPath(l.id, index0.docs[l.id].rev)])
      prefetch(snapshots, [...reviewSetFiles(index0, taskId), ...linkedFiles])

      const io = new SnapshotIo(snapshots, { historyFilter: historyOnlyCurrent(index0) })
      let result
      try {
        const index = repairTorn(io, index0)
        const done = findOperation(io, index, taskId, operationId)
        if (done) {
          result = { taskId, doc: done.id, rev: done.rev, url: docUrl(done.id), title: done.title, linked: [] }
        } else {
          if (primaryId) {
            requireValue(Number.isInteger(args.baseRev), 'baseRev is required when the task already has a Docs document: pass the primary rev from docs_read, so a newer revision is never overwritten.')
            acknowledgePending(io, index, primaryId)
          }
          const draft = args.draft == null
            ? (primaryId ? draftSource(io.text(docPath(primaryId)) ?? '') : null)
            : textArg(args.draft, 'draft', 262144)
          requireValue(draft, 'draft is required for a task\'s first Docs document.')
          let counter = 0
          const published = await publishUnlocked({
            root: ROOT, io, task: taskId, draft, summary, baseRev: args.baseRev, linked, dispositions, partial, reason,
            force: args.force === true, operation: operationId, now: ctx.now,
            makeId: () => `d-${createHash('sha256').update(`${operationId}:${counter++}`).digest('hex').slice(0, 10)}`,
          })
          result = {
            taskId, doc: published.id, rev: published.rev, url: docUrl(published.id),
            title: published.index.docs[published.id].title,
            linked: published.linked.map(l => ({ doc: l.id, rev: l.rev, url: docUrl(l.id), title: published.index.docs[l.id].title })),
          }
        }
      } catch (error) {
        needReads(io)
        throw publisherError(error)
      }
      needReads(io)
      const writes = io.changes()
        .sort((a, b) => WRITE_RANK(a.name) - WRITE_RANK(b.name))
        .map(w => ({ ...w, purpose: `Docs publish for task ${taskId}: ${w.name}` }))

      if (author) {
        const note = `Draft r${result.rev} is ready for your review: [${result.title}](${result.url}). ${summary}`
        const journal = await Promise.resolve(appendJournal.compute({
          taskId, author, text: note, timeZone, operationId: `${operationId}:j`.slice(0, 120),
        }, snapshots, ctx))
        writes.push(...journal.writes)
      }
      return {
        result: { ...result, summary },
        writes,
        appliedGuidance: `Published and verified on OneDrive. Tell the user revision ${result.rev} is ready to review at ${result.url}.`,
      }
    },
  }
}

export function docsNeedsJournal(args) {
  return args.author == null ? [] : ['planner.md', journalPath(taskIdArg(args.taskId))]
}
