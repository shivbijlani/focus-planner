import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureActivity, createDispatcher, dispatchReceipt, eventCursor, nativeResult } from './oa-dispatch.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBJECT = process.env.OA_STATE_SCRIPT || path.join(HERE, '..', 'skills', 'overnight-agent', 'oa-state.ps1');
const PS = process.env.OA_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell' : 'pwsh');
const old = '2026-09-06T16:16:52-07:00';
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-admission-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = {
    state_dir: path.join(root, 'state'), journal_dir: path.join(root, 'journal'),
    planner_board: path.join(root, 'planner.md'), planner_completed: path.join(root, 'completed.md'),
    snooze_store: path.join(root, 'snooze.json'), user_settings: path.join(root, 'settings.md'),
  };
  fs.mkdirSync(paths.state_dir);
  fs.mkdirSync(paths.journal_dir);
  fs.writeFileSync(paths.planner_completed, '');
  writeJson(paths.snooze_store, {});
  fs.writeFileSync(paths.user_settings, '| Setting | Value |\n|---|---|\n| Overnight Agent concurrency | 1 |\n');
  const sessionRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionRoot);
  const tasks = new Map(), activity = new Map(), aliases = new Map(), sent = [], calls = [];
  const f = { root, paths, sessionRoot, tasks, activity, aliases, sent, calls };

  f.stateFile = id => path.join(paths.state_dir, `task-${id}.json`);
  f.records = () => fs.readdirSync(paths.state_dir).filter(n => /^dispatch-.+\.json$/.test(n))
    .map(n => readJson(path.join(paths.state_dir, n)));
  f.pending = () => f.records().filter(record => !['observed', 'cancelled'].includes(record.state));
  f.saveRecord = record => writeJson(path.join(paths.state_dir, `dispatch-${record.dispatch_id}.json`), record);
  f.add = (id, options = {}) => {
    id = String(id);
    const sessionId = options.sessionId || `s-${id}`;
    const canonical = options.canonical || sessionId;
    const state = {
      id, status: options.status || 'in-progress', status_by: options.statusBy || 'agent', updated: old,
      version: 1, plan_id: '', seeded: false, processed_file_hash: '', has_agent_block: true,
      session: {
        session_id: sessionId, state: 'live', kind: 'folder', project: 'fixture',
        workspace: '', workspace_type: 'folder', created_at: old, last_woken_at: options.woken || old,
        prior_session_id: '', replaced_at: '',
      },
    };
    if (options.poll) state.poll = { cadence: 'daily', interval_minutes: 1440, last_polled: old, next_due: old };
    if (options.recheck) state.recheck = { cadence: 'daily', interval_minutes: 1440, last_rechecked: old, next_due: old };
    if (options.doc) state.doc = {
      doc_id: 'fixture-doc', observed_at: new Date().toISOString(), pending_ids: [], ...options.doc,
    };
    writeJson(f.stateFile(id), state);
    let journal = `# Task ${id}: Fixture\n\n## \u{1F319} Overnight Agent\n<!-- from: overnight-agent -->\n` +
      `<!-- oa-ask: ${options.ask || 'none'} -->\n\n**Status:** In progress.\n\n` +
      '**Needs from you:** nothing blocking.\n\n<!-- /overnight-agent turn-end -->\n';
    if (options.reply) journal += '\n<!-- from: me -->\nPlease continue with the approved plan.\n';
    if (!options.noJournal) fs.writeFileSync(path.join(paths.journal_dir, `task-${id}.md`), journal);
    tasks.set(id, { section: options.section || 'today' });
    fs.writeFileSync(paths.planner_board, ['today', 'deferred'].map(section =>
      `## ${section === 'today' ? 'Today' : 'Deferred'}\n\n| ID | Task |\n|---|---|\n` +
      [...tasks].filter(([, task]) => task.section === section).map(([key]) => `| ${key} | Fixture |\n`).join(''),
    ).join('\n'));
    activity.set(canonical, { id: canonical, activity: { status: options.activity || 'idle' }, is_running: options.activity === 'busy' });
    if (canonical !== sessionId) aliases.set(sessionId, canonical);
    fs.mkdirSync(path.join(sessionRoot, canonical), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, canonical, 'events.jsonl'), '');
    return state;
  };
  f.events = (id, events) => {
    const now = new Date(Date.now() - 5).toISOString();
    fs.appendFileSync(path.join(sessionRoot, id, 'events.jsonl'),
      events.map(event => JSON.stringify({ timestamp: now, ...event })).join('\n') + '\n');
  };
  f.receipt = (message = sent.at(-1), { start = true, end = true, interaction = 'interaction-1' } = {}) => {
    const events = [{ type: 'user.message', data: { content: message.message, interactionId: interaction } }];
    if (start) events.push({ type: 'assistant.turn_start', data: { interactionId: interaction, turnId: 'turn-1' } });
    if (end) events.push({ type: 'assistant.turn_end', data: { turnId: 'turn-1' } });
    f.events(message.session_id, events);
  };
  f.invoke = async (name, args, toolCallId) => {
    calls.push({ name, args, toolCallId });
    if (name === 'get_sessions_status') {
      if (f.statusError) throw new Error('App status unavailable');
      return JSON.stringify({ sessions: [...activity.values()] });
    }
    if (name === 'get_session') {
      const id = aliases.get(args.project_session_id);
      if (!id || !activity.has(id)) throw new Error('Session not observable');
      return JSON.stringify({ ...activity.get(id), active_session_id: id });
    }
    if (name === 'send_session_message') {
      if (f.sendMode === 'denied') return { resultType: 'denied', textResultForLlm: 'Permission denied before execution' };
      assert.ok(Date.parse(readJson(f.stateFile(args.session_id.slice(2))).session.last_woken_at) > Date.parse(old),
        'wake must advance BEFORE the native send, not merely change timezone representation');
      sent.push(args);
      if (f.sendMode === 'lost') throw new Error('Response lost after accepting the message');
      return { resultType: 'success', textResultForLlm: 'Message accepted for priority delivery' };
    }
    throw new Error(`Unexpected native tool: ${name}`);
  };
  f.dispatcher = (overrides = {}) => createDispatcher({
    invokeTool: f.invoke, ownerSessionId: 'coordinator-a', paths, sessionRoot, scriptPath: SUBJECT, psExe: PS, ...overrides,
  });
  f.snapshot = () => captureActivity({ invokeTool: f.invoke, stateDir: paths.state_dir, sessionRoot });
  let inputCounter = 0;
  f.oa = async (args, snapshot) => {
    const input = path.join(root, `snapshot-${inputCounter++}.json`);
    if (snapshot) writeJson(input, await snapshot);
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SUBJECT, ...args,
      '-StateDir', paths.state_dir, '-JournalDir', paths.journal_dir, '-PlannerBoard', paths.planner_board,
      '-PlannerCompleted', paths.planner_completed, '-SnoozeStore', paths.snooze_store, '-UserSettings', paths.user_settings,
      ...(snapshot ? ['-ActivitySnapshot', input] : [])];
    try {
      const { stdout } = await exec(PS, argv, { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) { throw new Error(error.stderr || error.message); }
  };
  return f;
}

