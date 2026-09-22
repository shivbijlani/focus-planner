import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const {
  createDrain, createDispatchGuard, createNativeAdapter, createPlanner,
  boundedToolCall, coordinatorStart, nextCutoff, eventCursor, readCompletion, toolResult,
} = await import(process.env.OA_DRAIN_SUBJECT ? pathToFileURL(process.env.OA_DRAIN_SUBJECT).href : './oa-dispatch.mjs');

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBJECT = path.join(HERE, '..', 'skills', 'overnight-agent', 'oa-state.ps1');
const PS = process.env.OA_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell' : 'pwsh');
const START = '2026-09-22T10:00:00Z';
const MINUTE = 60000;
const old = '2026-09-06T16:16:52-07:00';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function world(t, { limit = 1, start = START } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-drain-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = { root, clock: Date.parse(start), limit, sent: [], rows: [], durations: new Map(), lost: false };
  w.add = (id, duration = 5 * MINUTE, options = {}) => {
    w.rows.push({
      id, eligible: true, order: w.rows.length + 1, session_paused: false,
      session_id: `s-${id}`, dispatch_input: `input-${id}`, ...options,
    });
    w.durations.set(id, duration);
    return { task_id: id, dispatch_input: `input-${id}`, message: `Approved brief for ${id}`, collect_wave: options.collect_wave || false };
  };
  w.planner = {
    scan: async () => structuredClone(w.rows),
    limit: async () => w.limit,
    check: async (item, stamp) => {
      const row = w.rows.find(row => row.id === item.task_id);
      if (!row?.eligible || row.session_paused) throw new Error('session_not_eligible');
      if (row.dispatch_input !== item.dispatch_input) throw new Error('session_input_changed');
      if (item.collect_wave && !row.human) throw new Error('session_collect_evidence_required');
      return { dispatch_eligible: true, dispatch_authorised: Boolean(stamp), session_id: row.session_id };
    },
  };
  w.adapter = {
    resolve: async id => ({ id, cursor: { offset: 0, identity: 'fixture' } }),
    observe: async item => {
      const call = w.sent.find(call => call.token === item.token);
      if (!call) return 'working';
      return w.clock >= call.at + w.durations.get(item.task_id) ? 'completed' : 'working';
    },
    send: async item => {
      w.sent.push({ token: item.token, id: item.task_id, session: item.session_id, at: w.clock });
      if (w.lost) throw new Error('response lost after accepted');
    },
  };
  w.make = (run = 'run-a', overrides = {}) => createDrain({
    directory: path.join(root, run), coordinatorSessionId: run, startedAt: start,
    planner: w.planner, adapter: w.adapter, now: () => w.clock,
    wait: async milliseconds => { w.clock += milliseconds || MINUTE; }, pollMs: MINUTE, ...overrides,
  });
  return w;
}

test('N=1 starts the next task after five-minute completion instead of waiting for the next run', async t => {
  const w = world(t);
  const tasks = ['1', '2', '3'].map(id => w.add(id));
  const drain = w.make();
  await drain.prepare(tasks.reverse()); // Machine priority, not model submission order.
  const result = await drain.run();
  assert.equal(result.status, 'drained');
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2', '3']);
  assert.deepEqual(w.sent.map(item => item.at - Date.parse(START)), [0, 5 * MINUTE, 10 * MINUTE]);
  assert.equal(result.items.filter(item => item.state === 'completed').length, 3);
  assert.ok(result.items.every(item => !('message' in item) && !('cursor' in item)));
  assert.ok(readJson(path.join(w.root, 'run-a', 'oa-drain.json')).items.every(item => item.message));
});

test('N=2 refills either opening independently without waiting for the slower task', async t => {
  const w = world(t, { limit: 2 });
  const tasks = [w.add('1', 10 * MINUTE), w.add('2', 2 * MINUTE), w.add('3', 3 * MINUTE), w.add('4')];
  const drain = w.make();
  await drain.prepare(tasks);
  await drain.run();
  assert.deepEqual(w.sent.map(item => item.at - Date.parse(START)), [0, 0, 2 * MINUTE, 5 * MINUTE]);
  assert.equal(w.sent.length, 4, 'N is outstanding work, not total attempts');
});

