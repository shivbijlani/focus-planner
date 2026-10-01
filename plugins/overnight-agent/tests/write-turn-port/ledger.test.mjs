// node --test: the sent-messages ledger and the protected-target guard of write-turn.mjs (item 3).
//
// The turn-writing half of the tool is pinned by the characterization goldens against
// write-turn.ps1. The ledger has no PowerShell twin, so its contract is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '..', '..', 'skills', 'overnight-agent', 'write-turn.mjs');
const MOON = '\u{1F319}';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ledger-'));
  const home = path.join(root, 'home');
  return { root, home, ledger: path.join(home, 'sent-messages.jsonl') };
}
function run(sb, args, env = {}) {
  const r = spawnSync(process.execPath, [WT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WRITE_TURN_OA_HOME: sb.home, WRITE_TURN_HOST: 'test-host', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

test('record-sent appends one JSON line with channel, id, task, time and identity', () => {
  const sb = sandbox();
  const r = run(sb, ['record-sent', '-Channel', 'Teams', '-MessageId', 'msg-1', '-TaskId', '448', '-At', '2026-10-01T03:00:00-07:00'], { COPILOT_AGENT_SESSION_ID: 'sess-1' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.recorded, true);
  const lines = fs.readFileSync(sb.ledger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { v: 1, at: '2026-10-01T03:00:00-07:00', channel: 'teams', message_id: 'msg-1', task_id: '448', by: 'sess-1', host: 'test-host' });
});

test('the same (channel, message id) is never recorded twice; another channel is distinct', () => {
  const sb = sandbox();
  run(sb, ['record-sent', '-Channel', 'mail', '-MessageId', 'abc']);
  const dup = run(sb, ['record-sent', '--channel', 'MAIL', '--message-id', 'abc']);
  assert.equal(dup.code, 0);
  assert.equal(dup.json.recorded, false);
  assert.equal(dup.json.duplicate, true);
  run(sb, ['record-sent', '-Channel', 'teams', '-MessageId', 'abc']);
  assert.equal(fs.readFileSync(sb.ledger, 'utf8').trim().split('\n').length, 2);
});

test('was-sent answers from the ledger, case-insensitive on channel, exact on id', () => {
  const sb = sandbox();
  run(sb, ['record-sent', '-Channel', 'google-doc', '-MessageId', 'Comment-7', '-TaskId', '12']);
  assert.equal(run(sb, ['was-sent', '-Channel', 'Google-Doc', '-MessageId', 'Comment-7']).json.sent, true);
  assert.equal(run(sb, ['was-sent', '-Channel', 'google-doc', '-MessageId', 'comment-7']).json.sent, false);
  assert.equal(run(sb, ['was-sent', '-Channel', 'teams', '-MessageId', 'Comment-7']).json.sent, false);
  const none = run(sandbox(), ['was-sent', '-Channel', 'teams', '-MessageId', 'x']);
  assert.equal(none.code, 0);
  assert.equal(none.json.sent, false);
});

test('malformed ledger lines are counted, never fatal, and never match', () => {
  const sb = sandbox();
  fs.mkdirSync(sb.home, { recursive: true });
  fs.writeFileSync(sb.ledger, 'not json\n{"channel":"teams"}\n{"v":1,"channel":"teams","message_id":"ok-1"}\n');
  const r = run(sb, ['was-sent', '-Channel', 'teams', '-MessageId', 'ok-1']);
  assert.equal(r.json.sent, true);
  assert.equal(r.json.malformed, 2);
});

test('bad arguments exit 3 and write nothing', () => {
  const sb = sandbox();
  for (const args of [
    ['record-sent', '-MessageId', 'x'],
    ['record-sent', '-Channel', 'teams'],
    ['record-sent', '-Channel', 'Te ams', '-MessageId', 'x'],
    ['record-sent', '-Channel', 'teams', '-MessageId', 'x', '-At', 'yesterday'],
    ['record-sent', '-Channel', 'teams', '-MessageId', 'x', '-Bogus', '1'],
    ['was-sent', '-Channel', 'teams'],
  ]) {
    const r = run(sb, args);
    assert.equal(r.code, 3, `${args.join(' ')} -> ${r.code} ${r.err}`);
  }
  assert.equal(fs.existsSync(sb.ledger), false);
});

test('OA_SANDBOX_ROOT refuses a ledger outside the sandbox', () => {
  const sb = sandbox();
  const r = run(sb, ['record-sent', '-Channel', 'teams', '-MessageId', 'x'], { OA_SANDBOX_ROOT: path.join(sb.root, 'elsewhere') });
  assert.equal(r.code, 3);
  assert.match(r.err, /oa_sandbox_violation/);
  assert.equal(fs.existsSync(sb.ledger), false);
});

test('G20: a journal that is a link to agent-gate.md is refused and the gate is untouched', (t) => {
  const sb = sandbox();
  const planner = path.join(sb.root, 'planner');
  const journal = path.join(planner, 'journal');
  fs.mkdirSync(journal, { recursive: true });
  const gate = path.join(planner, 'agent-gate.md');
  fs.writeFileSync(gate, '# Agent gate\n');
  try { fs.symlinkSync(gate, path.join(journal, 'task-5.md'), 'file'); } catch { t.skip('symlinks need privileges on this host'); return; }
  const body = path.join(sb.root, 'b.md');
  fs.writeFileSync(body, `## ${MOON} Overnight Agent\n<!-- from: overnight-agent -->\n**Status:** x\n\n**Needs from you:** nothing.\n`);
  const r = run(sb, ['-Id', '5', '-BodyFile', body, '-JournalDir', journal, '-Ask', 'none', '-Json', '-DisableGuard', 'G20']);
  assert.equal(r.code, 2);
  assert.ok(r.json.findings.some((f) => f.guard === 'G20'));
  assert.equal(fs.readFileSync(gate, 'utf8'), '# Agent gate\n');
});