test('idle retained overdue tasks occupy no slot and the eligible Today task is sent exactly once', async t => {
  const f = fixture(t);
  f.add('468', { poll: true });
  f.add('228', { section: 'deferred', poll: true, ask: 'blocking', doc: {} });
  const before = readJson(f.stateFile('228'));
  const dispatcher = f.dispatcher();
  const capacity = await dispatcher.capacity();
  assert.equal(capacity.in_flight, 0);
  assert.equal(capacity.admits, 1);
  const rows = await dispatcher.scan();
  assert.deepEqual(rows.filter(row => row.eligible).map(row => row.id), ['468']);
  assert.equal(rows.find(row => row.id === '228').due_poll, true);
  assert.equal(rows.find(row => row.id === '228').holds_capacity, false);
  const result = await dispatcher.dispatch({ task_id: '468', message: 'Do the approved Today check.' });
  assert.equal(result.accepted, true);
  await assert.rejects(() => dispatcher.dispatch({ task_id: '468', message: 'Duplicate wake' }), /session_dispatch_pending/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].delivery_mode, 'immediate');
  assert.equal(f.calls.find(call => call.name === 'send_session_message').toolCallId, `oa-dispatch-${result.dispatch_id}`);
  assert.deepEqual(readJson(f.stateFile('228')), before, 'timer, pause and conversation must not change');
  const pending = await dispatcher.capacity();
  assert.equal(pending.actual_busy, 0);
  assert.equal(pending.in_flight, 1);
  assert.equal(pending.pending_dispatches, 1);
});