test('at cutoff the old run stops sending and leaves its last task working', async t => {
  const w = world(t);
  const tasks = [w.add('1', 28 * MINUTE), w.add('2'), w.add('3')];
  const drain = w.make();
  await drain.prepare(tasks);
  const result = await drain.run();
  assert.equal(result.status, 'cutoff');
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2']);
  assert.equal(result.items.find(item => item.task_id === '2').state, 'accepted');
  assert.equal(result.items.find(item => item.task_id === '3').state, 'queued');
  assert.equal(w.clock, Date.parse('2026-09-22T10:30:00Z'));
});

for (const boundary of ['check', 'resolve', 'stamp', 'save']) {
  test(`deadline is checked after slow ${boundary} and immediately before native send`, async t => {
    const w = world(t);
    const task = w.add('1');
    const check = w.planner.check;
    w.planner.check = async (item, stamp) => {
      const result = await check(item, stamp);
      if (boundary === 'check' && !stamp || boundary === 'stamp' && stamp) w.clock += 31 * MINUTE;
      return result;
    };
    if (boundary === 'resolve') w.adapter.resolve = async id => {
      w.clock += 31 * MINUTE; return { id, cursor: { offset: 0, identity: 'fixture' } };
    };
    if (boundary === 'save') {
      const original = fs.renameSync;
      t.mock.method(fs, 'renameSync', (a, b) => {
        original(a, b);
        if (readJson(b).items?.some(item => item.state === 'sending')) w.clock += 31 * MINUTE;
      });
    }
    const drain = w.make();
    await drain.prepare([task]);
    assert.equal((await drain.run()).status, 'cutoff');
    assert.equal(w.sent.length, 0);
  });
}

test('a task exceeding five minutes remains outstanding; elapsed time never refills it', async t => {
  const w = world(t);
  const drain = w.make();
  await drain.prepare([w.add('1', 60 * MINUTE), w.add('2')]);
  const result = await drain.run();
  assert.equal(result.status, 'cutoff');
  assert.deepEqual(w.sent.map(item => item.id), ['1']);
});

test('unconfirmed send holds only this run opening and completion evidence can recover it', async t => {
  const w = world(t);
  const drain = w.make();
  w.lost = true;
  await drain.prepare([w.add('1'), w.add('2')]);
  const result = await drain.run();
  assert.equal(result.items.filter(item => item.state === 'completed').length, 2);
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2'], 'no retry of an uncertain instruction');
});

test('an old unresolved run does not reserve an opening in the next coordinator run', async t => {
  const w = world(t);
  const task = w.add('1', 60 * MINUTE);
  const first = w.make();
  await first.prepare([task]); await first.run();
  const next = w.make('run-b', { startedAt: '2026-09-22T10:30:00Z' });
  await next.prepare([task]); await next.run();
  assert.equal(w.sent.length, 2, 'same saved conversation may receive a later-run nudge');
  assert.equal(w.sent[1].at, Date.parse('2026-09-22T10:30:00Z'));
});

test('restart retains the deadline and queued/accepted work, not a fresh window or duplicate send', async t => {
  const w = world(t);
  const task = w.add('1');
  const drain = w.make('run-a', { wait: async () => { throw new Error('simulated host disconnect'); } });
  await drain.prepare([task, w.add('2')]);
  const stopped = await drain.run();
  assert.equal(stopped.status, 'error');
  w.clock += 5 * MINUTE;
  const resumed = w.make();
  assert.equal(resumed.status().cutoff, stopped.cutoff);
  const result = await resumed.run();
  assert.equal(result.status, 'drained');
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2']);
  await assert.rejects(() => resumed.prepare([task]), /already attempted/);
  assert.throws(() => w.make('run-a', { startedAt: '2026-09-22T10:30:00Z' }), /drain_state_invalid/);
});

