// Planner operations for agents (#836).
//
// Every operation is a pure function of file snapshots: `needs(args)` names
// the files it reads, and `compute(args, snapshots, ctx)` returns the result
// plus the ordered writes that would bring OneDrive to the requested state.
// An empty write list means the request is already applied, so the same call
// is both the planner and the post-write verifier, and retries are safe.
//
// All Markdown changes go through the UI's own modules (focusPlanOps.js,
// journalChat.js) and the sync engine's record codec/merge metadata; nothing
// here re-implements board or journal formatting.
import { createHash } from 'node:crypto'
import {
  ACTIVE_SECTIONS,
  PRIORITY_ICONS,
  findTasksById,
  listBoardTasks,
  opAddTask,
  opBridgeLinks,
  opCompleteTask,
  opMoveBetweenSections,
  opSetTaskPriority,
  opSnoozeTask,
  taskIdFromCell,
} from '../../../src/focusPlanOps.js'
import {
  appendJournalMessage,
  buildNewJournal,
  fencedLineMask,
  formatCloseOutComment,
  listToggleableTodos,
  localISODate,
  parseJournalChat,
  parseTodos,
  setTodoDone,
} from '../../../src/journalChat.js'
import { mdTableCodec } from '../../folder-sync/src/codecs/mdTable.js'
import { fingerprint, parseSidecar, serializeSidecar } from '../../folder-sync/src/merge.js'
import { ToolError, requireValue } from './errors.js'
import { BOARD, BOARD_SIDECAR, COMPLETED, JOURNAL_DIR, TASK_SETTINGS, journalPath } from './paths.js'

export const VERSION = '1.0.0'

// ── Input validation ────────────────────────────────────────────────────────

const RESERVED_AUTHORS = new Set(['me', 'overnight-agent', 'oa', 'shiv', 'user', 'human'])

function taskIdArg(value) {
  const id = typeof value === 'number' ? String(value) : value
  requireValue(typeof id === 'string' && /^\d{1,6}$/.test(id.trim()), 'taskId must be a task number such as "505" (use find_tasks to look it up).')
  return id.trim()
}

function operationIdArg(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9:_-]{16,120}$/.test(value),
    'operationId must be 16-120 characters of letters, digits, ":", "_" or "-". Create one per intended change (e.g. "muse:2026-10-21:<uuid>") and reuse it unchanged on retries.')
  requireValue(!/(?:^|[^A-Za-z0-9])(?:auto|agent)(?:$|[^A-Za-z0-9])/i.test(value), 'operationId must not contain the words "auto" or "agent" (they are journal block sentinels).')
  return value
}

function authorArg(value) {
  requireValue(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(value),
    'author must be your lowercase agent name, e.g. "muse" (2-40 of a-z, 0-9, "_" or "-").')
  requireValue(!RESERVED_AUTHORS.has(value), `author "${value}" is reserved. Agents write as themselves; only the human writes as "me", and Overnight Agent turns go through its own write-turn tool.`)
  return value
}

function timeZoneArg(value) {
  requireValue(typeof value === 'string' && value.length > 0, 'timeZone is required for changes: the planner owner\'s IANA zone, e.g. "America/Los_Angeles".')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    throw new ToolError('INVALID_INPUT', 'timeZone must be a valid IANA zone such as "America/Los_Angeles".')
  }
  return value
}

function singleLine(value, field, max) {
  requireValue(typeof value === 'string' && value.trim() && value.length <= max && !/[\r\n|]/.test(value) && !value.includes('<!--'),
    `${field} must be a single line of at most ${max} characters without "|" or HTML comments.`)
  return value.trim()
}

/**
 * Agent prose for a journal. Fenced code is quoted text; outside fences the body
 * must not contain markup that other readers treat as structure or provenance:
 * HTML comments (from:/oa-by:/oa-ask:/sentinels) or `#`/`##` headings (titles and
 * day groups). That is what keeps an agent note from posing as Shiv's approval.
 */