test('actual busy Deferred work with an old wake and silent doc prevents another scheduled dispatch', async t => {
  const f = fixture(t);
  f.add('468');
  f.add('228', { section: 'deferred', activity: 'busy', poll: true, doc: {}, ask: 'blocking' });
  const capacity = await f.dispatcher().capacity();
  assert.equal(capacity.in_flight, 1);
  assert.equal(capacity.actual_busy, 1);
  assert.equal(capacity.members.find(member => member.session_id === 's-228').reason, 'app_busy');
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Approved work' }), /session_at_capacity/);
  assert.equal(f.sent.length, 0);
});

test('two bindings resolve to one execution and every scan capacity unit reconciles to the total', async t => {
  const f = fixture(t);
  f.add('400', { sessionId: 'workspace-alias', canonical: 'execution-1', activity: 'busy' });
  f.add('480', { sessionId: 'old-session-alias', canonical: 'execution-1', activity: 'busy' });
  f.add('399', { noJournal: true, activity: 'busy', section: 'other' });
  const capacity = await f.dispatcher().capacity();
  const rows = await f.dispatcher().scan();
  assert.equal(capacity.in_flight, 2);
  assert.deepEqual(capacity.members.find(member => member.session_id === 'execution-1').task_ids, ['400', '480']);
  assert.equal(rows.reduce((n, row) => n + row.capacity_units, 0), capacity.in_flight);
  assert.ok(rows.every(row => row.capacity_reason));
  assert.equal(rows.find(row => row.id === '399').capacity_only, true);
  assert.equal(rows.find(row => row.id === '399').eligible, false);
  assert.equal(readJson(f.stateFile('400')).session.session_id, 'workspace-alias');
});

test('unknown and missing app status is visible, safe, and automatically recovers on a fresh known reading', async t => {
  const f = fixture(t);
  f.add('468');
  const saved = readJson(f.stateFile('468'));
  f.activity.delete('s-468');
  const unknown = await f.dispatcher().capacity();
  assert.equal(unknown.in_flight, 1);
  assert.equal(unknown.admits, 0);
  assert.equal(unknown.requires_attention, true);
  assert.equal(unknown.members[0].reason, 'activity_unknown');
  assert.match(unknown.members[0].recovery, /Refresh oa_capacity/);
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Approved' }), /session_activity_unknown/);
  f.activity.set('s-468', { id: 's-468', activity: { status: 'idle' }, is_running: false });
  assert.equal((await f.dispatcher().capacity()).admits, 1);
  assert.deepEqual(readJson(f.stateFile('468')), saved);
});

test('missing, stale, future, and malformed snapshots never become permission to dispatch', async t => {
  const f = fixture(t);
  f.add('468');
  for (const snapshot of [undefined, {}, { ...(await f.snapshot()), observed_at: old },
    { ...(await f.snapshot()), observed_at: new Date(Date.now() + 60000).toISOString() }]) {
    const result = await f.oa(['session', '-InFlight'], snapshot);
    assert.equal(result.admits, 0);
    assert.equal(result.requires_attention, true);
    assert.match(result.activity_error, /activity_snapshot/);
  }
  f.statusError = true;
  assert.equal((await f.dispatcher().capacity()).admits, 0);
});

test('unreadable state and contradictory activity are charged and named rather than skipped', async t => {
  const f = fixture(t);
  f.add('468');
  fs.writeFileSync(f.stateFile('399'), '{broken');
  const result = await f.dispatcher().capacity();
  assert.equal(result.admits, 0);
  assert.equal(result.members.find(member => member.session_id === 'state:399').reason, 'state_unreadable');
  fs.unlinkSync(f.stateFile('399'));
  f.activity.get('s-468').is_running = true;
  assert.equal((await f.dispatcher().capacity()).members[0].activity_status, 'unknown');
});