test('a task waiting on the human is reported and frees this run opening without a repeat nudge', async t => {
  const w = world(t);
  const observe = w.adapter.observe;
  w.adapter.observe = async item => item.task_id === '1' ? 'waiting_for_user' : observe(item);
  const drain = w.make();
  await drain.prepare([w.add('1'), w.add('2')]);
  const result = await drain.run();
  assert.equal(result.items[0].state, 'waiting_for_user');
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2']);
});

test('unknown completion is visible and does not prevent another existing N=2 opening from refilling', async t => {
  const w = world(t, { limit: 2 });
  const observe = w.adapter.observe;
  w.adapter.observe = async item => {
    if (item.task_id === '1') throw new Error('Unreadable target history');
    return observe(item);
  };
  const drain = w.make();
  await drain.prepare([w.add('1'), w.add('2'), w.add('3')]);
  const result = await drain.run();
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2', '3']);
  assert.equal(w.sent[2].at - Date.parse(START), 5 * MINUTE);
  assert.match(result.items[0].observation_error, /Unreadable/);
});

test('priority, late pauses and changed task input are rechecked before sending', async t => {
  const w = world(t);
  const drain = w.make();
  await drain.prepare([w.add('1'), w.add('2'), w.add('3')]);
  w.rows[0].dispatch_input = 'human-changed';
  const resolve = w.adapter.resolve;
  w.adapter.resolve = async id => {
    if (id === 's-2') w.rows[1].session_paused = true;
    return resolve(id);
  };
  await drain.run();
  assert.deepEqual(w.sent.map(item => item.id), ['3']);
  assert.equal(drain.status().items[0].state, 'skipped');
  assert.equal(drain.status().items[1].state, 'skipped');
});

test('priority change during lookup causes a fresh selection rather than dispatching the lower row', async t => {
  const w = world(t);
  const drain = w.make();
  await drain.prepare([w.add('1'), w.add('2')]);
  const resolve = w.adapter.resolve;
  w.adapter.resolve = async id => {
    w.rows[1].order = 0;
    return resolve(id);
  };
  await drain.run();
  assert.deepEqual(w.sent.map(item => item.id), ['2', '1']);
});

test('two aliases to one execution are not both sent into this run concurrently', async t => {
  const w = world(t, { limit: 2 });
  const drain = w.make();
  w.adapter.resolve = async () => ({ id: 'same-execution', cursor: { offset: 0, identity: 'fixture' } });
  await drain.prepare([w.add('1'), w.add('2')]); await drain.run();
  assert.equal(w.sent[1].at - w.sent[0].at, 5 * MINUTE);
});

test('human collect exceptions require evidence and never override cutoff or pauses', async t => {
  const w = world(t);
  const tasks = [w.add('1'), w.add('2', 5 * MINUTE, { collect_wave: true, human: true }),
    w.add('3', 5 * MINUTE, { collect_wave: true }), w.add('4', 5 * MINUTE, { collect_wave: true, human: true, session_paused: true })];
  const drain = w.make(); await drain.prepare(tasks); const result = await drain.run();
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2']);
  assert.equal(w.sent[0].at, w.sent[1].at);
  assert.match(result.items[2].error, /collect_evidence/);
});

test('same task is attempted at most once per run even when still eligible after completion', async t => {
  const w = world(t); const task = w.add('1');
  const drain = w.make(); await drain.prepare([task]); await drain.run(); await drain.run();
  assert.equal(w.sent.length, 1);
  await assert.rejects(() => drain.prepare([task]), /already attempted/);
});

test('newly eligible prepared Deferred work is picked after Today finishes, without another model dispatch call', async t => {
  const w = world(t);
  const one = w.add('1'), two = w.add('2', 5 * MINUTE, { eligible: false });
  const observe = w.adapter.observe;
  w.adapter.observe = async item => {
    const outcome = await observe(item);
    if (item.task_id === '1' && outcome === 'completed') w.rows[1].eligible = true;
    return outcome;
  };
  const drain = w.make(); await drain.prepare([one, two]); await drain.run();
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2']);
  assert.equal(w.sent[1].at - w.sent[0].at, 5 * MINUTE);
});

