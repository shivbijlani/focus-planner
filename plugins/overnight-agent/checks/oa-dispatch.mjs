// Native app activity and delivery, with the state helper owning atomic admission (#589).
// No persistent "busy" mirror: only unfinished transport attempts survive an invocation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const safeId = /^[a-zA-Z0-9_-]+$/;
const pathFlags = {
  state_dir: 'StateDir', journal_dir: 'JournalDir', planner_board: 'PlannerBoard',
  planner_completed: 'PlannerCompleted', snooze_store: 'SnoozeStore', user_settings: 'UserSettings',
};

export class NativeToolError extends Error {
  constructor(name, result) {
    super(`${name}: ${result.error || result.textResultForLlm || result.resultType}`);
    this.name = 'NativeToolError';
    this.resultType = result.resultType;
  }
}

export function nativeResult(name, result, json = true) {
  if (typeof result !== 'string' && result?.resultType !== 'success') {
    throw new NativeToolError(name, result ?? { resultType: 'unknown' });
  }
  if (!json) return typeof result === 'string' ? result : result.textResultForLlm;
  const value = typeof result === 'string' ? result : result.structuredContent ?? result.textResultForLlm;
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); }
  catch { throw new Error(`${name}: expected complete structured JSON, not a truncated or empty tool response`); }
}

function stateInventory(stateDir) {
  let generation = 'initial';
  try {
    const data = JSON.parse(fs.readFileSync(path.join(stateDir, 'capacity-generation.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!/^[a-f0-9]{32}$/.test(data.generation ?? '')) throw new Error('capacity_generation_invalid');
    generation = data.generation;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let files;
  try { files = fs.readdirSync(stateDir); }
  catch (error) {
    if (error.code === 'ENOENT') return { bindings: [], dispatches: [], errors: [], generation };
    throw error;
  }
  const bindings = new Set();
  const dispatches = [];
  const errors = [];
  for (const file of files.filter(name => /^(task|dispatch)-.+\.json$/.test(name))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8').replace(/^\uFEFF/, ''));
      if (file.startsWith('task-') && data.session?.session_id) bindings.add(data.session.session_id);
      if (file.startsWith('dispatch-') && !['observed', 'cancelled'].includes(data.state)) {
        dispatches.push(data);
        if (data.execution_id) bindings.add(data.execution_id);
        if (data.binding_id) bindings.add(data.binding_id);
      }
    } catch (error) {
      // The state helper also emits an unknown member. Never turn an unreadable row into absence.
      errors.push(`${file}: ${error.message}`);
    }
  }
  return { bindings: [...bindings], dispatches, errors, generation };
}

function eventPath(sessionRoot, id) {
  if (typeof id !== 'string' || !safeId.test(id)) throw new Error('invalid execution identity');
  return path.join(sessionRoot, id, 'events.jsonl');
}

export function eventCursor(sessionRoot, id) {
  let fd;
  try {
    fd = fs.openSync(eventPath(sessionRoot, id), 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid event file');
    if (stat.size) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, Number(stat.size) - 1) !== 1 || last[0] !== 10) {
        throw new Error('Event log has an incomplete trailing record; refresh before dispatch.');
      }
    }
    return { exists: true, offset: Number(stat.size), identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, offset: 0, identity: null };
    return { error: error.message };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function dispatchReceipt(record, activity, sessionRoot, observedAt) {
  const result = (status, detail) => ({ dispatch_id: record.dispatch_id, status, detail });
  if (!/^[a-f0-9]{32}$/.test(record.dispatch_id ?? '')) return result('unknown', 'Invalid dispatch identity.');
  const cursor = record.log_cursor;
  if (!cursor || cursor.error || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    return result('unknown', 'No readable pre-send event cursor.');
  }
  const current = eventCursor(sessionRoot, record.execution_id);
  if (current.error) return result('unknown', current.error);
  if (!current.exists) return result('pending', 'No target event log yet; absence is not cancellation.');
  if ((cursor.exists && current.identity !== cursor.identity) || current.offset < cursor.offset) {
    return result('unknown', 'Target event log was replaced or truncated; inspect delivery before retrying.');
  }
  const length = current.offset - cursor.offset;
  if (length > MAX_RECEIPT_BYTES) return result('unknown', 'Receipt exceeds the 16 MiB read budget; inspect target history.');
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(eventPath(sessionRoot, record.execution_id), 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (`${opened.dev}:${opened.ino}:${opened.birthtimeNs}` !== current.identity) {
      return result('unknown', 'Target event log was replaced between observation and read.');
    }
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, cursor.offset + read);
      if (!n) return result('unknown', 'Target event file changed during the receipt read.');
      read += n;
    }
  } finally { fs.closeSync(fd); }

  const marker = `<!-- oa-dispatch:${record.dispatch_id} -->`;
  let interaction = null;
  const turns = new Set();
  let ended = false;
  for (const line of buffer.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { return result('unknown', 'Incomplete or invalid event data; retry the observation.'); }
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at)) return result('unknown', 'Event has no valid timestamp.');
    // The live idle reading must be AFTER the execution evidence, not before it.
    if (at > Date.parse(observedAt)) continue;
    const data = event.data ?? {};
    if (event.type === 'user.message' && typeof data.content === 'string' &&
        data.content.split(/\r?\n/).includes(marker)) {
      if (interaction) return result('unknown', 'Duplicate dispatch markers in target messages.');
      interaction = data.interactionId;
      if (!interaction) return result('unknown', 'Target message has no interaction identity.');
    }
    if (interaction && event.type === 'assistant.turn_start' && data.interactionId === interaction) {
      turns.add(data.turnId);
      ended = false;
    }
    if (event.type === 'assistant.turn_end' && turns.has(data.turnId)) ended = true;
  }
  if (ended && activity?.status === 'idle') return result('completed', 'Matching interaction ran and the app subsequently reports idle.');
  if (turns.size) return result('started', 'Matching interaction started; current activity still owns execution.');
  return result('pending', interaction ? 'Message arrived but its interaction has not started.' : 'No matching target message yet.');
}