test('truncated bulk output falls back to real per-session observations with a visible diagnostic', async t => {
  const f = fixture(t);
  f.add('468');
  const dispatcher = f.dispatcher({
    invokeTool: async (name, args) => {
      if (name === 'get_sessions_status') return 'Output too large; saved to a local tool-output file.';
      if (name === 'get_session') {
        assert.equal(args.project_session_id, 's-468');
        return JSON.stringify(f.activity.get('s-468'));
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  });
  const result = await dispatcher.capacity();
  assert.equal(result.in_flight, 0);
  assert.equal(result.admits, 1);
  assert.equal(result.requires_attention, false);
  assert.match(result.activity_warnings[0], /resolving each bound identity with get_session/);
});

test('accepted but not running stays reserved past the deadline with explicit reconciliation guidance', async t => {
  const f = fixture(t);
  f.add('468');
  const result = await f.dispatcher().dispatch({ task_id: '468', message: 'Approved' });
  const record = f.records()[0];
  record.deadline = old;
  f.saveRecord(record);
  const capacity = await f.dispatcher().capacity();
  assert.equal(capacity.in_flight, 1);
  assert.equal(capacity.admits, 0);
  assert.equal(capacity.actual_busy, 0);
  assert.equal(capacity.requires_attention, true);
  assert.equal(capacity.members[0].reason, 'dispatch_reconciliation_required');
  assert.match(capacity.members[0].recovery, new RegExp(result.dispatch_id));
  f.receipt(f.sent[0], { start: false, end: false });
  assert.equal((await f.dispatcher().capacity()).admits, 0, 'queued receipt alone is not execution');
  f.events('s-468', [
    { type: 'assistant.turn_start', data: { interactionId: 'interaction-1', turnId: 'turn-1' } },
    { type: 'assistant.turn_end', data: { turnId: 'turn-1' } },
  ]);
  assert.equal((await f.dispatcher().capacity()).admits, 1);
  assert.equal(f.pending().length, 0, 'completed delivery records do not become a busy ledger');
  assert.equal(f.records()[0].state, 'observed');
  const terminal = f.records()[0];
  terminal.retain_until = old;
  f.saveRecord(terminal);
  await f.dispatcher().capacity();
  assert.equal(f.records().length, 0, 'terminal acknowledgment evidence is garbage-collected');
});

test('send accepted but response lost cannot cause a duplicate and reconciles from actual target execution', async t => {
  const f = fixture(t);
  f.add('468');
  f.sendMode = 'lost';
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Approved' }), /dispatch_outcome_unknown/);
  assert.equal(f.records()[0].state, 'sending');
  await assert.rejects(() => f.dispatcher({ ownerSessionId: 'coordinator-b' }).dispatch({ task_id: '468', message: 'Retry' }), /session_dispatch_pending/);
  assert.equal(f.sent.length, 1);
  f.receipt();
  assert.equal((await f.dispatcher().capacity()).in_flight, 0);
  assert.equal(f.pending().length, 0);
});

test('matching started work transfers occupancy to the app instead of expiring at a fixed wake age', async t => {
  const f = fixture(t);
  f.add('468', { doc: {} });
  await f.dispatcher().dispatch({ task_id: '468', message: 'Long approved work' });
  f.receipt(f.sent[0], { end: false });
  f.activity.get('s-468').activity.status = 'busy';
  let capacity = await f.dispatcher().capacity();
  assert.equal(capacity.actual_busy, 1);
  assert.equal(capacity.pending_dispatches, 0);
  assert.equal(f.pending().length, 0);
  const state = readJson(f.stateFile('468'));
  state.session.last_woken_at = old;
  writeJson(f.stateFile('468'), state);
  capacity = await f.dispatcher().capacity();
  assert.equal(capacity.in_flight, 1);
  assert.equal(capacity.requires_attention, false);
  f.activity.get('s-468').activity.status = 'idle';
  assert.equal((await f.dispatcher().capacity()).in_flight, 0);
});

test('a crashed preparation expires but its token is fenced from ever starting later', async t => {
  const f = fixture(t);
  f.add('468');
  const args = ['session', '-Id', '468', '-DispatchOwner', 'crashed-coordinator'];
  const reserved = await f.oa([...args, '-ForDispatch'], await f.snapshot());
  assert.equal(reserved.dispatch_authorised, false);
  assert.equal(readJson(f.stateFile('468')).session.last_woken_at, old);
  const record = f.records()[0];
  record.deadline = old;
  f.saveRecord(record);
  await assert.rejects(() => f.oa([...args, '-DispatchStart', '-DispatchToken', reserved.dispatch_id], f.snapshot()), /session_dispatch_token_expired/);
  assert.equal((await f.dispatcher().capacity()).admits, 1);
  assert.equal(f.records().length, 0);
  await f.dispatcher().dispatch({ task_id: '468', message: 'A new, fenced attempt' });
  assert.equal(f.sent.length, 1);
});

test('a start token is single-use and a definite native denial cancels without a false wake stamp', async t => {
  const f = fixture(t);
  f.add('468');
  f.sendMode = 'denied';
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Approved' }), /dispatch_not_sent/);
  assert.equal(Date.parse(readJson(f.stateFile('468')).session.last_woken_at), Date.parse(old));
  assert.equal((await f.dispatcher().capacity()).admits, 1);
  const args = ['session', '-Id', '468', '-DispatchOwner', 'coordinator-a'];
  const reserved = await f.oa([...args, '-ForDispatch'], await f.snapshot());
  const start = [...args, '-DispatchStart', '-DispatchToken', reserved.dispatch_id];
  assert.equal((await f.oa(start, await f.snapshot())).dispatch_authorised, true);
  await assert.rejects(() => f.oa(start, f.snapshot()), /session_dispatch_token_spent/);
});

test('explicit pauses are preserved and cannot be bypassed by collect dispatch', async t => {
  const f = fixture(t);
  f.add('468', { status: 'blocked', statusBy: 'user', poll: true, recheck: true });
  const before = readJson(f.stateFile('468'));
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Do not wake', collect_wave: true }), /session_not_dispatchable/);
  assert.deepEqual(readJson(f.stateFile('468')), before);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.dispatcher().capacity()).in_flight, 0);
  f.activity.get('s-468').activity.status = 'busy';
  assert.equal((await f.dispatcher().capacity()).in_flight, 1, 'recording a pause cannot hide already executing work');
});