test('an actual-loop native adapter observes local execution and refills without trusting an idle snapshot alone', async t => {
  const w = world(t);
  const f = eventsWorld(t);
  const one = w.add('1'), two = w.add('2');
  fs.mkdirSync(path.join(f.root, 's-2')); fs.writeFileSync(path.join(f.root, 's-2', 'events.jsonl'), '');
  const native = createNativeAdapter({
    sessionRoot: f.root,
    invokeTool: async (name, args) => {
      if (name === 'get_session') return JSON.stringify({ id: args.project_session_id, activity: { status: 'idle' }, is_running: false });
      assert.equal(name, 'send_session_message');
      w.sent.push({ session: args.session_id, at: w.clock });
      fs.appendFileSync(path.join(f.root, args.session_id, 'events.jsonl'),
        JSON.stringify({ type: 'user.message', data: { content: args.message, interactionId: args.session_id } }) + '\n');
      return { resultType: 'success', textResultForLlm: 'accepted' };
    },
  });
  const wait = async ms => {
    w.clock += ms;
    for (const sent of w.sent) {
      if (w.clock - sent.at < 5 * MINUTE || sent.finished) continue;
      sent.finished = true;
      fs.appendFileSync(path.join(f.root, sent.session, 'events.jsonl'), [
        { type: 'assistant.turn_start', data: { interactionId: sent.session, turnId: 'work' } },
        { type: 'assistant.turn_end', data: { turnId: 'work' } },
      ].map(event => JSON.stringify(event)).join('\n') + '\n');
    }
  };
  const drain = w.make('run-a', { adapter: native, wait });
  await drain.prepare([one, two]);
  assert.equal((await drain.run()).status, 'drained');
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[1].at - w.sent[0].at, 5 * MINUTE);
});

test('concurrent run calls share one loop and queue preparation cannot race', async t => {
  const w = world(t);
  let release;
  const scan = w.planner.scan;
  w.planner.scan = () => new Promise(resolve => { release = () => resolve(scan()); });
  const drain = w.make(); const task = w.add('1');
  const preparing = drain.prepare([task]);
  await assert.rejects(() => drain.prepare([task]), /drain_running/);
  assert.throws(() => drain.run(), /drain_preparing/);
  release(); await preparing; w.planner.scan = scan;
  await Promise.all([drain.run(), drain.run()]);
  assert.equal(w.sent.length, 1);
});

test('bad state and unknown start refuse rather than resetting the run', async t => {
  const w = world(t); w.make();
  writeJson(path.join(w.root, 'run-a', 'oa-drain.json'), { invalid: true });
  assert.throws(() => w.make(), /drain_state_invalid/);
  assert.throws(() => nextCutoff('unknown'), /drain_start_unknown/);
  assert.equal(nextCutoff('2026-09-22T10:07:00Z'), '2026-09-22T10:30:00.000Z');
});

test('a post-send save failure never frees the outstanding instruction or launches another task', async t => {
  const w = world(t);
  const original = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && readJson(from).items?.some(item => item.state === 'accepted')) {
      failed = true; throw new Error('Transient save failure after send');
    }
    return original(from, to);
  });
  const drain = w.make();
  await drain.prepare([w.add('1'), w.add('2')]);
  const result = await drain.run();
  assert.equal(result.status, 'error');
  assert.equal(result.items[0].state, 'accepted');
  assert.deepEqual(w.sent.map(item => item.id), ['1']);
  w.clock += 5 * MINUTE;
  await w.make().run();
  assert.deepEqual(w.sent.map(item => item.id), ['1', '2']);
});

test('preparation rejects a stale brief rather than assigning it the newest fingerprint', async t => {
  const w = world(t); const task = w.add('1');
  w.rows[0].dispatch_input = 'changed-human-input';
  const drain = w.make();
  await assert.rejects(() => drain.prepare([task]), /changed after its brief/);
  assert.deepEqual(drain.status().items, []);
});