function journalTextArg(value, field = 'text') {
  requireValue(typeof value === 'string' && value.trim() && value.length <= 20000, `${field} must be non-empty Markdown of at most 20000 characters.`)
  const text = value.replace(/\r\n?/g, '\n').trim()
  const lines = text.split('\n')
  const mask = fencedLineMask(lines)
  lines.forEach((line, i) => {
    if (mask[i]) return
    requireValue(!line.includes('<!--') && !line.includes('-->'), `${field} must not contain HTML comments outside code fences (they carry journal attribution).`)
    requireValue(!/^\s{0,3}#{1,2}(\s|$)/.test(line), `${field} must not contain "#" or "##" headings outside code fences (they start journal titles and days). Use "###" or bold text.`)
  })
  return text
}

function dateArg(value, field) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, `${field} must be a valid YYYY-MM-DD date.`)
  return value
}

function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

// ── Snapshot access ─────────────────────────────────────────────────────────

function content(snapshots, name) {
  return snapshots[name]?.content ?? null
}

function requireBoard(snapshots) {
  const board = content(snapshots, BOARD)
  if (board == null || !/^##\s+Today\b/m.test(board)) {
    throw new ToolError('BOARD_UNAVAILABLE', 'planner.md was not found or has no "## Today" section. Check that the Graph token belongs to the Focus Planner app (its app folder is Apps/Focus Planner).')
  }
  return board
}

function oneTask(board, taskId) {
  const found = findTasksById(board, taskId)
  if (found.length > 1) throw new ToolError('DUPLICATE_TASK_ID', `Task ${taskId} appears ${found.length} times on the board; a human must repair it before agents change it.`)
  return found[0] ?? null
}

function publicTask(t, board) {
  const linked = (t.linkedId || '').trim()
  const parentId = /^\d+$/.test(linked) ? linked : null
  const parent = parentId ? findTasksById(board, parentId)[0] : null
  return {
    id: t.id,
    section: t.section,
    priority: t.priority,
    title: t.title,
    added: t.added || null,
    wake: t.wake || null,
    parentId,
    parentTitle: parent ? parent.title : null,
    ...(linked && !parentId && linked !== '-' ? { linkedValue: linked } : {}),
  }
}

const OP_MARKER_RE = /<!--\s*planner-op:\s*([A-Za-z0-9:_-]+)\s+([0-9a-f]{16})\s*-->/g

function opMarker(operationId, hash) {
  return `<!-- planner-op: ${operationId} ${hash} -->`
}

/** True when the journal already carries this operation; a reused ID with other input is a conflict. */
function journalHasOperation(journal, operationId, hash) {
  if (!journal) return false
  for (const m of journal.matchAll(OP_MARKER_RE)) {
    if (m[1] !== operationId) continue
    if (m[2] !== hash) throw new ToolError('OPERATION_CONFLICT', 'This operationId was already used for a different change. Use a new operationId for a new change.')
    return true
  }
  return false
}

function completedIds(completed) {
  const ids = new Set()
  for (const line of String(completed ?? '').split('\n')) {
    const m = line.match(/^\s*\|\s*([^|]+?)\s*\|/)
    const id = m && taskIdFromCell(m[1])
    if (id) ids.add(Number(id))
  }
  return ids
}

/** IDs a new task must not take: journals, per-task settings, archived tasks and sync records. */
function reservedIds(snapshots) {
  const ids = new Set()
  for (const name of snapshots[JOURNAL_DIR]?.names ?? []) {
    const m = String(name).match(/^task-(\d+)\.md$/)
    if (m) ids.add(Number(m[1]))
  }
  try {
    const settings = JSON.parse(content(snapshots, TASK_SETTINGS) || '{}')
    const tasks = settings && typeof settings === 'object' ? (settings.tasks && typeof settings.tasks === 'object' ? settings.tasks : settings) : {}
    for (const key of Object.keys(tasks)) if (/^\d+$/.test(key)) ids.add(Number(key))
  } catch { /* unreadable settings reserve nothing extra */ }
  for (const id of completedIds(content(snapshots, COMPLETED))) ids.add(id)
  for (const key of Object.keys(sidecarMeta(snapshots))) if (/^\d+$/.test(key)) ids.add(Number(key))
  return ids
}

