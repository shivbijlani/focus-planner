#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCoordinatorGuard } from './coordinator-guard-sweep.mjs';
import {
  decideToolUse, hardEndFor, sleepDurationMs,
} from '../extensions/coordinator-guard/guard-policy.mjs';

const start = { startedAt: '2026-09-29T14:30:10.000Z', runId: 'coordinator' };
const call = (overrides = {}, entries = [start]) => decideToolUse({
  entries,
  sessionId: 'coordinator',
  toolName: 'get_sessions_status',
  toolArgs: {},
  now: '2026-09-29T14:40:00.000Z',
  ...overrides,
});

assert.equal(call({ sessionId: 'task-session' }).active, false);
assert.equal(hardEndFor(start.startedAt).toISOString(), '2026-09-29T14:59:00.000Z');
assert.equal(call().decision, 'pass');
assert.equal(call({ toolName: 'task_complete', now: '2026-09-29T14:59:01.000Z' }).decision, 'pass');
assert.match(call({ now: '2026-09-29T14:59:01.000Z' }).reason, /hard end/);
assert.equal(sleepDurationMs('powershell', { command: 'Start-Sleep -Seconds 120' }), 120000);
assert.match(call({
  toolName: 'powershell',
  toolArgs: { command: 'Start-Sleep 120' },
  now: '2026-09-29T14:58:00.000Z',
}).reason, /cross/);

const firstSend = call({
  toolName: 'send_session_message',
  toolArgs: { session_id: 'task-a', message: 'work' },
});
assert.equal(firstSend.decision, 'pass');
const secondSend = call({
  toolName: 'send_session_message',
  toolArgs: { session_id: 'task-a', message: 'nudge' },
}, [start, firstSend.record]);
assert.match(secondSend.reason, /already attempted/);
assert.equal(call({
  toolName: 'send_session_message',
  toolArgs: { session_id: 'task-b', message: 'work' },
}, [start, firstSend.record]).decision, 'pass');
assert.equal(call({
  toolName: 'create',
  toolArgs: { path: 'journal\\task-9408-budget-review.md', content: 'work' },
  env: { USERPROFILE: 'C:\\Users\\shiv' },
  cwd: 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner',
}).decision, 'deny');
assert.match(call({
  toolName: 'edit',
  toolArgs: { path: 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner\\journal\\task-9408.md' },
  env: { USERPROFILE: 'C:\\Users\\shiv' },
  cwd: 'C:\\work',
}).reason, /planner folder/);
assert.equal(call({
  toolName: 'create',
  toolArgs: { path: 'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent\\.turn-9408.md' },
  env: { USERPROFILE: 'C:\\Users\\shiv' },
  cwd: 'C:\\work',
}).decision, 'pass');
assert.equal(call({
  toolName: 'create',
  toolArgs: { path: 'journal\\task-9408.md' },
  env: { OVERNIGHT_AGENT_PLANNER_DIR: 'C:\\planner-copy' },
  cwd: 'C:\\planner-copy',
}).decision, 'deny');
assert.equal(call({
  sessionId: 'task-session',
  toolName: 'create',
  toolArgs: { path: 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner\\journal\\task-9408.md' },
  env: { USERPROFILE: 'C:\\Users\\shiv' },
  cwd: 'C:\\work',
}).active, false);

assert.equal(verifyCoordinatorGuard([
  start, firstSend.record,
  call({ toolName: 'task_complete', now: '2026-09-29T14:59:01.000Z' }).record,
]).ok, true);
assert.equal(verifyCoordinatorGuard([start]).ok, false);
assert.equal(verifyCoordinatorGuard([
  start, firstSend.record, { ...firstSend.record, at: '2026-09-29T14:45:00.000Z' },
]).ok, false);
assert.equal(verifyCoordinatorGuard([
  start, { ...call().record, at: '2026-09-29T14:59:01.000Z' },
]).ok, false);

const sourcePath = new URL('../extensions/coordinator-guard/guard-policy.mjs', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const mutations = [
  ['coordinator-only', "entry?.runId === sessionId", "entry?.runId !== sessionId"],
  ['hard-end', "at >= hardEnd", "at < hardEnd"],
  ['task-complete-exception', "tool !== 'task_complete'", "tool === 'task_complete'"],
  ['sleep-crossing', "at.getTime() + sleepMs >= hardEnd.getTime()", "at.getTime() + sleepMs < hardEnd.getTime()"],
  ['duplicate-send', "entry.targetSessionId === target", "entry.targetSessionId !== target"],
  ['planner-write-rule', "FILE_WRITE_TOOLS.has(tool)", "false && FILE_WRITE_TOOLS.has(tool)"],
  ['planner-path-check', "isUnderDir(targetPath, plannerDirFromEnv(env), cwd)", "!isUnderDir(targetPath, plannerDirFromEnv(env), cwd)"],
  ['planner-active-only', "if (!run) return { active: false };", "if (!run) { /* mutated: active outside coordinator run */ }"],
];
const temp = mkdtempSync(path.join(tmpdir(), 'oa-coordinator-guard-'));
try {
  for (const [name, find, replacement] of mutations) {
    assert.equal(source.split(find).length, 2, `${name}: mutation target`);
    const mutant = path.join(temp, `${name}.mjs`);
    writeFileSync(mutant, source.replace(find, replacement));
    const policy = await import(`${pathToFileURL(mutant).href}?${name}`);
    let killed = false;
    try {
      assert.equal(policy.decideToolUse({
        entries: [start], sessionId: 'task-session', toolName: 'get_sessions_status',
        toolArgs: {}, now: '2026-09-29T14:40:00.000Z',
      }).active, false);
      assert.equal(policy.decideToolUse({
        entries: [start], sessionId: 'coordinator', toolName: 'get_sessions_status',
        toolArgs: {}, now: '2026-09-29T14:59:01.000Z',
      }).decision, 'deny');
      assert.equal(policy.decideToolUse({
        entries: [start], sessionId: 'coordinator', toolName: 'task_complete',
        toolArgs: {}, now: '2026-09-29T14:59:01.000Z',
      }).decision, 'pass');
      assert.equal(policy.decideToolUse({
        entries: [start], sessionId: 'coordinator', toolName: 'powershell',
        toolArgs: { command: 'Start-Sleep 120' }, now: '2026-09-29T14:58:00.000Z',
      }).decision, 'deny');
      assert.equal(policy.decideToolUse({
        entries: [start, firstSend.record], sessionId: 'coordinator',
        toolName: 'send_session_message', toolArgs: { session_id: 'task-a' },
        now: '2026-09-29T14:40:00.000Z',
      }).decision, 'deny');
      assert.equal(policy.decideToolUse({
        entries: [start], sessionId: 'coordinator', toolName: 'create',
        toolArgs: { path: 'journal\\task-9408-budget-review.md' },
        env: { USERPROFILE: 'C:\\Users\\shiv' },
        cwd: 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner',
        now: '2026-09-29T14:40:00.000Z',
      }).decision, 'deny');
      assert.equal(policy.decideToolUse({
        entries: [start], sessionId: 'coordinator', toolName: 'create',
        toolArgs: { path: 'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent\\.turn-9408.md' },
        env: { USERPROFILE: 'C:\\Users\\shiv' },
        cwd: 'C:\\work',
        now: '2026-09-29T14:40:00.000Z',
      }).decision, 'pass');
    } catch {
      killed = true;
    }
    assert.equal(killed, true, `${name}: mutant survived`);
    console.log(`  [KILLED] ${name}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`mutcheck-coordinator-guard -- ${mutations.length} mutations killed`);