test('bounded native calls return by their deadline without claiming cancellation or success', async () => {
  await assert.rejects(() => boundedToolCall(() => new Promise(() => {}), new Date(Date.now() + 5000).toISOString(), Date.now, 5), /did not confirm/);
  let called = false;
  await assert.rejects(() => boundedToolCall(() => { called = true; }, new Date(0).toISOString()), /drain_cutoff/);
  assert.equal(called, false);
});

function eventsWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-events-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 's-1'));
  const file = path.join(root, 's-1', 'events.jsonl'); fs.writeFileSync(file, '');
  const append = data => fs.appendFileSync(file, JSON.stringify(data) + '\n');
  const item = { session_id: 's-1', token: 'abc', cursor: eventCursor(root, 's-1') };
  return { root, file, append, item };
}

test('idle before accepted message starts and unrelated completion never release an opening', async t => {
  const f = eventsWorld(t);
  const adapter = createNativeAdapter({ sessionRoot: f.root, invokeTool: async () => JSON.stringify({
    id: 's-1', activity: { status: 'idle' }, is_running: false,
  }) });
  f.append({ type: 'session.task_complete', data: { success: true } });
  assert.equal(await adapter.observe(f.item), 'working');
  f.append({ type: 'user.message', data: { content: '<!-- oa-drain:abc -->', interactionId: 'ours' } });
  f.append({ type: 'assistant.turn_start', data: { interactionId: 'other', turnId: '1' } });
  f.append({ type: 'assistant.turn_end', data: { turnId: '1' } });
  assert.equal(await adapter.observe(f.item), 'working');
  f.append({ type: 'assistant.turn_start', data: { interactionId: 'ours', turnId: '2' } });
  assert.equal(await adapter.observe(f.item), 'working');
  f.append({ type: 'assistant.turn_end', data: { turnId: '2' } });
  assert.equal(await adapter.observe(f.item), 'completed');
});

test('observed completion is read before current idle status; busy after a turn end is not finished', async t => {
  const f = eventsWorld(t);
  f.append({ type: 'user.message', data: { content: '<!-- oa-drain:abc -->', interactionId: 'ours' } });
  f.append({ type: 'assistant.turn_start', data: { interactionId: 'ours', turnId: '2' } });
  f.append({ type: 'assistant.turn_end', data: { turnId: '2' } });
  const adapter = createNativeAdapter({ sessionRoot: f.root, invokeTool: async () => JSON.stringify({
    id: 's-1', activity: { status: 'busy' }, is_running: true,
  }) });
  assert.equal(await adapter.observe(f.item), 'working');
});

test('event-source errors and unknown app status remain explicit, not silently completed', async t => {
  const f = eventsWorld(t);
  fs.renameSync(f.file, `${f.file}.old`); fs.writeFileSync(f.file, '');
  assert.throws(() => readCompletion(f.root, f.item), /replaced/);
  const adapter = createNativeAdapter({ sessionRoot: f.root, invokeTool: async () => JSON.stringify({ id: 's-1', activity: { status: 'unknown' } }) });
  await assert.rejects(() => adapter.observe({ ...f.item, cursor: eventCursor(f.root, 's-1') }), /unknown/);
  assert.throws(() => toolResult('get_session', 'truncated response'), /structured JSON/);
});