function activityRow(bindingId, data, sessionRoot) {
  const id = data?.active_session_id || data?.id || bindingId;
  const declared = data?.activity?.status;
  let status = ['busy', 'idle', 'unknown'].includes(declared) ? declared : 'unknown';
  if (data?.awaiting_user_input === true || data?.awaiting_plan_approval === true) status = 'waiting';
  if (status === 'idle' && data?.is_running === true) status = 'unknown';
  const cursor = eventCursor(sessionRoot, id);
  if (data?.session_type === 'cloud' || (data?.execution_location && data.execution_location !== 'local')) {
    cursor.error = 'Remote execution receipts are not available through this local event reader.';
  } else if (!cursor.exists && !cursor.error &&
      !(['folder', 'worktree', 'branch'].includes(data?.session_type) && data?.path)) {
    cursor.error = 'No local event log or app metadata proving this is a new local session.';
  }
  return {
    binding_id: bindingId, session_id: id, status,
    detail: status === 'unknown' ? 'App activity is missing, contradictory or unknown.' : `App activity: ${status}.`,
    log_cursor: cursor,
  };
}

export async function captureActivity({ invokeTool, stateDir, sessionRoot }) {
  const inventory = stateInventory(stateDir);
  // Date the beginning, not the end: a slow API call must not refresh an old reading's age.
  const observedAt = new Date().toISOString();
  const snapshot = {
    schema_version: 1, source: 'copilot-app', observed_at: observedAt,
    generation: inventory.generation, sessions: [], receipts: [],
  };
  let live = [];
  try {
    const response = nativeResult('get_sessions_status', await invokeTool('get_sessions_status', {}));
    if (!Array.isArray(response.sessions)) throw new Error('No sessions array returned.');
    live = response.sessions;
  } catch (error) {
    // The app can truncate its bulk tool output before SDK delivery. Individually reading
    // EVERY bound identity is another authoritative observation, not an idle default.
    snapshot.warnings = [`Bulk activity unavailable (${error.message}); resolving each bound identity with get_session.`];
  }
  if (inventory.errors.length) snapshot.inventory_errors = inventory.errors;
  const byId = new Map(live.map(item => [item.id, item]));
  for (const bindingId of inventory.bindings) {
    let data = byId.get(bindingId);
    let lookupError;
    if (!data) {
      try {
        // App workspace IDs and old CLI IDs are aliases, not additional workers. A missing
        // row in the bulk list is never proof that the session is absent or idle.
        data = nativeResult('get_session', await invokeTool('get_session', { project_session_id: bindingId }));
      } catch (error) { lookupError = error.message; }
    }
    let row = activityRow(bindingId, data, sessionRoot);
    if (data && !row.log_cursor.exists && byId.has(bindingId)) {
      try {
        data = nativeResult('get_session', await invokeTool('get_session', { project_session_id: bindingId }));
        row = activityRow(bindingId, data, sessionRoot);
      } catch (error) { row.log_cursor.error = error.message; }
    }
    if (lookupError) row.detail = lookupError;
    snapshot.sessions.push(row);
  }
  for (const record of inventory.dispatches) {
    const activity = snapshot.sessions.find(item => item.session_id === record.execution_id);
    try { snapshot.receipts.push(dispatchReceipt(record, activity, sessionRoot, observedAt)); }
    catch (error) {
      snapshot.receipts.push({ dispatch_id: record.dispatch_id, status: 'unknown', detail: error.message });
    }
  }
  return snapshot;
}

