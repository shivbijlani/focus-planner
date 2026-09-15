import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDispatcher, createRunBudget } from './oa-dispatch.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBJECT = path.join(HERE, '..', 'skills', 'overnight-agent', 'oa-state.ps1');
const PS = process.env.OA_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell' : 'pwsh');
const old = '2026-09-06T16:16:52-07:00';
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-per-run-test-'));
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
  const tasks = new Map(), budgets = new Map(), calls = [];
  const f = { root, paths, calls, limit: 1 };
  f.setLimit = limit => {
    f.limit = limit;
    fs.writeFileSync(paths.user_settings, `| Setting | Value |\n|---|---|\n| Overnight Agent concurrency | ${limit} |\n`);
  };
  f.setLimit(1);
  f.stateFile = id => path.join(paths.state_dir, `task-${id}.json`);
  f.budgetFile = run => path.join(root, 'runs', run, 'oa-run-budget.json');
  f.runBudget = (run = 'run-a', reload = false) => {
    if (!budgets.has(run) || reload) budgets.set(run, createRunBudget({
      directory: path.join(root, 'runs', run), coordinatorSessionId: run,
    }));
    return budgets.get(run);
  };
  f.add = (id, options = {}) => {
    id = String(id);
    const state = {
      id, status: options.status || 'in-progress', status_by: options.statusBy || 'agent',
      updated: old, version: 1, plan_id: '', seeded: false, processed_file_hash: '', has_agent_block: true,
      session: options.unbound ? null : {
        session_id: options.sessionId || `s-${id}`, state: 'live', kind: 'folder', project: 'fixture',
        workspace: '', workspace_type: 'folder', created_at: old, last_woken_at: old,
        prior_session_id: '', replaced_at: '',
      },
    };
    if (options.poll) state.poll = { cadence: 'daily', interval_minutes: 1440, next_due: old };
    writeJson(f.stateFile(id), state);
    let journal = `# Task ${id}: Fixture\n\n## \u{1F319} Overnight Agent\n<!-- from: overnight-agent -->\n` +
      `<!-- oa-ask: ${options.ask || 'none'} -->\n**Status:** In progress.\n` +
      '**Needs from you:** nothing blocking.\n<!-- /overnight-agent turn-end -->\n';
    if (options.reply) journal += '\n<!-- from: me -->\nPlease continue the approved plan.\n';
    fs.writeFileSync(path.join(paths.journal_dir, `task-${id}.md`), journal);
    tasks.set(id, options.section || 'today');
    fs.writeFileSync(paths.planner_board, ['today', 'deferred'].map(section =>
      `## ${section === 'today' ? 'Today' : 'Deferred'}\n\n| ID | Task |\n|---|---|\n` +
      [...tasks].filter(([, value]) => value === section).map(([key]) => `| ${key} | Fixture |\n`).join(''),
    ).join('\n'));
    return state;
  };
  f.dispatcher = (run = 'run-a', overrides = {}) => createDispatcher({
    runBudget: f.runBudget(run), paths, scriptPath: SUBJECT, psExe: PS,
    invokeTool: async (name, args) => {
      assert.equal(name, 'send_session_message', 'activity lookups and receipt tracking are not part of the per-run policy');
      const request = readJson(f.budgetFile(run)).requests.at(-1);
      assert.ok(Date.parse(readJson(f.stateFile(request.task_id)).session.last_woken_at) > Date.parse(old),
        'record the wake before the native send');
      calls.push(args);
      if (f.lostResponse) throw new Error('Response lost after the app accepted the instruction');
      return { resultType: 'success', textResultForLlm: 'Message accepted for priority delivery' };
    },
    ...overrides,
  });
  f.oa = async args => {
    const flags = ['-StateDir', paths.state_dir, '-JournalDir', paths.journal_dir,
      '-PlannerBoard', paths.planner_board, '-PlannerCompleted', paths.planner_completed,
      '-SnoozeStore', paths.snooze_store, '-UserSettings', paths.user_settings];
    const { stdout } = await exec(PS, ['-NoProfile', '-NonInteractive', '-File', SUBJECT, ...args, ...flags]);
    return JSON.parse(stdout);
  };
  return f;
}

test('idle saved sessions and overdue reminders do not spend the new run allowance', async t => {
  const f = fixture(t);
  f.add('468', { poll: true });
  f.add('228', { section: 'deferred', poll: true, ask: 'blocking' });
  writeJson(path.join(f.paths.state_dir, 'capacity-generation.json'), { invalidOldPrototypeData: true });
  fs.writeFileSync(path.join(f.paths.state_dir, 'dispatch-old.json'), '{broken legacy receipt');
  const before = fs.readFileSync(f.stateFile('228'), 'utf8');
  const budget = await f.dispatcher().budget();
  assert.equal(budget.attempted_this_run, 0);
  assert.equal(budget.remaining_this_run, 1);
  assert.deepEqual(budget.requests, []);
  assert.equal(fs.readFileSync(f.stateFile('228'), 'utf8'), before);
  assert.equal(fs.existsSync(f.budgetFile('run-a')), false, 'a budget inspection does not write or reset anything');
  await f.dispatcher().dispatch({ task_id: '468', message: 'Continue the approved Today task.' });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.dispatcher().budget()).remaining_this_run, 0);
});