test('a new local session can start without a log but is not complete until its marked work finishes', async t => {
  const f = eventsWorld(t);
  fs.unlinkSync(f.file);
  const adapter = createNativeAdapter({ sessionRoot: f.root, invokeTool: async () => JSON.stringify({
    id: 's-1', session_type: 'folder', path: f.root, activity: { status: 'idle' }, is_running: false,
  }) });
  const target = await adapter.resolve('s-1');
  const item = { ...f.item, cursor: target.cursor };
  assert.equal(target.cursor.exists, false);
  await assert.rejects(() => adapter.observe(item), /ENOENT/);
  f.append({ type: 'user.message', data: { content: '<!-- oa-drain:abc -->', interactionId: 'ours' } });
  assert.equal(await adapter.observe(item), 'working');
  f.append({ type: 'assistant.turn_start', data: { interactionId: 'ours', turnId: '1' } });
  f.append({ type: 'assistant.turn_end', data: { turnId: '1' } });
  assert.equal(await adapter.observe(item), 'completed');
});
test('coordinator deadline comes from the first real prompt, not tool invocation or reload time', async t => {
  const f = eventsWorld(t);
  f.append({ type: 'session.start', timestamp: '2026-09-22T09:58:00Z' });
  f.append({ type: 'user.message', timestamp: '2026-09-22T10:00:00Z' });
  f.append({ type: 'user.message', timestamp: '2026-09-22T10:40:00Z' });
  assert.equal(await coordinatorStart(path.dirname(f.file)), START);
  assert.equal(nextCutoff(await coordinatorStart(path.dirname(f.file))), '2026-09-22T10:30:00.000Z');
});

test('native hook denies bypass wakes, kickoff creation and premature completion; exact scheduler send is permitted once', async () => {
  let now = Date.parse(START), busy = true, enrolled = true;
  const guard = createDispatchGuard({ enrolled: () => enrolled, busy: () => busy,
    cutoff: () => '2026-09-22T10:30:00Z', now: () => now });
  const args = { session_id: 's-1', message: 'approved', delivery_mode: 'immediate' };
  assert.equal(guard.before('send_session_message', args)?.permissionDecision, 'deny');
  await guard.send(args, async () => {
    assert.equal(guard.before('functions.send_session_message', args), undefined);
    assert.equal(guard.before('send_session_message', args).permissionDecision, 'deny');
  });
  assert.equal(guard.before('create_session', { kickoff: { prompt: 'bypass' } }).permissionDecision, 'deny');
  assert.equal(guard.before('create_session', {}), undefined, 'idle preparation still allowed');
  assert.equal(guard.before('task_complete', {}).permissionDecision, 'deny');
  busy = false;
  assert.equal(guard.before('task_complete', {}), undefined);
  now = Date.parse('2026-09-22T10:30:00Z');
  await assert.rejects(() => guard.send(args, async () => {}), /drain_cutoff/);
  enrolled = false;
  assert.equal(guard.before('send_session_message', args), undefined, 'ordinary task sessions are not coordinators');
});

test('the actual state helper enforces pause, input freshness and unchanged Today-first ordering', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-state-drain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = {
    state_dir: path.join(root, 'state'), journal_dir: path.join(root, 'journal'),
    planner_board: path.join(root, 'planner.md'), planner_completed: path.join(root, 'completed.md'),
    snooze_store: path.join(root, 'snooze.json'), user_settings: path.join(root, 'settings.md'),
  };
  fs.mkdirSync(paths.state_dir); fs.mkdirSync(paths.journal_dir);
  fs.writeFileSync(paths.planner_board, '## Today\n\n| ID | Task |\n|---|---|\n| 1 | One |\n\n## Deferred\n\n| ID | Task |\n|---|---|\n| 2 | Two |\n');
  fs.writeFileSync(paths.planner_completed, ''); writeJson(paths.snooze_store, {});
  fs.writeFileSync(paths.user_settings, '| Setting | Value |\n|---|---|\n| Overnight Agent concurrency | 2 |\n');
  for (const id of ['1', '2']) {
    fs.writeFileSync(path.join(paths.journal_dir, `task-${id}.md`), `# Task ${id}\n\n## \u{1F319} Overnight Agent\n<!-- from: overnight-agent -->\n<!-- oa-ask: none -->\n**Status:** In progress.\n<!-- /overnight-agent turn-end -->\n`);
    writeJson(path.join(paths.state_dir, `task-${id}.json`), {
      id, status: 'in-progress', status_by: 'agent', updated: old,
      session: { session_id: `s-${id}`, state: 'live', kind: 'folder', workspace_type: 'folder', workspace: '',
        created_at: old, last_woken_at: old },
    });
  }
  const planner = createPlanner({ paths, scriptPath: SUBJECT, psExe: PS });
  assert.equal(await planner.limit(), 2);
  const rows = await planner.scan();
  assert.equal(rows[0].id, '1'); assert.equal(rows[1].eligible, false);
  const task = { task_id: '1', message: 'approved', dispatch_input: rows[0].dispatch_input };
  assert.equal((await planner.check(task)).dispatch_authorised, false);
  assert.equal((await planner.check(task, true)).dispatch_authorised, true);
  const file = path.join(paths.state_dir, 'task-1.json');
  const state = readJson(file); state.status = 'blocked'; state.status_by = 'user'; writeJson(file, state);
  await assert.rejects(() => planner.check(task, true), /session_not_dispatchable/);
  state.status = 'in-progress'; state.status_by = 'agent'; writeJson(file, state);
  fs.appendFileSync(path.join(paths.journal_dir, 'task-1.md'), '\n<!-- from: me -->\nNew instruction\n');
  await assert.rejects(() => planner.check(task, true), /session_input_changed/);
  const plain = await exec(PS, ['-NoProfile', '-File', SUBJECT, 'session', '-InFlight', '-StateDir', paths.state_dir, '-UserSettings', paths.user_settings]);
  assert.equal(JSON.parse(plain.stdout).scope, 'run_local_concurrency');
});