function sidecarMeta(snapshots) {
  const raw = content(snapshots, BOARD_SIDECAR)
  if (raw == null) return {}
  try {
    return parseSidecar(raw, { strict: true })
  } catch (e) {
    throw new ToolError('INVALID_DATA', `planner.md.sync.json is unreadable (${e.message}); open the Planner app to repair sync before agents change the board.`)
  }
}

/**
 * Tombstone the board rows a change removes, in the sync sidecar.
 *
 * The app's sync engine never infers a delete from a row missing in the cloud
 * copy (that is what stops stale replicas erasing tasks), so a removal written
 * only to planner.md would be resurrected by the next device sync. Writing the
 * tombstone first, with the removed row's fingerprint, makes the app drop the
 * row itself even if it syncs between the two writes. Adds and edits need no
 * sidecar change: the app detects them from content fingerprints.
 */
function tombstoneRemovedRows(snapshots, before, after, now) {
  if (snapshots[BOARD_SIDECAR]?.content == null) return null
  const meta = sidecarMeta(snapshots)
  const prior = mdTableCodec.parse(before).records
  const next = mdTableCodec.parse(after).records
  let changed = false
  for (const id of Object.keys(prior)) {
    if (id in next) continue
    const fp = fingerprint(prior[id])
    if (meta[id]?.deleted && meta[id].fp === fp) continue
    meta[id] = { clock: now, deleted: true, fp }
    changed = true
  }
  return changed ? serializeSidecar(meta, now) : null
}

function withTimeZone(timeZone, fn) {
  if (!timeZone) return fn()
  const previous = process.env.TZ
  process.env.TZ = timeZone
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

// ── Operations ──────────────────────────────────────────────────────────────

const FIND_GUIDANCE = 'Use these IDs for changes. Before add_task, check that the task is not already here (search alternate wording). Always confirm which task the user means when several match.'

const findTasks = {
  readOnly: true,
  needs: () => [BOARD],
  compute(args, snapshots) {
    const board = requireBoard(snapshots)
    const query = args.query == null ? '' : String(args.query).trim().toLowerCase()
    requireValue(query.length <= 200, 'query must be at most 200 characters.')
    const section = args.section ?? 'all'
    requireValue(['all', ...ACTIVE_SECTIONS].includes(section), 'section must be "Today", "Deferred" or "all".')
    const limit = args.limit ?? 100
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 500, 'limit must be 1-500.')
    const all = listBoardTasks(board, section === 'all' ? ACTIVE_SECTIONS : [section])
    const words = query.split(/\s+/).filter(Boolean)
    const matches = all.filter(t => !words.length || t.id === query ||
      words.every(w => t.title.toLowerCase().includes(w)))
    return {
      total: matches.length,
      tasks: matches.slice(0, limit).map(t => publicTask(t, board)),
      guidance: FIND_GUIDANCE,
    }
  },
}

