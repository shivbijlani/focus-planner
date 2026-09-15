import assert from 'node:assert/strict';
import { classifyEvents, measureActivity } from './supervisor-activity.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const now = Date.parse('2026-09-15T12:00:00Z');
const options = { now, ownerStartedUtc: '2026-09-14T00:00:00Z' };
const start = { type: 'session.start', timestamp: '2026-09-14T00:00:01Z' };
const end = { type: 'assistant.turn_end', timestamp: '2026-09-14T01:00:00Z' };
const event = (type, data = {}, timestamp = '2026-09-14T00:10:00Z') => ({ type, data, timestamp });
const classify = events => classifyEvents(events.map(e => JSON.stringify(e)).join('\n'), options);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

test('long-open, genuinely idle conversation stays idle on a fresh observation', () => {
  assert.equal(classify([start, end]).state, 'IDLE');
});
for (const [begin, complete, id] of [
  ['tool.execution_start', 'tool.execution_complete', 'toolCallId'],
  ['external_tool.requested', 'external_tool.completed', 'requestId'],
  ['hook.start', 'hook.end', 'hookInvocationId'],
]) {
  test(`${begin}: silence and turn-end cannot complete an outstanding operation`, () => {
    assert.equal(classify([start, event(begin, { [id]: 'new' }), end]).state, 'BUSY');
  });
  test(`${begin}: old completion cannot clear a newer invocation`, () => {
    assert.equal(classify([start, event(complete, { [id]: 'old' }), event(begin, { [id]: 'new' }), end]).state, 'BUSY');
  });
  test(`${begin}: correlated completion permits idle`, () => {
    assert.equal(classify([start, event(begin, { [id]: 'new' }), event(complete, { [id]: 'new' }), end]).state, 'IDLE');
  });
}
test('task_complete is not an idle or coordination signal', () => {
  assert.equal(classify([start, event('assistant.turn_start'), event('session.task_complete')]).state, 'BUSY');
});
test('PID reuse invalidates prior incarnation evidence', () => {
  assert.equal(classifyEvents([start, end].map(e => JSON.stringify(e)).join('\n'), {
    ...options, ownerStartedUtc: '2026-09-15T00:00:00Z',
  }).state, 'UNKNOWN');
});
test('missing or invalid live-owner creation time cannot establish idle', () => {
  for (const ownerStartedUtc of [null, undefined, '', 'not-a-date']) {
    assert.equal(classifyEvents([start, end].map(e => JSON.stringify(e)).join('\n'), {
      ...options, ownerStartedUtc,
    }).state, 'UNKNOWN');
  }
});
test('partial logs, missing terminal turn and future clocks are unknown', () => {
  assert.equal(classifyEvents('{broken', options).state, 'UNKNOWN');
  assert.equal(classify([start]).state, 'UNKNOWN');
  assert.equal(classify([start, event('assistant.turn_end', {}, '2027-01-01T00:00:00Z')]).state, 'UNKNOWN');
});
test('tool invocation returning a background command is not proof of work ending', () => {
  assert.equal(classify([start, event('tool.execution_start', { toolCallId: 'a', toolName: 'powershell' }),
    event('tool.execution_complete', { toolCallId: 'a', result: 'command is still running' }), end]).state, 'UNKNOWN');
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-evidence-'));
try {
  const dbPath = path.join(root, 'app.db');
  const sessionRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionRoot);
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions(id TEXT, is_running INTEGER);
    CREATE TABLE workflows(id TEXT, name TEXT, enabled INTEGER, schedule TEXT);
    CREATE TABLE workflow_runs(id TEXT,task_id TEXT,session_id TEXT,status TEXT,trigger TEXT,started_at TEXT);
    INSERT INTO workflows VALUES('wf','Overnight Agent',1,'*/30 * * * *');
    INSERT INTO sessions VALUES('parent',0),('child',1),('manual',0);`);
  const procs = [
    { id: 101, path: path.join(root, 'copilot.exe'), startedUtc: options.ownerStartedUtc },
    { id: 102, path: path.join(root, 'copilot.exe'), startedUtc: options.ownerStartedUtc },
    { id: 103, path: path.join(root, 'copilot.exe'), startedUtc: options.ownerStartedUtc },
  ];
  const files = [];
  function write(id, pid, events) {
    const dir = path.join(sessionRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `inuse.${pid}.lock`), '');
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n'));
    files.push(file);
  }
  write('parent', 101, [start, event('session.task_complete'), end]);
  write('child', 102, [start, event('tool.execution_start', { toolCallId: 'long-child' })]);
  write('manual', 103, [start, end]);
  const input = { dbPath, sessionRoot, processes: procs, ownedIds: [101, 102, 103], now };
  const original = db.prepare('select * from workflows').all();
  test('a completed parent does not hide a child tool executing outside the workflow rows', () => {
    const got = measureActivity(input);
    assert.equal(got.state, 'BUSY');
    assert.equal(got.sessions.find(s => s.id === 'child').state, 'BUSY');
    assert.equal(got.sessions.find(s => s.id === 'manual').state, 'IDLE');
  });
  test('contradictory app flags and logs are unknown', () => {
    db.exec("UPDATE sessions SET is_running=0 WHERE id='child'");
    assert.equal(measureActivity(input).state, 'UNKNOWN');
  });
  test('freshly read old terminal logs and open conversations do not block quiet time', () => {
    fs.appendFileSync(files[1], `\n${JSON.stringify(event('tool.execution_complete', { toolCallId: 'long-child' }))}\n${JSON.stringify(end)}`);
    assert.equal(measureActivity(input).state, 'IDLE');
  });
  test('missing logs and unmatched resident hosts are unknown, never zero work', () => {
    assert.equal(measureActivity({ ...input, processes: [...procs, { id: 104, path: path.join(root, 'copilot.exe') }], ownedIds: [104] }).state, 'UNKNOWN');
    fs.unlinkSync(files[2]);
    assert.equal(measureActivity(input).state, 'UNKNOWN');
  });
  test('missing database/schema is unknown and no automation configuration is changed', () => {
    assert.equal(measureActivity({ ...input, dbPath: path.join(root, 'absent.db') }).state, 'UNKNOWN');
    assert.deepEqual(db.prepare('select * from workflows').all(), original);
  });
  db.close();
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`${passed} activity checks passed`);