test('a new run may start task228 while task468 from the earlier run is still working', async t => {
  const f = fixture(t);
  f.add('468');
  f.add('228');
  await f.dispatcher('ten-oclock').dispatch({ task_id: '468', message: 'Start long work.' });
  // No completion, activity update, receipt or release occurs between these runs.
  assert.equal((await f.dispatcher('ten-thirty').budget()).remaining_this_run, 1);
  await f.dispatcher('ten-thirty').dispatch({ task_id: '228', message: 'Start the other approved task.' });
  assert.deepEqual(f.calls.map(call => call.session_id), ['s-468', 's-228']);
});

test('another run may nudge the same saved session again without replacing it', async t => {
  const f = fixture(t);
  f.add('468');
  await f.dispatcher('first').dispatch({ task_id: '468', message: 'Continue task468.' });
  await f.dispatcher('second').dispatch({ task_id: '468', message: 'Continue task468.' });
  assert.deepEqual(f.calls.map(call => call.session_id), ['s-468', 's-468']);
  assert.equal(f.calls[0].message, 'Continue task468.', 'no receipt marker is added');
  assert.equal(readJson(f.stateFile('468')).session.session_id, 's-468');
});

test('one run cannot send more than its configured number of automatic attempts', async t => {
  const f = fixture(t);
  f.add('468'); f.add('228');
  await f.dispatcher().dispatch({ task_id: '468', message: 'Continue.' });
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '228', message: 'Another request.' }), /run_budget_exhausted/);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.dispatcher().budget()).attempted_this_run, 1);
});

test('parallel tool calls within one coordinator are sent sequentially and share one counter', async t => {
  const f = fixture(t);
  f.add('468'); f.add('228');
  const outcomes = await Promise.allSettled([
    f.dispatcher().dispatch({ task_id: '468', message: 'First.' }),
    f.dispatcher().dispatch({ task_id: '228', message: 'Second.' }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /run_budget_exhausted/);
  assert.equal(f.calls.length, 1);
});

test('a tool reload in the same run retains its counter; a new coordinator session starts at zero', async t => {
  const f = fixture(t);
  f.add('468');
  await f.dispatcher().dispatch({ task_id: '468', message: 'Continue.' });
  f.runBudget('run-a', true);
  assert.equal((await f.dispatcher().budget()).remaining_this_run, 0);
  assert.equal((await f.dispatcher('new-run').budget()).remaining_this_run, 1);
});

test('the counter counts requests, not distinct conversations or occupied workers', async t => {
  const f = fixture(t);
  f.setLimit(3);
  f.add('400', { sessionId: 'shared-session' });
  f.add('480', { sessionId: 'shared-session' });
  await f.dispatcher().dispatch({ task_id: '400', message: 'First request.' });
  await f.dispatcher().dispatch({ task_id: '480', message: 'Second request.' });
  await f.dispatcher().dispatch({ task_id: '400', message: 'Another nudge to the same task.' });
  const budget = await f.dispatcher().budget();
  assert.equal(budget.attempted_this_run, 3);
  assert.equal(budget.remaining_this_run, 0);
  assert.deepEqual(budget.requests.map(request => request.task_id), ['400', '480', '400']);
  assert.deepEqual(f.calls.map(call => call.session_id), ['shared-session', 'shared-session', 'shared-session']);
});

test('a failed or unconfirmed send consumes only this run budget and does not block the next run', async t => {
  const f = fixture(t);
  f.add('468');
  f.lostResponse = true;
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Continue.' }), /dispatch_not_confirmed/);
  assert.equal((await f.dispatcher().budget()).remaining_this_run, 0);
  f.lostResponse = false;
  await f.dispatcher('next-run').dispatch({ task_id: '468', message: 'Continue again.' });
  assert.equal(f.calls.length, 2, 'repeated nudges are permitted across runs');
  assert.equal(fs.readdirSync(f.paths.state_dir).some(name => /^(dispatch-|capacity-generation)/.test(name)), false);
});

test('native rejection or an empty response is reported, not presented as acceptance', async t => {
  const f = fixture(t);
  f.add('468');
  for (const [run, response] of [['rejected', { resultType: 'failure', textResultForLlm: 'Cannot deliver' }], ['empty', '']]) {
    await assert.rejects(() => f.dispatcher(run, { invokeTool: async () => response })
      .dispatch({ task_id: '468', message: 'Continue.' }), /dispatch_not_confirmed/);
    assert.equal((await f.dispatcher(run).budget()).remaining_this_run, 0);
  }
});

test('explicit pauses and ineligible Deferred tasks cannot be nudged or spend the quota', async t => {
  const f = fixture(t);
  const paused = f.add('468', { status: 'blocked', statusBy: 'user', poll: true });
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '468', message: 'Do not send.', collect_wave: true }), /session_not_dispatchable/);
  assert.deepEqual(readJson(f.stateFile('468')), paused);
  f.add('399');
  f.add('228', { section: 'deferred' });
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '228', message: 'Not ahead of Today.' }), /session_not_eligible/);
  assert.equal((await f.dispatcher().budget()).attempted_this_run, 0);
  assert.equal(f.calls.length, 0);
});

