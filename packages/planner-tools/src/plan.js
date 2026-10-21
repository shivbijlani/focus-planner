// Tokenless broker transport and the shared plan/execute loop (#836).
//
// `planTool` never performs HTTP and never sees credentials. Given the file
// snapshots a caller already fetched, it either asks for more reads, returns a
// read result, returns the exact conditional Graph writes still needed, or
// confirms the change is already on OneDrive (`already_applied`). Muse's
// credential broker executes the returned requests by substituting the
// Authorization header on its HTTPS egress; the direct CLI/MCP mode executes
// the very same requests through `runTool`. One planning path, two executors.
import { OPERATIONS } from './operations.js'
import { ToolError, requireValue } from './errors.js'
import { JOURNAL_DIR, assertReadable, assertWritable, encodePath } from './paths.js'

export const GRAPH = 'https://graph.microsoft.com/v1.0'
export const APPROOT = `${GRAPH}/me/drive/special/approot`
export const MAX_ATTEMPTS = 6

const READ_FILE_INSTRUCTIONS = 'GET this URL through the secure Graph broker (Authorization substituted on egress). From the JSON take "id", "eTag" and "@microsoft.graph.downloadUrl"; download that URL WITHOUT any Authorization header; then GET the metadata URL again and use the content only if id and eTag are unchanged (otherwise repeat). Supply snapshots[filename] = {"content": <UTF-8 text>, "id": ..., "etag": ...}. Only a confirmed HTTP 404 becomes {"content": null, "id": null, "etag": null}.'
const READ_LIST_INSTRUCTIONS = 'GET this URL through the secure Graph broker and follow every "@odata.nextLink". Supply snapshots["journal/"] = {"names": [every value[].name]}. A confirmed HTTP 404 becomes {"names": []}.'
const AFTER_WRITE = 'Execute the writes in order, each exactly as given (UTF-8 body, keep If-Match / If-None-Match). Stop at the first non-2xx response. Afterwards, whatever happened (success, 409, 412, timeout), discard ALL snapshots, read again and call this tool again with the same tool, arguments and operationId. Only state "already_applied" means the change is saved. On 401/403 stop and ask the user to reconnect; never retry without the precondition headers.'

function readRequest(name) {
  assertReadable(name)
  if (name === JOURNAL_DIR) {
    return { filename: name, kind: 'listing', method: 'GET', url: `${APPROOT}:/journal:/children?$select=name&$top=999`, instructions: READ_LIST_INSTRUCTIONS }
  }
  return { filename: name, kind: 'file', method: 'GET', url: `${APPROOT}:/${encodePath(name)}`, instructions: READ_FILE_INSTRUCTIONS }
}

export function writeRequest(name, body, snapshot) {
  assertWritable(name)
  if (snapshot?.id) {
    requireValue(typeof snapshot.etag === 'string' && snapshot.etag, `Snapshot ${name} has an id but no eTag.`)
    return {
      method: 'PUT',
      url: `${GRAPH}/me/drive/items/${encodeURIComponent(snapshot.id)}/content`,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': snapshot.etag },
      body,
    }
  }
  return {
    method: 'PUT',
    url: `${APPROOT}:/${encodePath(name)}:/content?@microsoft.graph.conflictBehavior=fail`,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-None-Match': '*' },
    body,
  }
}

function validateSnapshots(snapshots) {
  requireValue(snapshots && typeof snapshots === 'object' && !Array.isArray(snapshots), 'snapshots must be an object keyed by filename.')
  for (const [name, snap] of Object.entries(snapshots)) {
    assertReadable(name)
    requireValue(snap && typeof snap === 'object', `Snapshot ${name} must be an object.`)
    if (name === JOURNAL_DIR) {
      requireValue(Array.isArray(snap.names) && snap.names.every(n => typeof n === 'string'), 'snapshots["journal/"] must be {"names": [..]}.')
      continue
    }
    if (snap.content === null) {
      requireValue(snap.id === null && snap.etag === null, `Snapshot ${name}: a missing file is {"content": null, "id": null, "etag": null}.`)
    } else {
      requireValue(typeof snap.content === 'string' && typeof snap.id === 'string' && snap.id &&
        typeof snap.etag === 'string' && snap.etag, `Snapshot ${name} needs content plus the Graph item "id" and "eTag" it was read with.`)
      requireValue(snap.content.length <= 5_000_000, `Snapshot ${name} is too large.`)
    }
  }
}

/** A compact before/after view of a planned write, for the caller to show the user. */
function preview(before, after) {
  const a = String(before ?? '').split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }
  const clip = (lines) => lines.length > 12 ? [...lines.slice(0, 12), `… ${lines.length - 12} more lines`] : lines
  return { removed: clip(a.slice(start, endA + 1).map(l => l.replace(/\r$/, ''))), added: clip(b.slice(start, endB + 1).map(l => l.replace(/\r$/, ''))) }
}

export async function planTool(request, { now = Date.now() } = {}) {
  requireValue(request && typeof request === 'object', 'Send {"tool": ..., "arguments": {...}, "snapshots": {...}}.')
  const { tool, arguments: args = {}, snapshots = {} } = request
  requireValue(typeof tool === 'string' && Object.hasOwn(OPERATIONS, tool), `tool must be one of ${Object.keys(OPERATIONS).join(', ')}.`)
  requireValue(args && typeof args === 'object' && !Array.isArray(args), 'arguments must be an object.')
  validateSnapshots(snapshots)
  const op = OPERATIONS[tool]
  const needs = op.needs(args)
  const missing = needs.filter(name => !Object.hasOwn(snapshots, name))
  if (missing.length) return { state: 'read_required', tool, reads: missing.map(readRequest) }

  const computed = op.readOnly
    ? { result: op.compute(args, snapshots, { now }), writes: [] }
    : op.compute(args, snapshots, { now })
  if (op.readOnly) return { state: 'read_complete', tool, result: computed.result }
  if (!computed.writes.length) {
    return { state: 'already_applied', tool, result: computed.result, guidance: 'Verified on OneDrive. You may report this change as saved.' }
  }
  return {
    state: 'write_required',
    tool,
    expectedResult: computed.result,
    writes: computed.writes.map(w => ({
      filename: w.name,
      purpose: w.purpose,
      preview: w.name.endsWith('.json') ? { summary: w.purpose } : preview(snapshots[w.name]?.content, w.content),
      request: writeRequest(w.name, w.content, snapshots[w.name]),
    })),
    afterWrite: AFTER_WRITE,
  }
}

/**
 * Direct mode: run a tool to completion with a Graph client that reads files
 * and executes write requests. Identical plans to the broker; each conflict
 * (409/412) triggers a fresh read and a fresh plan, never a resent body.
 */
export async function runTool(client, { tool, arguments: args = {} }, { now = () => Date.now() } = {}) {
  let snapshots = {}
  let planned = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const plan = await planTool({ tool, arguments: args, snapshots }, { now: now() })
    if (plan.state === 'read_required') {
      for (const read of plan.reads) snapshots[read.filename] = await client.read(read)
      attempt--
      continue
    }
    if (plan.state === 'write_required') {
      planned = planned ?? plan.expectedResult
      for (const write of plan.writes) {
        const status = await client.write(write.filename, write.request)
        if (status === 409 || status === 412) break
      }
      snapshots = {}
      continue
    }
    // Report what this run changed (the verifying pass sees the finished state).
    return planned && plan.state === 'already_applied' ? { ...plan, result: planned } : plan
  }
  throw new ToolError('CONCURRENT_UPDATE', 'OneDrive kept changing during this change. Nothing is claimed; retry with the same operationId.')
}