test('normal extension starts the autonomous loop, resumes it, and wires the bypass hook', () => {
  const entry = fs.readFileSync(path.join(HERE, '..', 'extensions', 'task-dispatch', 'extension.mjs'), 'utf8');
  assert.match(entry, /onPreToolUse/);
  assert.match(entry, /guard\?\.before/);
  assert.match(entry, /existing\?\.status === 'running'/);
  assert.match(entry, /drain\.run\(\)/);
  assert.match(entry, /coordinatorStart\(session\.workspacePath\)/);
  assert.match(entry, /guard\.send\(args, invoke\)/);
  assert.doesNotMatch(entry, /oa_run_budget|name: 'oa_dispatch'/);
});

test('actual extension handlers start a second batch even while the first completion log is pending', async () => {
  // Execute the real entry's handlers with an injected host, not a reimplementation of start().
  const source = fs.readFileSync(path.join(HERE, '..', 'extensions', 'task-dispatch', 'extension.mjs'), 'utf8')
    .replace(/^import .+;\r?\n/gm, '');
  let registration, calls = 0, resolveLog, status = { paths: {}, cutoff: '2099-01-01T00:00:00Z', items: [], status: 'ready' };
  const scheduler = {
    status: () => structuredClone(status),
    prepare: async tasks => { status.items.push(...tasks); },
    run: async () => { calls++; status.status = 'drained'; return scheduler.status(); },
  };
  const host = {
    workspacePath: path.join(os.tmpdir(), 'not-a-real-drain-session'), sessionId: 'host-fixture',
    rpc: { tools: { execute: async () => ({ resultType: 'success', textResultForLlm: 'ok' }) } },
    log: () => new Promise(resolve => { resolveLog = resolve; }),
  };
  const load = new (Object.getPrototypeOf(async function () {}).constructor)(
    'fs', 'path', 'sleep', 'joinSession', 'boundedToolCall', 'coordinatorStart', 'createDrain',
    'createDispatchGuard', 'createNativeAdapter', 'createPlanner', source);
  await load({ existsSync: () => false }, path, async () => {}, async options => { registration = options; return host; },
    boundedToolCall, async () => START, () => scheduler, createDispatchGuard, () => ({}), () => ({}));
  const drainTool = registration.tools.find(tool => tool.name === 'oa_drain');
  await drainTool.handler({ tasks: [{ task_id: '1', message: 'first', dispatch_input: 'x' }] });
  await drainTool.handler({ tasks: [{ task_id: '2', message: 'second', dispatch_input: 'y' }] });
  assert.equal(calls, 2);
  assert.equal((await registration.hooks.onPreToolUse({ toolName: 'send_session_message', toolArgs: {} })).permissionDecision, 'deny');
  resolveLog();
});
