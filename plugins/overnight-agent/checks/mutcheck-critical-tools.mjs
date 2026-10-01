import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, parseRecord } from '../skills/overnight-agent/check-critical-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'oa-critical-'));
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const settings = path.join(temp, 'user-settings.md');
const config = path.join(temp, 'mcp-config.json');
const state = path.join(temp, 'state');
const targetArg = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : null;
const oa = targetArg || path.join(here, '..', 'skills', 'overnight-agent', 'oa-state.ps1');
try {
  writeFileSync(settings, '| Critical tools | `email, bogus-tool` — configured outage floor |\n');
  writeFileSync(config, JSON.stringify({ mcpServers: { email: {}, 'google-workspace': {} } }));
  const policy = (extra = []) => {
    const isNode = oa.endsWith('.mjs');
    const argv = isNode
      ? [oa, 'critical-tools', '--UserSettings', settings, '--McpConfig', config, '--StateDir', state, ...extra]
      : ['-NoProfile', '-File', oa, 'critical-tools', '-UserSettings', settings, '-McpConfig', config, '-StateDir', state, ...extra];
    return spawnSync(isNode ? process.execPath : shell, argv, { encoding: 'utf8', timeout: 60000 });
  };
  const unknown = policy();
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /bogus-tool/);
  writeFileSync(settings, '| Critical tools | `email, google-workspace` — configured outage floor |\n');
  assert.deepEqual(JSON.parse(policy().stdout).tools, ['email', 'google-workspace']);
  writeFileSync(settings, '# no override\n');
  assert.deepEqual(JSON.parse(policy().stdout).tools, ['email', 'google-workspace']);

  // GH #768: no timeout class. `parseRecord` only ever produces `ok` or `down:<error>`.
  assert.deepEqual(parseRecord('email=ok'), ['email', { status: 'ok' }]);
  assert.deepEqual(parseRecord('google-workspace=down:protocol mismatch'),
    ['google-workspace', { status: 'down', error: 'protocol mismatch' }]);
  assert.throws(() => parseRecord('email=slow:timed out'), /use ok or down/);
  assert.throws(() => parseRecord('email=down:'), /requires an error/);
  assert.throws(() => parseRecord('=ok'), /name=ok/);
  assert.throws(() => parseRecord('nokey'), /name=ok/);

  // A recorded down is an immediate outage, not one that waits for a second consecutive run.
  const sent = [];
  const notify = (text, kind) => { sent.push({ text, kind }); return true; };
  const tasks = [{ id: 'uses-google', requires: ['google-workspace'] },
    { id: 'independent', requires: ['email'] }];
  const first = await evaluate({
    names: ['email', 'google-workspace'],
    results: { email: { status: 'ok' }, 'google-workspace': { status: 'down', error: 'protocol mismatch' } },
    notify, tasks, now: new Date('2026-09-28T10:00:00Z'),
  });
  assert.equal(first.status, 'degraded');
  assert.match(first.headline, /^⛔ CRITICAL TOOL DOWN: google-workspace\. protocol mismatch\. Since 2026-09-28/);
  assert.deepEqual(first.skipped, [{ id: 'uses-google', reason: 'blocked: google-workspace down' }]);
  assert.deepEqual(sent.map((s) => s.kind), ['outage']);
  const second = await evaluate({
    names: ['email', 'google-workspace'],
    results: { email: { status: 'ok' }, 'google-workspace': { status: 'down', error: 'protocol mismatch' } },
    notify, previous: first, now: new Date('2026-09-28T11:00:00Z'),
  });
  assert.equal(second.tools['google-workspace'].firstSeenAt, first.tools['google-workspace'].firstSeenAt);
  assert.equal(sent.length, 1);
  const reminder = await evaluate({
    names: ['email', 'google-workspace'],
    results: { email: { status: 'ok' }, 'google-workspace': { status: 'down', error: 'protocol mismatch' } },
    notify, previous: second, now: new Date('2026-09-29T11:00:00Z'),
  });
  assert.deepEqual(sent.map((s) => s.kind), ['outage', 'reminder']);
  const recovered = await evaluate({
    names: ['email', 'google-workspace'],
    results: { email: { status: 'ok' }, 'google-workspace': { status: 'ok' } },
    notify, previous: reminder, now: new Date('2026-09-29T12:00:00Z'),
  });
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(sent.map((s) => s.kind), ['outage', 'reminder', 'recovered']);
  assert.deepEqual(recovered.outages, {});

  // A tool the caller never recorded for (absent from the session) is down, with no distinct
  // "slow" purgatory and no waiting for a second run.
  const absentSent = [];
  const absent1 = await evaluate({
    names: ['email'], results: {}, tasks: [{ id: 'uses-email', requires: ['email'] }],
    notify: (...args) => { absentSent.push(args); return true; },
    now: new Date('2026-09-29T13:00:00Z'),
  });
  assert.equal(absent1.status, 'degraded');
  assert.equal(absent1.tools.email.status, 'down');
  assert.equal(absent1.tools.email.error, 'absent from session');
  assert.deepEqual(absent1.skipped, [{ id: 'uses-email', reason: 'blocked: email down' }]);
  assert.deepEqual(absentSent.map((args) => args[1]), ['outage']);
  const absentRecovery = await evaluate({
    names: ['email'], results: { email: { status: 'ok' } }, previous: absent1,
    notify: (...args) => { absentSent.push(args); return true; },
    now: new Date('2026-09-29T14:00:00Z'),
  });
  assert.equal(absentRecovery.status, 'completed');
  assert.equal(absentRecovery.tools.email.status, 'ok');
  assert.deepEqual(absentRecovery.outages, {});
  assert.deepEqual(absentSent.map((args) => args[1]), ['outage', 'recovered']);

  const retry = await evaluate({
    names: ['email'], results: { email: { status: 'down', error: 'down' } },
    notify: () => false, now: new Date('2026-09-29T12:00:00Z'),
  });
  assert.equal(retry.outages.email.lastAlertDate, null);
  assert.equal((await evaluate({
    names: ['email'], results: { email: { status: 'down', error: 'down' } },
    notify: (text, kind) => { assert.equal(kind, 'outage'); return true; },
    previous: retry, now: new Date('2026-09-29T12:30:00Z'),
  })).outages.email.lastAlertDate, '2026-09-29');

  const helper = path.join(here, 'oa-supervisor-startup.ps1');
  const capabilities = path.join(temp, 'capabilities.json');
  const ledger = path.join(temp, 'run-ledger.jsonl');
  writeFileSync(capabilities, JSON.stringify(first));
  const tray = spawnSync(shell, ['-NoProfile', '-Command',
    `. '${helper}'; Get-OaCriticalStatus -Path '${capabilities}' | ConvertTo-Json`],
  { encoding: 'utf8' });
  assert.equal(tray.status, 0, tray.stderr);
  assert.equal(JSON.parse(tray.stdout).down, true);
  assert.match(JSON.parse(tray.stdout).headline, /google-workspace/);
  writeFileSync(capabilities, JSON.stringify(recovered));
  const clear = spawnSync(shell, ['-NoProfile', '-Command',
    `. '${helper}'; Get-OaCriticalStatus -Path '${capabilities}' | ConvertTo-Json`],
  { encoding: 'utf8' });
  assert.equal(JSON.parse(clear.stdout).down, false);

  if (targetArg?.endsWith('.mjs')) {
    console.log('PASS settings, --record parser, immediate down, absent-tool-is-down, outage/recovery, skip, tray (Node oa-state policy target)');
    process.exit(0);
  }

  // End-to-end: the real CLI, policy, --record, persistent state, and alert route. No subprocess
  // is spawned to test email/google-workspace health -- only to deliver the alert itself.
  const server = path.join(temp, 'fake-mcp.cjs');
  const sends = path.join(temp, 'sends.txt');
  writeFileSync(server, `
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = {protocolVersion:'2024-11-05'};
  else if (m.method === 'tools/call') {
    const name = m.params.name;
    const data = name === 'email_list_accounts' ? [{id:'acct',email:'self@example.test'}]
    : name === 'email_send' ? (fs.appendFileSync(${JSON.stringify(sends)}, 'sent\\n'), {success:true})
    : {success:true};
    result = {content:[{type:'text',text:JSON.stringify(data)}]};
  } else result = {tools:[]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  writeFileSync(config, JSON.stringify({ mcpServers: Object.fromEntries(['email', 'google-workspace']
    .map((name) => [name, { type: 'stdio', command: process.execPath, args: [server] }])) }));
  writeFileSync(settings, '| Critical tools | email, google-workspace |\n' +
    '| Agent email account | self@example.test |\n| Google account (Tasks) | self@example.test |\n');
  // GH #772: default every existing test call to a coordinator run (`--run <runId>`) -- what
  // follows already exercises the ledger-dependent gap detection above this line, and that
  // behavior must be unchanged for a real coordinator run.
  const check = (now, recordArgs, mcpConfig = config, extraArgs = ['--run', 'coordinator-run']) => spawnSync(
    process.execPath, [
      path.join(here, '..', 'skills', 'overnight-agent', 'check-critical-tools.mjs'),
      '--settings', settings, '--mcp-config', mcpConfig, '--state', capabilities, '--ledger', ledger,
      '--state-dir', state, '--now', now, ...extraArgs,
      ...recordArgs.flatMap((r) => ['--record', r]),
    ], { encoding: 'utf8', timeout: 180000 },
  );
  const run1 = check('2026-09-29T10:00:00Z', ['email=ok', 'google-workspace=down:protocol mismatch']);
  assert.equal(run1.status, 2, run1.stderr);
  assert.equal(JSON.parse(run1.stdout).status, 'degraded');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1);
  const run2 = check('2026-09-29T10:30:00Z', ['email=ok', 'google-workspace=down:protocol mismatch']);
  assert.equal(run2.status, 2, run2.stderr);
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1);
  const run3 = check('2026-09-29T11:00:00Z', ['email=ok', 'google-workspace=ok']);
  assert.equal(run3.status, 0, run3.stderr);
  assert.equal(JSON.parse(run3.stdout).status, 'completed');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 2);
  const run4 = check('2026-09-29T13:00:00Z', ['email=ok', 'google-workspace=ok']);
  assert.equal(run4.status, 2, run4.stderr);
  const afterGap = JSON.parse(run4.stdout);
  assert.match(afterGap.headline,
    /^⚠ GAP: no runs from 2026-09-29T11:00:00.000Z to 2026-09-29T13:00:00.000Z \(3 slots\)/);
  assert.equal(afterGap.run.trigger, null);
  assert.equal(afterGap.runGap.missedSlots, 3);
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 3);
  const run5 = check('2026-09-29T13:30:00Z', ['email=ok', 'google-workspace=ok']);
  assert.equal(run5.status, 0, run5.stderr);
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 3);

  // A tool the coordinator omits from --record (absent from the session) is down immediately,
  // with no cold-started fallback probe and no quiet "slow" run first.
  const run6 = check('2026-09-29T14:00:00Z', ['email=ok']);
  assert.equal(run6.status, 2, run6.stderr);
  const missingGoogle = JSON.parse(run6.stdout);
  assert.equal(missingGoogle.tools['google-workspace'].status, 'down');
  assert.equal(missingGoogle.tools['google-workspace'].error, 'absent from session');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 4);
  const run7 = check('2026-09-29T14:30:00Z', ['email=ok', 'google-workspace=ok']);
  assert.equal(run7.status, 0, run7.stderr);
  assert.equal(JSON.parse(run7.stdout).status, 'completed');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 5);

  const disconnectedConfig = path.join(temp, 'disconnected-mcp-config.json');
  writeFileSync(disconnectedConfig, JSON.stringify({ mcpServers: {
    email: { type: 'stdio', command: 'missing-email-server' },
    'google-workspace': { type: 'stdio', command: 'missing-google-server' },
  } }));
  const connectedRun = check('2026-09-29T15:00:00Z', ['email=ok', 'google-workspace=ok'], disconnectedConfig);
  assert.equal(connectedRun.status, 0, connectedRun.stderr);
  assert.equal(JSON.parse(connectedRun.stdout).status, 'completed');

  // GH #772: `--run <runId>` is the ONE flag that turns an invocation into a coordinator run
  // that writes the ledger. Manual/diagnostic invocations omit it and must be read-only: they
  // still evaluate tool health, but append zero lines, however many times they are run.
  const ledgerLineCount = () => readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length;
  const beforeManual = ledgerLineCount();
  const manual1 = check('2026-09-29T15:30:00Z', ['email=ok', 'google-workspace=ok'], config, []);
  assert.equal(manual1.status, 0, manual1.stderr);
  assert.equal(JSON.parse(manual1.stdout).run, null, 'a manual run (no --run) records no run object');
  assert.equal(ledgerLineCount(), beforeManual, 'a manual run (no --run) must not append to the ledger');
  const manual2 = check('2026-09-29T15:31:00Z', ['email=ok', 'google-workspace=ok'], config, []);
  assert.equal(manual2.status, 0, manual2.stderr);
  assert.equal(ledgerLineCount(), beforeManual, 'repeated manual runs still write zero ledger lines');
  const coordinated = check('2026-09-29T15:32:00Z', ['email=ok', 'google-workspace=ok'], config,
    ['--run', 'coordinator-run-2']);
  assert.equal(coordinated.status, 0, coordinated.stderr);
  assert.equal(JSON.parse(coordinated.stdout).run.runId, 'coordinator-run-2');
  assert.equal(ledgerLineCount(), beforeManual + 1,
    'a coordinator run (--run present) writes exactly one ledger line');

  console.log('PASS settings, --record, immediate down, absent-tool-is-down, outage/recovery, gap, skip, tray, ' +
    'ledger-write-gated-on---run');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