const getTask = {
  readOnly: true,
  needs: (args) => [BOARD, COMPLETED, journalPath(taskIdArg(args.taskId))],
  compute(args, snapshots) {
    const taskId = taskIdArg(args.taskId)
    const board = requireBoard(snapshots)
    const maxChars = args.journalChars ?? 6000
    requireValue(Number.isInteger(maxChars) && maxChars >= 0 && maxChars <= 100000, 'journalChars must be 0-100000.')
    const task = oneTask(board, taskId)
    const archived = completedIds(content(snapshots, COMPLETED)).has(Number(taskId))
    const journal = content(snapshots, journalPath(taskId))
    if (!task && !archived && journal == null) throw new ToolError('TASK_NOT_FOUND', `Task ${taskId} is not on the board, in the completed list or in the journal folder.`)
    return {
      task: task ? publicTask(task, board) : null,
      archived,
      journal: journal == null ? { exists: false } : {
        exists: true,
        title: parseJournalChat(journal).title,
        todos: listToggleableTodos(journal).map(({ index, text, done }) => ({ index, text, done })),
        length: journal.length,
        content: maxChars === 0 ? '' : journal.slice(Math.max(0, journal.length - maxChars)),
        truncated: journal.length > maxChars,
      },
      guidance: 'Todo "index" values are what set_todo takes, together with the exact todo text.',
    }
  },
}

const addTask = {
  needs: () => [BOARD, BOARD_SIDECAR, COMPLETED, TASK_SETTINGS, JOURNAL_DIR],
  compute(args, snapshots) {
    operationIdArg(args.operationId)
    timeZoneArg(args.timeZone)
    const title = singleLine(args.title, 'title', 300)
    const priority = args.priority ?? '🟡'
    requireValue(PRIORITY_ICONS.includes(priority), `priority must be one of ${PRIORITY_ICONS.join(' ')}.`)
    const section = args.section ?? 'Today'
    requireValue(ACTIVE_SECTIONS.includes(section), 'section must be "Today" or "Deferred".')
    const parentId = args.parentId == null || args.parentId === '' ? '' : taskIdArg(args.parentId)
    const board = requireBoard(snapshots)
    const key = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase()
    const existing = listBoardTasks(board).find(t => key(t.title) === key(title))
    if (existing) {
      return {
        result: { taskId: existing.id, task: publicTask(existing, board), created: false,
          note: 'An active task with this exact title exists; no duplicate was added.' },
        writes: [],
      }
    }
    if (parentId) requireValue(oneTask(board, parentId), `Parent task ${parentId} is not on the board.`)
    const added = opAddTask(board, { task: title, priority, linkedTask: parentId, section }, reservedIds(snapshots))
    if (typeof added === 'string') throw new ToolError('BOARD_UNAVAILABLE', `The board has no "${section}" table to add to.`)
    return {
      result: { taskId: String(added.newId), title, section, priority, parentId: parentId || null, created: true },
      writes: [{ name: BOARD, content: added.content, purpose: `Add task ${added.newId} to ${section}` }],
    }
  },
}

const setPriority = {
  needs: () => [BOARD],
  compute(args, snapshots) {
    operationIdArg(args.operationId)
    const taskId = taskIdArg(args.taskId)
    requireValue(PRIORITY_ICONS.includes(args.priority), `priority must be one of ${PRIORITY_ICONS.join(' ')}.`)
    const board = requireBoard(snapshots)
    const task = oneTask(board, taskId)
    if (!task) throw new ToolError('TASK_NOT_FOUND', `Task ${taskId} is not on the board.`)
    const result = { taskId, priority: args.priority }
    if (task.priority === args.priority) return { result, writes: [] }
    const next = opSetTaskPriority(board, task.rawLine, args.priority)
    if (next === board) throw new ToolError('BOARD_UNAVAILABLE', `Task ${taskId}'s row has no priority cell to change.`)
    return { result, writes: [{ name: BOARD, content: next, purpose: `Set task ${taskId} priority ${task.priority} -> ${args.priority}` }] }
  },
}