test('only explicit human collect evidence bypasses the admission cap and never a duplicate', async t => {
  const f = fixture(t);
  f.add('399', { activity: 'busy' });
  f.add('468', { poll: true });
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Timer only', collect_wave: true }), /session_collect_evidence_required/);
  const journal = path.join(f.paths.journal_dir, 'task-468.md');
  fs.appendFileSync(journal, '\n<!-- from: me -->\nPlease run my approved request now.\n');
  await f.dispatcher().dispatch({ task_id: '468', message: 'Human reply', collect_wave: true });
  const result = await f.dispatcher().capacity();
  assert.equal(result.in_flight, 2);
  assert.equal(result.concurrency, 1);
  assert.equal(result.admits, 0);
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Duplicate', collect_wave: true }), /session_dispatch_pending/);
  assert.equal(f.sent.length, 1);
});

test('waiting at an app-owned human gate is not a worker and cannot receive another task wake', async t => {
  const f = fixture(t);
  f.add('468');
  f.activity.get('s-468').awaiting_user_input = true;
  assert.equal((await f.dispatcher().capacity()).in_flight, 0);
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Approved' }), /session_already_active/);
  assert.equal(f.sent.length, 0);
});

test('an idle target without a local receipt source is refused before any send', async t => {
  const f = fixture(t);
  f.add('468');
  fs.unlinkSync(path.join(f.sessionRoot, 's-468', 'events.jsonl'));
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Approved' }), /session_dispatch_receipt_unavailable/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.records().length, 0);
});

test('a stat-readable but content-unreadable event log is refused before sending', async t => {
  const f = fixture(t);
  f.add('468');
  const file = path.join(f.sessionRoot, 's-468', 'events.jsonl');
  assert.ok(fs.statSync(file).isFile());
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('Content access denied'), { code: 'EACCES' });
    return open(target, ...args);
  });
  assert.match(eventCursor(f.sessionRoot, 's-468').error, /Content access denied/);
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Approved' }), /session_dispatch_receipt_unavailable/);
  assert.equal(f.sent.length, 0);
});

