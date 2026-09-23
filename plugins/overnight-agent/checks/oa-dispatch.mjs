// One coordinator's drain: refill on observed completion, stop at its immutable cutoff.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import readline from 'node:readline';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WINDOW_MS = 30 * 60 * 1000;
const POLL_MS = 5000;
const ACTIVE = new Set(['sending', 'accepted', 'unconfirmed']);
const pathFlags = {
  state_dir: 'StateDir', journal_dir: 'JournalDir', planner_board: 'PlannerBoard',
  planner_completed: 'PlannerCompleted', snooze_store: 'SnoozeStore', user_settings: 'UserSettings',
};

export function nextCutoff(startedAt, startBufferMinutes = 5) {
  const time = Date.parse(startedAt);
  if (!Number.isFinite(time)) throw new Error('drain_start_unknown: coordinator prompt timestamp required');
  if (!Number.isSafeInteger(startBufferMinutes) || startBufferMinutes < 0 || startBufferMinutes >= WINDOW_MS / 60000) {
    throw new Error('drain_buffer_invalid: start buffer must be whole minutes from 0 to 29');
  }
  return new Date((Math.floor(time / WINDOW_MS) + 1) * WINDOW_MS - startBufferMinutes * 60000).toISOString();
}

export async function coordinatorStart(workspace) {
  const input = fs.createReadStream(path.join(workspace, 'events.jsonl'), 'utf8');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'user.message') {
        nextCutoff(event.timestamp);
        return event.timestamp;
      }
    }
  } finally { lines.close(); input.destroy(); }
  throw new Error('drain_start_unknown: no coordinator prompt found; cannot invent or extend a deadline');
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function toolResult(name, result, json = true) {
  if (typeof result !== 'string' && result?.resultType !== 'success') {
    throw new Error(`${name}: ${result?.error || result?.textResultForLlm || 'unsuccessful result'}`);
  }
  const value = typeof result === 'string' ? result : result.structuredContent ?? result.textResultForLlm;
  if (!json) {
    if (!value) throw new Error(`${name}: empty response`);
    return value;
  }
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); }
  catch { throw new Error(`${name}: complete structured JSON required`); }
}

function eventFile(root, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid task execution identity');
  return path.join(root, id, 'events.jsonl');
}

export function eventCursor(root, id) {
  const fd = fs.openSync(eventFile(root, id), 'r');
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid event file');
    const end = Number(stat.size);
    if (end) {
      const byte = Buffer.alloc(1);
      if (fs.readSync(fd, byte, 0, 1, end - 1) !== 1 || byte[0] !== 10) throw new Error('Event log has an incomplete record');
    }
    return { offset: end, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, exists: true };
  } finally { fs.closeSync(fd); }
}

// Only this run's marked instruction can finish its opening. An old idle reading, task status,
// five-minute age or an unrelated completion is not evidence that our queued message ran.
export function readCompletion(root, item) {
  const fd = fs.openSync(eventFile(root, item.session_id), 'r');
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const cursor = item.cursor;
    if (cursor.exists !== false && `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` !== cursor.identity ||
        Number(stat.size) < cursor.offset) {
      throw new Error('Task history was replaced/truncated; cannot prove this instruction finished');
    }
    const size = Number(stat.size) - cursor.offset;
    if (size > 16 * 1024 * 1024) throw new Error('Completion evidence exceeds the 16 MiB read budget');
    const bytes = Buffer.alloc(size);
    let count = 0;
    while (count < size) {
      const n = fs.readSync(fd, bytes, count, size - count, cursor.offset + count);
      if (!n) throw new Error('Task history changed during read');
      count += n;
    }
    let interaction;
    let ended = false;
    const turns = new Set();
    const lines = bytes.toString('utf8').split('\n');
    lines.pop(); // A trailing partial append is not yet an event.
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const data = event.data ?? {};
      if (event.type === 'user.message' && typeof data.content === 'string' &&
          data.content.split(/\r?\n/).includes(`<!-- oa-drain:${item.token} -->`)) {
        if (interaction || !data.interactionId) throw new Error('Ambiguous drain interaction identity');
        interaction = data.interactionId;
      }
      if (interaction && event.type === 'assistant.turn_start' && data.interactionId === interaction) {
        turns.add(data.turnId); ended = false;
      }
      if (event.type === 'assistant.turn_end' && turns.has(data.turnId)) ended = true;
    }
    return { started: turns.size > 0, turnEnded: ended };
  } finally { fs.closeSync(fd); }
}