function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalDirectory(parent), path.basename(absolute));
  }
}

export function createDispatcher({ invokeTool, ownerSessionId, paths = {}, sessionRoot, scriptPath, psExe } = {}) {
  if (typeof invokeTool !== 'function') throw new Error('Native app tool invocation is required.');
  if (!ownerSessionId) throw new Error('The invoking session identity is required.');
  const stateDir = canonicalDirectory(paths.state_dir || path.join(process.env.LOCALAPPDATA || os.homedir(), 'overnight-agent', 'state'));
  const allPaths = { ...paths, state_dir: stateDir };
  const root = sessionRoot || path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-state');
  const subject = scriptPath || [
    path.join(HERE, '..', 'skills', 'overnight-agent', 'oa-state.ps1'), path.join(HERE, 'oa-state.ps1'),
  ].find(candidate => fs.existsSync(candidate));
  if (!subject) throw new Error('oa-state.ps1 is missing from this plugin; do not fall back to another installed version.');
  const executable = psExe || (process.platform === 'win32' ? 'powershell' : 'pwsh');
  const flags = Object.entries(allPaths).flatMap(([key, value]) => {
    if (!pathFlags[key] || typeof value !== 'string' || !value) throw new Error(`Invalid path option: ${key}`);
    return [`-${pathFlags[key]}`, value];
  });

  async function runState(args, snapshot) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dispatch-'));
    try {
      const input = path.join(temporary, 'activity.json');
      if (snapshot) fs.writeFileSync(input, JSON.stringify(snapshot));
      const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', subject,
        ...args, ...flags, ...(snapshot ? ['-ActivitySnapshot', input] : [])];
      let response;
      try {
        response = await exec(executable, argv, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
      } catch (error) {
        throw new Error(`oa-state failed: ${(error.stderr || error.message).trim()}`);
      }
      try { return JSON.parse(response.stdout.replace(/^\uFEFF/, '')); }
      catch { throw new Error(`oa-state produced invalid JSON: ${response.stdout.slice(0, 1000)}`); }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }

  const capture = () => captureActivity({ invokeTool, stateDir, sessionRoot: root });
  async function withFreshActivity(args) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await runState(args, await capture());
        const problem = Array.isArray(result) ? result.find(row => row.capacity_error)?.capacity_error : result.activity_error;
        if (problem?.includes('session_snapshot_changed')) throw new Error(problem);
        return result;
      } catch (error) {
        // Only a pre-mutation generation refusal is retryable. Never retry a native send.
        if (!error.message.includes('session_snapshot_changed') || attempt === 4) throw error;
      }
    }
  }
  return {
    async capacity({ reconcile = true } = {}) {
      return withFreshActivity(['session', '-InFlight', ...(reconcile ? ['-ReconcileDispatches'] : [])]);
    },
    async scan() { return withFreshActivity(['scan', '-ReconcileDispatches']); },
    async dispatch({ task_id, message, wake_key, collect_wave = false }) {
      if (!/^\d+$/.test(String(task_id)) || typeof message !== 'string' || !message.trim()) {
        throw new Error('A numeric task_id and a non-empty approved work brief are required.');
      }
      // The tool requires the scan's key; programmatic callers may capture it once here.
      // Keep it unchanged across activity-generation retries, rather than silently adopting
      // another worker's newer result as a reason to send the same brief again.
      const key = wake_key || (await withFreshActivity(['scan'])).find(row => row.id === String(task_id))?.wake_key;
      if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw new Error('A current worklist wake_key is required.');
      const args = ['session', '-Id', String(task_id), '-DispatchOwner', ownerSessionId, '-WakeKey', key];
      const wave = collect_wave ? ['-Force'] : [];
      const reservation = await withFreshActivity([...args, '-ForDispatch', ...wave]);
      if (reservation.dispatch_already_delivered) {
        return {
          task_id: String(task_id), session_id: reservation.session_id, dispatch_id: reservation.dispatch_id,
          accepted: true, already_delivered: true, detail: 'This worklist wake was already processed; no second message was sent.',
        };
      }
      if (!reservation.dispatch_reserved || !/^[a-f0-9]{32}$/.test(reservation.dispatch_id ?? '')) {
        throw new Error('oa-state did not reserve a dispatch; no message was sent.');
      }
      const tokenArgs = [...args, '-DispatchToken', reservation.dispatch_id];
      try {
        const started = await withFreshActivity([...tokenArgs, '-DispatchStart', ...wave]);
        if (!started.dispatch_authorised || started.dispatch_id !== reservation.dispatch_id) {
          throw new Error('Fenced start did not authorise this dispatch.');
        }
      } catch (error) {
        await runState([...tokenArgs, '-DispatchCancel']);
        throw error;
      }

      let delivery;
      try {
        delivery = await invokeTool('send_session_message', {
          session_id: reservation.session_id,
          delivery_mode: 'immediate',
          message: `${message}\n\n<!-- oa-dispatch:${reservation.dispatch_id} -->`,
        }, `oa-dispatch-${reservation.dispatch_id}`);
        nativeResult('send_session_message', delivery, false);
      } catch (error) {
        if (error instanceof NativeToolError && ['denied', 'rejected'].includes(error.resultType)) {
          await runState([...tokenArgs, '-DispatchCancel']);
          throw new Error(`dispatch_not_sent: ${reservation.dispatch_id}; ${error.message}`);
        }
        // A failed RPC can have delivered. Keep its receipt obligation, including across crashes.
        throw new Error(`dispatch_outcome_unknown: ${reservation.dispatch_id}; ${error.message}. Inspect oa_capacity before any retry.`);
      }
      let receiptWarning;
      try { await runState([...tokenArgs, '-DispatchAccepted']); }
      catch (error) {
        // Native acceptance is already known. A bookkeeping failure is not a failed send
        // and must never invite a duplicate, even after a terminal receipt's retention ends.
        receiptWarning = `Delivery accepted; receipt acknowledgment failed for ${reservation.dispatch_id}: ${error.message}. Do not resend.`;
      }
      return {
        task_id: String(task_id), session_id: reservation.session_id, dispatch_id: reservation.dispatch_id,
        accepted: true, reconcile_by: reservation.deadline,
        detail: 'Message accepted; capacity remains reserved until matching execution evidence is observed.',
        ...(receiptWarning ? { receipt_warning: receiptWarning } : {}),
      };
    },
  };
}