test('a pause arriving after the initial check still stops the actual send', async t => {
  const f = fixture(t);
  f.add('468');
  const budget = f.runBudget();
  const guarded = { ...budget, record(id, collect) {
    budget.record(id, collect);
    const state = readJson(f.stateFile(id));
    state.status = 'blocked'; state.status_by = 'user';
    writeJson(f.stateFile(id), state);
  } };
  await assert.rejects(() => f.dispatcher('run-a', { runBudget: guarded })
    .dispatch({ task_id: '468', message: 'Approved before the pause.' }), /session_not_dispatchable/);
  assert.equal(f.calls.length, 0);
  assert.equal(readJson(f.stateFile('468')).session.last_woken_at, old);
  assert.equal((await f.dispatcher().budget()).attempted_this_run, 1, 'a late-aborted attempt is not silently retried');
});

test('human collect requests remain an explicit exception, not a way to bypass pauses or manufacture approval', async t => {
  const f = fixture(t);
  f.add('468'); f.add('228', { poll: true });
  await f.dispatcher().dispatch({ task_id: '468', message: 'Priority request.' });
  await assert.rejects(() => f.dispatcher().dispatch({ task_id: '228', message: 'Timer only.', collect_wave: true }), /session_collect_evidence_required/);
  fs.appendFileSync(path.join(f.paths.journal_dir, 'task-228.md'), '\n<!-- from: me -->\nPlease do the approved check.\n');
  await f.dispatcher().dispatch({ task_id: '228', message: 'Human-triggered request.', collect_wave: true });
  const budget = await f.dispatcher().budget();
  assert.equal(budget.attempted_this_run, 1);
  assert.equal(budget.collect_attempted_this_run, 1);
  assert.equal(budget.remaining_this_run, 0);
});

test('an unreadable or different-run counter is reported rather than reset', async t => {
  const f = fixture(t);
  f.add('468');
  fs.mkdirSync(path.dirname(f.budgetFile('run-a')), { recursive: true });
  fs.writeFileSync(f.budgetFile('run-a'), '{broken');
  await assert.rejects(() => f.dispatcher().budget(), /run_budget_invalid/);
  writeJson(f.budgetFile('run-a'), { version: 1, coordinator_session_id: 'someone-else', requests: [] });
  await assert.rejects(() => f.dispatcher().budget(), /run_budget_invalid/);
  assert.equal(f.calls.length, 0);
});

test('creating or binding an idle conversation does not spend a request', async t => {
  const f = fixture(t);
  f.add('468', { unbound: true });
  await f.oa(['session', '-Id', '468', '-SessionId', 's-468', '-SessionKind', 'folder']);
  assert.equal((await f.dispatcher().budget()).attempted_this_run, 0);
  assert.equal(readJson(f.stateFile('468')).session.last_woken_at, '');
  await f.dispatcher().dispatch({ task_id: '468', message: 'First kickoff through the counted path.' });
  assert.equal((await f.dispatcher().budget()).attempted_this_run, 1);
});

test('normal run wiring shares the counter and contains no cross-run activity or reservation machinery', () => {
  const entry = fs.readFileSync(path.join(HERE, '..', 'extensions', 'task-dispatch', 'extension.mjs'), 'utf8');
  assert.match(entry, /runBudget \?\?= createRunBudget/);
  assert.match(entry, /name: 'oa_run_budget'/);
  assert.match(entry, /name: 'oa_dispatch'/);
  const helper = fs.readFileSync(path.join(HERE, 'oa-dispatch.mjs'), 'utf8');
  assert.doesNotMatch(helper, /get_sessions_status|dispatchReceipt|generation|last_woken_at|setTimeout/);
  const skill = fs.readFileSync(path.join(HERE, '..', 'skills', 'overnight-agent', 'SKILL.md'), 'utf8');
  assert.match(skill, /oa_run_budget/);
  assert.match(skill, /oa_dispatch\(\{ task_id:/);
  assert.doesNotMatch(skill, /wake_key|oa_scan|oa_capacity|dispatch_reconciliation_required/);
});