const moveTask = {
  needs: () => [BOARD],
  compute(args, snapshots) {
    operationIdArg(args.operationId)
    timeZoneArg(args.timeZone)
    const taskId = taskIdArg(args.taskId)
    const to = args.to
    requireValue(ACTIVE_SECTIONS.includes(to), 'to must be "Today" or "Deferred".')
    const wakeOn = args.wakeOn == null ? null : dateArg(args.wakeOn, 'wakeOn')
    requireValue(!wakeOn || to === 'Deferred', 'wakeOn is only valid when moving to Deferred.')
    const board = requireBoard(snapshots)
    const task = oneTask(board, taskId)
    if (!task) throw new ToolError('TASK_NOT_FOUND', `Task ${taskId} is not on the board.`)
    const result = { taskId, section: to, wakeOn }
    if (task.section === to && (!wakeOn || task.wake === wakeOn)) return { result, writes: [] }
    const next = wakeOn
      ? opSnoozeTask(board, task.rawLine, wakeOn)
      : opMoveBetweenSections(board, task.rawLine, task.section, to)
    if (next === board) throw new ToolError('BOARD_UNAVAILABLE', `The board has no "${to}" table to move task ${taskId} into.`)
    return { result, writes: [{ name: BOARD, content: next, purpose: `Move task ${taskId} ${task.section} -> ${to}${wakeOn ? ` (wake ${wakeOn})` : ''}` }] }
  },
}

function journalBase(snapshots, board, taskId) {
  const existing = content(snapshots, journalPath(taskId))
  if (existing != null) return { text: existing, created: false }
  const task = oneTask(board, taskId)
  if (!task) throw new ToolError('TASK_NOT_FOUND', `Task ${taskId} is not on the board and has no journal.`)
  return { text: buildNewJournal(taskId, task.title, { todoStub: false }), created: true }
}

const appendJournal = {
  needs: (args) => [BOARD, journalPath(taskIdArg(args.taskId))],
  compute(args, snapshots, ctx) {
    const operationId = operationIdArg(args.operationId)
    const timeZone = timeZoneArg(args.timeZone)
    const taskId = taskIdArg(args.taskId)
    const author = authorArg(args.author)
    const text = journalTextArg(args.text)
    const hash = requestHash({ tool: 'append_journal', taskId, author, text })
    const name = journalPath(taskId)
    const result = { taskId, journal: name, author, operationId }
    if (journalHasOperation(content(snapshots, name), operationId, hash)) return { result, writes: [] }
    const board = requireBoard(snapshots)
    const base = journalBase(snapshots, board, taskId)
    const next = withTimeZone(timeZone, () =>
      appendJournalMessage(base.text, `${text}\n${opMarker(operationId, hash)}`, localISODate(new Date(ctx.now)), author))
    return { result, writes: [{ name, content: next, purpose: `${base.created ? 'Create journal and append' : 'Append'} a note from ${author} to task ${taskId}` }] }
  },
}

const setTodo = {
  needs: (args) => [journalPath(taskIdArg(args.taskId))],
  compute(args, snapshots) {
    operationIdArg(args.operationId)
    const taskId = taskIdArg(args.taskId)
    requireValue(Number.isInteger(args.todoIndex) && args.todoIndex >= 0, 'todoIndex must be the index from get_task.')
    requireValue(typeof args.todoText === 'string' && args.todoText.trim(), 'todoText must be the exact todo text from get_task.')
    requireValue(typeof args.done === 'boolean', 'done must be true or false.')
    const name = journalPath(taskId)
    const journal = content(snapshots, name)
    if (journal == null) throw new ToolError('TASK_NOT_FOUND', `Task ${taskId} has no journal.`)
    const todos = listToggleableTodos(journal)
    const item = todos[args.todoIndex]
    if (!item || item.text !== args.todoText.trim()) {
      throw new ToolError('STALE_TODO_REF', 'That todo index no longer has that text; call get_task again and use the current index.',
        { todos: todos.map(({ index, text, done }) => ({ index, text, done })) })
    }
    const result = { taskId, todoIndex: item.index, todoText: item.text, done: args.done }
    if (item.done === args.done) return { result, writes: [] }
    return { result, writes: [{ name, content: setTodoDone(journal, item.index, args.done), purpose: `Mark todo "${item.text}" ${args.done ? 'done' : 'not done'} on task ${taskId}` }] }
  },
}