export function createPlanner({ paths = {}, scriptPath, psExe } = {}) {
  const subject = scriptPath || [
    path.join(HERE, '..', 'skills', 'overnight-agent', 'oa-state.ps1'), path.join(HERE, 'oa-state.ps1'),
  ].find(candidate => fs.existsSync(candidate));
  if (!subject) throw new Error('oa-state.ps1 is missing');
  const flags = Object.entries(paths).flatMap(([key, value]) => {
    if (!pathFlags[key] || typeof value !== 'string' || !value) throw new Error(`Invalid planner path: ${key}`);
    return [`-${pathFlags[key]}`, value];
  });
  async function call(args) {
    try {
      const { stdout } = await exec(psExe || (process.platform === 'win32' ? 'powershell' : 'pwsh'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', subject, ...args, ...flags],
        { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout.replace(/^\uFEFF/, ''));
    } catch (error) { throw new Error(`oa-state: ${(error.stderr || error.message).trim()}`); }
  }
  return {
    scan: () => call(['scan']),
    settings: () => call(['session', '-RunLimit']),
    limit: async () => (await call(['session', '-RunLimit'])).dispatch_limit,
    check: (task, stamp = false) => call(['session', '-Id', task.task_id,
      stamp ? '-ForDispatch' : '-CheckDispatch', '-DispatchInput', task.dispatch_input,
      ...(task.collect_wave ? ['-Force'] : [])]),
  };
}

export function createNativeAdapter({ invokeTool, sessionRoot }) {
  return {
    async resolve(bindingId) {
      const data = toolResult('get_session', await invokeTool('get_session', { project_session_id: bindingId }));
      if (data.execution_location && data.execution_location !== 'local' || data.session_type === 'cloud') {
        throw new Error('Remote completion observation is unsupported; no instruction sent');
      }
      const id = data.active_session_id || data.id;
      if (!id) throw new Error('App did not resolve the task execution identity');
      let cursor;
      try { cursor = eventCursor(sessionRoot, id); }
      catch (error) {
        if (error.code !== 'ENOENT' || !data.path || !['worktree', 'branch', 'folder'].includes(data.session_type)) throw error;
        // The app confirms a local session that has not materialized its log yet. Missing
        // history never proves completion; the marked interaction must still appear and end.
        cursor = { exists: false, offset: 0, identity: null };
      }
      return { id, cursor };
    },
    async observe(item) {
      const evidence = readCompletion(sessionRoot, item);
      const data = toolResult('get_session', await invokeTool('get_session', { project_session_id: item.session_id }));
      if ((data.active_session_id || data.id) !== item.session_id) throw new Error('Task execution identity changed');
      if (evidence.turnEnded && data.activity?.status === 'idle' && data.is_running !== true) return 'completed';
      if (evidence.started && (data.awaiting_user_input || data.awaiting_plan_approval)) return 'waiting_for_user';
      if (!['busy', 'idle'].includes(data.activity?.status)) throw new Error('Task activity is unknown');
      return 'working';
    },
    send: async (item) => toolResult('send_session_message', await invokeTool('send_session_message', {
      session_id: item.session_id, delivery_mode: 'immediate',
      message: `${item.message}\n\n<!-- oa-drain:${item.token} -->`,
    }), false),
  };
}

export function createDrain({ directory, coordinatorSessionId, startedAt, planner, adapter,
  now = Date.now, wait = sleep, pollMs = POLL_MS, paths = {},
  startBufferMinutes = 5, startBufferSource = 'default' }) {
  const nextRunAt = nextCutoff(startedAt, 0);
  const file = path.join(directory, 'oa-drain.json');
  let state;
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 2 || state.coordinator_session_id !== coordinatorSessionId ||
        !Number.isSafeInteger(state.start_buffer_minutes) ||
        state.next_run_at !== nextRunAt || state.cutoff !== nextCutoff(startedAt, state.start_buffer_minutes) ||
        !['default', 'settings'].includes(state.start_buffer_source) ||
        !Array.isArray(state.items) || JSON.stringify(state.paths) !== JSON.stringify(paths) ||
        !['ready', 'running', 'drained', 'cutoff', 'error'].includes(state.status)) {
      throw new Error('drain_state_invalid: refusing to reset this run or change its deadline/paths');
    }
    for (const item of state.items) {
      if (!/^\d+$/.test(item.task_id) || !['queued', 'sending', 'accepted', 'unconfirmed', 'completed',
        'waiting_for_user', 'skipped', 'failed'].includes(item.state) ||
        ACTIVE.has(item.state) && (!item.session_id || !item.cursor || !item.token)) {
        throw new Error('drain_state_invalid: malformed queue item');
      }
    }
  } else {
    if (!['default', 'settings'].includes(startBufferSource)) throw new Error('drain_buffer_invalid: unreadable or malformed buffer configuration');
    state = { version: 2, coordinator_session_id: coordinatorSessionId,
      next_run_at: nextRunAt, cutoff: nextCutoff(startedAt, startBufferMinutes),
      start_buffer_minutes: startBufferMinutes, start_buffer_source: startBufferSource, paths,
      status: 'ready', limit: null, items: [], error: null };
    atomicWrite(file, state);
  }
  let running, preparing = false;
  const save = () => atomicWrite(file, state);
  const expired = () => now() >= Date.parse(state.cutoff);
  const snapshot = () => {
    const result = structuredClone(state);
    for (const item of result.items) {
      // Briefs stay in the resumable queue, not in every status response.
      delete item.message;
      delete item.cursor;
    }
    return result;
  };
  function end(status) { state.status = status; save(); return snapshot(); }

  async function loop() {
    state.status = 'running'; state.error = null; save();
    try {
      while (!expired()) {
        for (const item of state.items.filter(item => ACTIVE.has(item.state))) {
          try {
            const outcome = await adapter.observe(item);
            if (['completed', 'waiting_for_user'].includes(outcome)) item.state = outcome;
            item.observation_error = null;
          } catch (error) {
            item.observation_error = error.message; // Hold this opening, not every task/run.
          }
          save();
          if (expired()) return end('cutoff');
        }
        const limit = await planner.limit();
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid drain concurrency setting');
        state.limit = limit; save();
        let rows = await planner.scan();
        if (!Array.isArray(rows)) throw new Error('Planner scan is not a worklist');
        // The machine worklist determines selection order, not the order the model submitted briefs.
        rows = [...rows].sort((a, b) => a.order - b.order);
        const isCollect = row => state.items.find(item => item.task_id === row.id)?.collect_wave === true;
        rows = [...rows.filter(row => !isCollect(row)), ...rows.filter(isCollect)];
        let rescan = false;
        const blocked = new Set();
        for (const row of rows) {
          if (expired()) return end('cutoff');
          const item = state.items.find(item => item.task_id === row.id && item.state === 'queued');
          if (!item) continue;
          if (!row.eligible || row.session_paused) continue;
          if (row.dispatch_input !== item.dispatch_input) {
            item.state = 'skipped'; item.error = 'Task input changed since preparation; prepare a new brief in a later run'; save(); continue;
          }
          const active = state.items.filter(item => ACTIVE.has(item.state));
          if (!item.collect_wave && active.length >= limit) continue;
          try {
            const checked = await planner.check(item);
            if (!checked.dispatch_eligible || !checked.session_id) throw new Error('Task is not dispatchable');
            const target = await adapter.resolve(checked.session_id);
            if (state.items.some(other => ACTIVE.has(other.state) && other.session_id === target.id)) {
              blocked.add(item.task_id); continue;
            }
            // A second independent task binding to the same conversation should not be queued
            // behind this run's active request; after it finishes the other task can be selected.
            const currentRows = await planner.scan();
            const current = currentRows.find(candidate => candidate.id === item.task_id);
            if (!current?.eligible || current.session_paused || current.dispatch_input !== item.dispatch_input) {
              item.state = 'skipped'; item.error = 'Task input or eligibility changed before send'; save(); continue;
            }
            // Refresh selection: do not send a lower-ranked prepared item when a higher one
            // became eligible during the asynchronous lookups above.
            const first = [...currentRows].sort((a, b) => a.order - b.order).find(candidate =>
              candidate.eligible && !candidate.session_paused && !blocked.has(candidate.id) && state.items.some(other =>
                other.state === 'queued' && !other.collect_wave && other.task_id === candidate.id &&
                other.dispatch_input === candidate.dispatch_input &&
                !active.some(work => work.binding_id === candidate.session_id)));
            if (first && first.id !== item.task_id && !item.collect_wave) { rescan = true; break; }
            if (expired()) return end('cutoff');
            const stamped = await planner.check(item, true);
            if (!stamped.dispatch_authorised || stamped.session_id !== checked.session_id) throw new Error('Binding changed before send');
            if (expired()) return end('cutoff');
            Object.assign(item, { binding_id: checked.session_id, session_id: target.id,
              cursor: target.cursor, token: randomUUID().replaceAll('-', ''), state: 'sending' });
            save(); // Survives a crash after the native send but before its response.
            if (expired()) {
              item.state = 'skipped'; item.error = 'Cutoff before native send'; return end('cutoff');
            }
            try {
              await adapter.send(item);
              item.state = 'accepted';
            } catch (error) {
              item.state = 'unconfirmed'; item.error = error.message;
            }
            save();
          } catch (error) {
            if (ACTIVE.has(item.state)) throw error;
            item.state = 'failed'; item.error = error.message; save();
          }
        }
        if (expired()) return end('cutoff');
        if (rescan) continue;
        const active = state.items.some(item => ACTIVE.has(item.state));
        if (!active) {
          for (const item of state.items.filter(item => item.state === 'queued')) {
            item.state = 'skipped'; item.error = 'Not currently eligible in the prepared worklist';
          }
          return end('drained');
        }
        await wait(Math.min(pollMs, Math.max(0, Date.parse(state.cutoff) - now())));
      }
      return end('cutoff');
    } catch (error) {
      state.error = error.message;
      return end('error');
    }
  }

  return {
    status: snapshot,
    isRunning: () => Boolean(running),
    async prepare(tasks) {
      if (running || preparing) throw new Error('drain_running: cannot edit the prepared queue during execution/preparation');
      if (expired()) return end('cutoff');
      if (!Array.isArray(tasks) || tasks.length > 200) throw new Error('At most 200 prepared task briefs are allowed');
      preparing = true;
      try {
        const rows = await planner.scan();
        const additions = tasks.map(task => {
        if (!/^\d+$/.test(task.task_id) || typeof task.message !== 'string' || !task.message.trim() ||
            typeof task.dispatch_input !== 'string' || !task.dispatch_input ||
            task.message.length > 100000 || task.collect_wave !== undefined && typeof task.collect_wave !== 'boolean') {
          throw new Error('Invalid prepared task brief');
        }
        if (state.items.some(item => item.task_id === task.task_id)) throw new Error('Task already attempted/prepared in this run');
        const row = rows.find(row => row.id === task.task_id);
        if (!row?.dispatch_input) throw new Error(`No worklist input for task ${task.task_id}`);
        if (task.dispatch_input !== row.dispatch_input) throw new Error(`Task ${task.task_id} changed after its brief was prepared`);
        return { ...task, collect_wave: task.collect_wave === true, dispatch_input: row.dispatch_input, state: 'queued' };
        });
        if (new Set(additions.map(item => item.task_id)).size !== additions.length) throw new Error('Duplicate task brief');
        state.items.push(...additions);
        if (additions.length) state.status = 'ready';
        save();
        return snapshot();
      } finally { preparing = false; }
    },
    run() {
      if (preparing) throw new Error('drain_preparing: wait for prepared briefs to be saved');
      if (!running) {
        running = loop().finally(() => { running = undefined; });
      }
      return running;
    },
  };
}