test('retired receipt invalidates old snapshots so a concurrency-two interleaving cannot authorise three workers', async t => {
  const f = fixture(t);
  for (const id of ['468', '399', '228']) f.add(id);
  fs.writeFileSync(f.paths.user_settings, '| Setting | Value |\n|---|---|\n| Overnight Agent concurrency | 2 |\n');
  const args = id => ['session', '-Id', id, '-DispatchOwner', `owner-${id}`];
  const a = await f.oa([...args('468'), '-ForDispatch'], await f.snapshot());
  const b = await f.oa([...args('399'), '-ForDispatch'], await f.snapshot());
  const stale = await f.snapshot();
  const startA = await f.oa([...args('468'), '-DispatchStart', '-DispatchToken', a.dispatch_id], stale);
  f.receipt({ session_id: 's-468', message: `Approved\n<!-- oa-dispatch:${a.dispatch_id} -->` }, { end: false });
  f.activity.get('s-468').activity.status = 'busy';
  const capacity = await f.dispatcher().capacity();
  assert.equal(capacity.in_flight, 2);
  assert.equal(f.records().find(record => record.dispatch_id === a.dispatch_id).state, 'observed');
  await assert.rejects(() => f.oa([...args('399'), '-DispatchStart', '-DispatchToken', b.dispatch_id], stale), /session_snapshot_changed/);
  await assert.rejects(() => f.oa([...args('228'), '-ForDispatch'], stale), /session_snapshot_changed/);
  assert.equal(readJson(f.stateFile('399')).session.last_woken_at, old);
  const startB = await f.oa([...args('399'), '-DispatchStart', '-DispatchToken', b.dispatch_id], await f.snapshot());
  f.receipt({ session_id: 's-399', message: `Approved\n<!-- oa-dispatch:${b.dispatch_id} -->` }, { end: false, interaction: 'interaction-b' });
  f.activity.get('s-399').activity.status = 'busy';
  assert.equal((await f.dispatcher().capacity()).actual_busy, 2);
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '228', message: 'Would be a third worker' }), /session_at_capacity/);
  assert.equal([startA, startB].filter(result => result.dispatch_authorised).length, 2);
});

for (const expireReceipt of [false, true]) {
  test(`native acceptance remains successful when reconciliation ${expireReceipt ? 'garbage-collects' : 'retires'} its receipt before acknowledgment`, async t => {
    const f = fixture(t);
    f.add('468');
    const result = await f.dispatcher({
      invokeTool: async (name, args, callId) => {
        const value = await f.invoke(name, args, callId);
        if (name === 'send_session_message') {
          f.receipt();
          await f.dispatcher({ ownerSessionId: 'observer' }).capacity();
          if (expireReceipt) {
            const terminal = f.records()[0];
            terminal.retain_until = old;
            f.saveRecord(terminal);
            await f.dispatcher({ ownerSessionId: 'observer' }).capacity();
          }
        }
        return value;
      },
    }).dispatch({ task_id: '468', message: 'Approved' });
    assert.equal(result.accepted, true);
    assert.equal(f.sent.length, 1);
    if (expireReceipt) assert.match(result.receipt_warning, /Delivery accepted.*Do not resend/s);
    else {
      assert.equal(result.receipt_warning, undefined);
      const ack = ['session', '-Id', '468', '-DispatchOwner', 'coordinator-a', '-DispatchToken', result.dispatch_id, '-DispatchAccepted'];
      assert.equal((await f.oa(ack)).state, 'observed');
      assert.equal((await f.oa(ack)).state, 'observed', 'a repeated acknowledgment is idempotent');
    }
  });
}

test('the same worklist wake is not sent twice even after a fast completion retires its pending record', async t => {
  const f = fixture(t);
  f.add('468', { poll: true });
  const wakeKey = (await f.dispatcher().scan()).find(row => row.id === '468').wake_key;
  const first = await f.dispatcher({
    invokeTool: async (name, args, callId) => {
      const value = await f.invoke(name, args, callId);
      if (name === 'send_session_message') {
        f.receipt();
      }
      return value;
    },
  }).dispatch({ task_id: '468', wake_key: wakeKey, message: 'Approved once' });
  const second = await f.dispatcher({ ownerSessionId: 'racing-coordinator' })
    .dispatch({ task_id: '468', wake_key: wakeKey, message: 'Approved once' });
  assert.equal(second.already_delivered, true);
  assert.equal(second.dispatch_id, first.dispatch_id);
  assert.equal(f.sent.length, 1);
  fs.appendFileSync(path.join(f.paths.journal_dir, 'task-468.md'), '\n<!-- from: me -->\nA different requirement.\n');
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', wake_key: wakeKey, message: 'Outdated brief' }), /session_worklist_changed/);
  assert.equal(f.sent.length, 1);
});

test('read-only capacity audits reconcile the answer without writing receipt or generation files', async t => {
  const f = fixture(t);
  f.add('468');
  await f.dispatcher().dispatch({ task_id: '468', message: 'Approved' });
  f.receipt();
  const before = f.records();
  const generationFile = path.join(f.paths.state_dir, 'capacity-generation.json');
  const generation = fs.readFileSync(generationFile, 'utf8');
  const result = await f.dispatcher().capacity({ reconcile: false });
  assert.equal(result.in_flight, 0);
  assert.deepEqual(f.records(), before);
  assert.equal(fs.readFileSync(generationFile, 'utf8'), generation);
  await f.dispatcher().capacity();
  assert.equal(f.records()[0].state, 'observed');
});