const completeTask = {
  needs: (args) => [BOARD, BOARD_SIDECAR, COMPLETED, journalPath(taskIdArg(args.taskId))],
  compute(args, snapshots, ctx) {
    const operationId = operationIdArg(args.operationId)
    const timeZone = timeZoneArg(args.timeZone)
    const taskId = taskIdArg(args.taskId)
    const outcome = args.outcome == null || args.outcome === '' ? '' : singleLine(args.outcome, 'outcome', 100)
    const comment = args.comment == null || args.comment === '' ? '' : journalTextArg(args.comment, 'comment')
    const closeOut = formatCloseOutComment(outcome, comment)
    const author = closeOut ? authorArg(args.author) : null
    const hash = requestHash({ tool: 'complete_task', taskId, outcome, comment, author })
    const board = requireBoard(snapshots)
    const completed = content(snapshots, COMPLETED) ?? '# Completed Tasks\n'
    const name = journalPath(taskId)
    const journal = content(snapshots, name)
    const task = oneTask(board, taskId)
    const archived = completedIds(completed).has(Number(taskId))
    if (!task && !archived) throw new ToolError('TASK_NOT_FOUND', `Task ${taskId} is not on the board or in the completed list.`)
    if (task && archived) {
      throw new ToolError('ARCHIVE_ID_CONFLICT', `Task ${taskId} is on the board and an archived task already uses ID ${taskId}; a human must resolve it.`)
    }

    const writes = []
    const bridged = []
    if (task) {
      const plan = withTimeZone(timeZone, () => {
        const nextParent = task.linkedId && task.linkedId !== '-' ? task.linkedId : ''
        for (const t of listBoardTasks(board)) if (t.linkedId === taskId) bridged.push(t.id)
        const linked = bridged.length ? opBridgeLinks(board, taskId, nextParent) : board
        const todoItems = journal == null ? [] : parseTodos(journal).map(t => t.text)
        return opCompleteTask(linked, completed, {
          rawLine: task.rawLine, fromSection: task.section, taskId, taskName: task.title,
          priority: task.workPriority || '-', todoItems, outcome,
        })
      })
      if (!plan.removed) throw new ToolError('BOARD_UNAVAILABLE', `Task ${taskId}'s row could not be removed.`)
      writes.push({ name: COMPLETED, content: plan.completed, purpose: `Archive task ${taskId}: ${plan.completedRow}` })
      if (closeOut && journal != null && !journalHasOperation(journal, operationId, hash)) {
        writes.push({ name, content: withTimeZone(timeZone, () => appendJournalMessage(journal, `${closeOut}\n${opMarker(operationId, hash)}`, localISODate(new Date(ctx.now)), author)), purpose: `Record close-out note from ${author}` })
      }
      const tombstones = tombstoneRemovedRows(snapshots, board, plan.board, ctx.now)
      if (tombstones) writes.push({ name: BOARD_SIDECAR, content: tombstones, purpose: `Tombstone task ${taskId} so app sync removes it` })
      writes.push({ name: BOARD, content: plan.board, purpose: `Remove task ${taskId} from ${task.section}${bridged.length ? `; re-parent ${bridged.join(', ')}` : ''}` })
    } else if (closeOut && journal != null && !journalHasOperation(journal, operationId, hash)) {
      writes.push({ name, content: withTimeZone(timeZone, () => appendJournalMessage(journal, `${closeOut}\n${opMarker(operationId, hash)}`, localISODate(new Date(ctx.now)), author)), purpose: `Record close-out note from ${author}` })
    }
    return {
      result: { taskId, completed: true, reparentedTaskIds: bridged, closeOutRecorded: Boolean(closeOut && journal != null), operationId },
      writes,
    }
  },
}

export const OPERATIONS = {
  find_tasks: findTasks,
  get_task: getTask,
  add_task: addTask,
  set_priority: setPriority,
  move_task: moveTask,
  append_journal: appendJournal,
  set_todo: setTodo,
  complete_task: completeTask,
}