// Operational guard for the enrolled coordinator's native tool path, not a sandbox against
// arbitrary shell/network code. The one-use permit is consumed by the pre-tool hook.
export function createDispatchGuard({ enrolled, busy, cutoff, now = Date.now }) {
  const permits = new Set();
  const key = args => JSON.stringify([args?.session_id, args?.message, args?.delivery_mode]);
  return {
    async send(args, invoke) {
      if (now() >= Date.parse(cutoff())) throw new Error('drain_cutoff: no new instructions');
      const token = key(args);
      permits.add(token);
      try { return await invoke(); } finally { permits.delete(token); }
    },
    before(toolName, args) {
      if (!enrolled()) return;
      const name = toolName.split(/[./]/).at(-1);
      if (name === 'send_session_message') {
        const token = key(args);
        if (now() < Date.parse(cutoff()) && permits.delete(token)) return;
        return { permissionDecision: 'deny', permissionDecisionReason: 'Use oa_drain; raw session messages bypass the queue and cutoff.' };
      }
      if (['create_session', 'open_pr_session', 'open_issue_session'].includes(name) && args?.kickoff ||
          ['fork_session', 'run_workflow', 'respond_to_session_plan', 'answer_session_input', 'task', 'write_agent'].includes(name)) {
        return { permissionDecision: 'deny', permissionDecisionReason: 'Prepare task sessions idle; execution must go through oa_drain.' };
      }
      if (name === 'task_complete' && busy()) {
        return { permissionDecision: 'deny', permissionDecisionReason: 'The code-owned drain is still running. Use oa_drain_wait; it refills automatically until drained or cutoff.' };
      }
    },
  };
}

export async function boundedToolCall(operation, cutoff, now = Date.now, maxMs = 15000) {
  const remaining = Date.parse(cutoff) - now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('drain_cutoff: no new native operation');
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native operation did not confirm before its deadline')),
          Math.min(maxMs, remaining));
      }),
    ]);
  } finally { clearTimeout(timer); }
}
