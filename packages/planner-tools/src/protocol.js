import { OPERATIONS, VERSION } from './operations.js'
import { PRIORITY_ICONS } from '../../../src/focusPlanOps.js'
import { safeError } from './errors.js'
import { planTool, runTool } from './plan.js'

const taskId = { type: 'string', pattern: '^\\d{1,6}$', description: 'Task number from find_tasks, e.g. "505".' }
const operationId = { type: 'string', minLength: 16, maxLength: 120, pattern: '^[A-Za-z0-9:_-]+$', description: 'One stable ID per intended change (e.g. "muse:2026-10-21:<uuid>"); reuse it unchanged on every retry of that change.' }
const timeZone = { type: 'string', description: 'The planner owner\'s IANA time zone, e.g. "America/Los_Angeles". Dates and journal day headings use it.' }
const author = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{1,39}$', description: 'Your own lowercase agent name, e.g. "muse". Never "me".' }
const priority = { type: 'string', enum: PRIORITY_ICONS, description: '🔴 urgent+important, 🟡 important, 🔵 urgent, ⚪ low, 🐸 frog (eat first), 📖 learning.' }
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

export const TOOL_DEFINITIONS = [
  {
    name: 'find_tasks',
    description: 'READ ONLY. Mandatory first step: search the active Focus Planner board (Today/Deferred) by words or ID to get task IDs, priorities, parents and wake dates. Use it to resolve which task the user means and to avoid adding duplicates.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 200 }, section: { type: 'string', enum: ['all', 'Today', 'Deferred'] }, limit: { type: 'integer', minimum: 1, maximum: 500 },
    } },
    annotations: readOnly,
  },
  {
    name: 'get_task',
    description: 'READ ONLY. One task with its journal: recent journal text and the todo list with the index/text pairs set_todo needs.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId, journalChars: { type: 'integer', minimum: 0, maximum: 100000 } } },
    annotations: readOnly,
  },
  {
    name: 'add_task',
    description: 'Add a task row (new ID allocated like the app does). An active task with the same title is reported instead of duplicated. Optional parentId links it under another task.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['title', 'operationId', 'timeZone'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 300 }, priority, section: { type: 'string', enum: ['Today', 'Deferred'] }, parentId: taskId, operationId, timeZone,
    } },
    annotations: mutation,
  },
  {
    name: 'set_priority',
    description: 'Change a task\'s priority icon.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'priority', 'operationId'], properties: { taskId, priority, operationId } },
    annotations: mutation,
  },
  {
    name: 'move_task',
    description: 'Move a task between Today and Deferred. With wakeOn (YYYY-MM-DD) it is deferred until that date and returns to Today automatically.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'to', 'operationId', 'timeZone'], properties: {
      taskId, to: { type: 'string', enum: ['Today', 'Deferred'] }, wakeOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, operationId, timeZone,
    } },
    annotations: mutation,
  },
  {
    name: 'append_journal',
    description: 'Append a note to a task journal, attributed to you (shown as an agent bubble, never as the user). Plain Markdown; no HTML comments or #/## headings outside code fences. Creates the journal if the task has none.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'text', 'author', 'operationId', 'timeZone'], properties: {
      taskId, text: { type: 'string', minLength: 1, maxLength: 20000 }, author, operationId, timeZone,
    } },
    annotations: mutation,
  },
  {
    name: 'set_todo',
    description: 'Check or uncheck one journal todo. Pass todoIndex and the exact todoText from get_task; a changed journal returns STALE_TODO_REF with the current list.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'todoIndex', 'todoText', 'done', 'operationId'], properties: {
      taskId, todoIndex: { type: 'integer', minimum: 0 }, todoText: { type: 'string', minLength: 1 }, done: { type: 'boolean' }, operationId,
    } },
    annotations: mutation,
  },
  {
    name: 'complete_task',
    description: 'Mark a task done exactly like the app: archive row under this week, remove it from the board, re-parent its children to its parent. Optional outcome/comment is written to the journal as your note (author required then). Confirm with the user before completing.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'operationId', 'timeZone'], properties: {
      taskId, outcome: { type: 'string', maxLength: 100 }, comment: { type: 'string', maxLength: 20000 }, author, operationId, timeZone,
    } },
    annotations: { ...mutation, destructiveHint: true },
  },
]

export const BROKER_TOOL = {
  name: 'planner_plan',
  description: 'Tokenless Focus Planner transport. Performs no HTTP and takes no credentials. Call with tool (find_tasks, get_task, add_task, set_priority, move_task, append_journal, set_todo, complete_task), its arguments, and the content/id/etag snapshots you already fetched. Follow read_required by fetching the listed Graph files; follow write_required by executing the conditional PUTs in order through the secure Graph broker, then discard snapshots, re-read and call again. Only "already_applied" means a change is saved; never report write_required as done. Start every request with find_tasks.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['tool', 'arguments'],
    properties: {
      tool: { type: 'string', enum: Object.keys(OPERATIONS) },
      arguments: { type: 'object', description: 'The chosen tool\'s arguments (see `planner --help`).' },
      snapshots: { type: 'object', additionalProperties: { type: 'object' } },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}

export function protocol({ brokerMode = false, client = null } = {}) {
  return async (message) => {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } }
    }
    if (message.id === undefined) return null
    const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result })
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion
      return reply({
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'focus-planner', version: VERSION },
      })
    }
    if (message.method === 'ping') return reply({})
    if (message.method === 'tools/list') return reply({ tools: brokerMode ? [BROKER_TOOL] : TOOL_DEFINITIONS })
    if (message.method === 'tools/call') {
      const name = message.params?.name
      const known = brokerMode ? name === BROKER_TOOL.name : Object.hasOwn(OPERATIONS, name)
      if (!known) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } }
      try {
        const args = message.params.arguments || {}
        const result = brokerMode ? await planTool(args) : await runTool(client, { tool: name, arguments: args })
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false })
      } catch (error) {
        return reply({ content: [{ type: 'text', text: JSON.stringify(safeError(error)) }], isError: true })
      }
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
  }
}