for (const sameTask of [true, false]) {
  test(`simultaneous coordinator processes admit exactly one ${sameTask ? 'same-session' : 'different-session'} dispatch`, async t => {
    const f = fixture(t);
    f.add('468');
    if (!sameTask) f.add('399');
    const config = path.join(f.root, 'worker.json');
    writeJson(config, { paths: f.paths, sessionRoot: f.sessionRoot, subject: SUBJECT, root: f.root });
    const worker = path.join(HERE, 'oa-dispatch-worker.mjs');
    const outputs = await Promise.all(['a', 'b'].map((owner, i) =>
      exec(process.execPath, [worker, config, owner, sameTask || i === 0 ? '468' : '399'], { timeout: 120000 }),
    ));
    const results = outputs.map(output => JSON.parse(output.stdout));
    assert.equal(results.filter(result => result.accepted).length, 1, JSON.stringify(results));
    assert.match(results.find(result => !result.accepted).error, /session_(dispatch_pending|at_capacity)/);
    assert.equal(fs.readFileSync(path.join(f.root, 'sent.jsonl'), 'utf8').trim().split('\n').length, 1);
  });
}

test('receipt reconciliation ignores old completion, unrelated turns, newer-than-snapshot events and replaced logs', t => {
  const f = fixture(t);
  f.add('468');
  const token = 'a'.repeat(32);
  const record = { execution_id: 's-468', dispatch_id: token, log_cursor: eventCursor(f.sessionRoot, 's-468') };
  f.events('s-468', [{ type: 'session.task_complete', data: { success: true } }]);
  f.receipt({ session_id: 's-468', message: `Approved\n<!-- oa-dispatch:${token} -->` }, { start: false, end: false });
  f.events('s-468', [
    { type: 'assistant.turn_start', data: { interactionId: 'unrelated', turnId: 'other-turn' } },
    { type: 'assistant.turn_end', data: { turnId: 'other-turn' } },
  ]);
  const idle = { status: 'idle' };
  assert.equal(dispatchReceipt(record, idle, f.sessionRoot, new Date().toISOString()).status, 'pending');
  const earlier = new Date(Date.now() - 60000).toISOString();
  assert.equal(dispatchReceipt(record, idle, f.sessionRoot, earlier).status, 'pending');
  const file = path.join(f.sessionRoot, 's-468', 'events.jsonl');
  fs.renameSync(file, `${file}.old`);
  fs.writeFileSync(file, '');
  assert.equal(dispatchReceipt(record, idle, f.sessionRoot, new Date().toISOString()).status, 'unknown');
});

test('native result parsing fails explicitly on unavailable or truncated app output', () => {
  assert.throws(() => nativeResult('get_sessions_status', { resultType: 'failure', error: 'Offline' }), /Offline/);
  assert.throws(() => nativeResult('get_sessions_status', 'Output too large, see file'), /complete structured JSON/);
  assert.deepEqual(nativeResult('get_sessions_status', { resultType: 'success', structuredContent: { sessions: [] } }), { sessions: [] });
});

test('the installed plugin and normal run path invoke the native wrapper rather than leave an unused helper', () => {
  const pluginRoot = path.join(HERE, '..');
  const manifest = readJson(path.join(pluginRoot, 'plugin.json'));
  assert.ok(manifest.extensions.includes('extensions/task-dispatch'));
  const entry = fs.readFileSync(path.join(pluginRoot, 'extensions', 'task-dispatch', 'extension.mjs'), 'utf8');
  assert.match(entry, /session\.rpc\.tools\.execute/);
  for (const name of ['oa_scan', 'oa_capacity', 'oa_dispatch']) assert.ok(entry.includes(`name: '${name}'`));
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'overnight-agent', 'SKILL.md'), 'utf8');
  const phase = skill.slice(skill.indexOf('### PHASE 1 '), skill.indexOf('### PHASE 1.5'));
  assert.match(phase, /oa_dispatch.*EVERY task wake/);
  assert.match(phase, /oa_dispatch\(\{ task_id:/);
  assert.match(phase, /idle, without a kickoff/);
  assert.match(phase, /tools are missing,[\s\S]*?stop dispatch/);
  assert.doesNotMatch(phase, /session -Id N -ForDispatch/);
});
