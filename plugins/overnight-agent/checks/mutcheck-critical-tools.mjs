import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluate, probeTimeoutMs, ProbeTimeoutError, probeTool,
} from '../skills/overnight-agent/check-critical-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'oa-critical-'));
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const settings = path.join(temp, 'user-settings.md');
const config = path.join(temp, 'mcp-config.json');
const state = path.join(temp, 'state');
const oa = path.join(here, '..', 'skills', 'overnight-agent', 'oa-state.ps1');
try {
  writeFileSync(settings, '| Critical tools | `email, bogus-tool` — configured outage floor |\n');
  writeFileSync(config, JSON.stringify({ mcpServers: { email: {}, 'google-workspace': {} } }));
  const policy = (extra = []) => spawnSync(shell, [
    '-NoProfile', '-File', oa, 'critical-tools', '-UserSettings', settings,
    '-McpConfig', config, '-StateDir', state, ...extra,
  ], { encoding: 'utf8', timeout: 60000 });
  const unknown = policy();
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /bogus-tool/);
  writeFileSync(settings, '| Critical tools | `email, google-workspace` — configured outage floor |\n');
  assert.deepEqual(JSON.parse(policy().stdout).tools, ['email', 'google-workspace']);
  writeFileSync(settings, '# no override\n');
  assert.deepEqual(JSON.parse(policy().stdout).tools, ['email', 'google-workspace']);
  assert.equal(probeTimeoutMs(''), 90000);
  assert.equal(probeTimeoutMs('| Critical tool probe timeout | `120s` — override |\n'), 120000);
  assert.throws(() => probeTimeoutMs('| Critical tool probe timeout | `0s` — invalid |\n'), /1s to 600s/);

  let healthy = false;
  const sent = [];
  const probe = (name) => { if (name === 'google-workspace' && !healthy) throw Error('protocol mismatch'); };
  const notify = (text, kind) => { sent.push({ text, kind }); return true; };
  const tasks = [{ id: 'uses-google', requires: ['google-workspace'] },
    { id: 'independent', requires: ['email'] }];
  const first = await evaluate({ names: ['email', 'google-workspace'], probe, notify, tasks,
    now: new Date('2026-09-28T10:00:00Z') });
  assert.equal(first.status, 'degraded');
  assert.match(first.headline, /^⛔ CRITICAL TOOL DOWN: google-workspace\. protocol mismatch\. Since 2026-09-28/);
  assert.deepEqual(first.skipped, [{ id: 'uses-google', reason: 'blocked: google-workspace down' }]);
  assert.deepEqual(sent.map((s) => s.kind), ['outage']);
  const second = await evaluate({ names: ['email', 'google-workspace'], probe, notify,
    previous: first, now: new Date('2026-09-28T11:00:00Z') });
  assert.equal(second.tools['google-workspace'].firstSeenAt, first.tools['google-workspace'].firstSeenAt);
  assert.equal(sent.length, 1);
  const reminder = await evaluate({ names: ['email', 'google-workspace'], probe, notify,
    previous: second, now: new Date('2026-09-29T11:00:00Z') });
  assert.deepEqual(sent.map((s) => s.kind), ['outage', 'reminder']);
  healthy = true;
  const recovered = await evaluate({ names: ['email', 'google-workspace'], probe, notify,
    previous: reminder, now: new Date('2026-09-29T12:00:00Z') });
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(sent.map((s) => s.kind), ['outage', 'reminder', 'recovered']);
  assert.deepEqual(recovered.outages, {});
  const slowSent = [];
  const slowProbe = () => { throw new ProbeTimeoutError('timed out after 90s'); };
  const slowTasks = [{ id: 'uses-email', requires: ['email'] }];
  const slow1 = await evaluate({ names: ['email'], probe: slowProbe, tasks: slowTasks,
    notify: (...args) => { slowSent.push(args); return true; },
    now: new Date('2026-09-29T13:00:00Z') });
  assert.equal(slow1.status, 'completed');
  assert.equal(slow1.tools.email.status, 'slow');
  assert.match(slow1.wrapUp, /CRITICAL TOOL SLOW: email/);
  assert.equal(slow1.wrapUp.split('\n').length, 1);
  assert.equal(slow1.headline, '');
  assert.deepEqual(slow1.skipped, []);
  assert.equal(slowSent.length, 0);
  const slow2 = await evaluate({ names: ['email'], probe: slowProbe, previous: slow1,
    tasks: slowTasks, notify: (...args) => { slowSent.push(args); return true; },
    now: new Date('2026-09-29T13:30:00Z') });
  assert.equal(slow2.status, 'degraded');
  assert.equal(slow2.tools.email.status, 'down');
  assert.equal(slow2.tools.email.consecutiveSlowRuns, 2);
  assert.deepEqual(slow2.skipped, [{ id: 'uses-email', reason: 'blocked: email down' }]);
  assert.deepEqual(slowSent.map((args) => args[1]), ['outage']);
  const afterSlowRecovery = await evaluate({ names: ['email'], probe: () => {}, previous: slow2,
    notify: (...args) => { slowSent.push(args); return true; },
    now: new Date('2026-09-29T14:00:00Z') });
  assert.equal(afterSlowRecovery.status, 'completed');
  assert.equal(afterSlowRecovery.tools.email.status, 'ok');
  assert.deepEqual(afterSlowRecovery.outages, {});
  assert.deepEqual(slowSent.map((args) => args[1]), ['outage', 'recovered']);
  const retry = await evaluate({ names: ['email'], probe: () => { throw Error('down'); },
    notify: () => false, now: new Date('2026-09-29T12:00:00Z') });
  assert.equal(retry.outages.email.lastAlertDate, null);
  assert.equal((await evaluate({ names: ['email'], probe: () => { throw Error('down'); },
    notify: (text, kind) => { assert.equal(kind, 'outage'); return true; },
    previous: retry, now: new Date('2026-09-29T12:30:00Z') })).outages.email.lastAlertDate, '2026-09-29');

  let calls = [];
  await probeTool('google-workspace',
    '| Google account (Tasks) | prose before `example@test.com` — enables task reads |', {
    call: (...args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'Tasks in list @default: none' }] };
    },
  });
  assert.deepEqual(calls[0].slice(0, 3), ['google-workspace', 'call', 'list_tasks']);
  assert.match(calls[0][3], /"max_results":1/);
  await assert.rejects(probeTool('google-workspace',
    '| Google account (Tasks) | `example@test.com` — enables task reads |', {
    call: () => ({ isError: true }),
  }), /isError/);
  await assert.rejects(probeTool('unfamiliar', '', { call: () => [] }), /no safe zero-argument read probe/);

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

  // End-to-end: the real CLI, policy, MCP transport, persistent state, and alert route.
  const server = path.join(temp, 'fake-mcp.cjs');
  const googleDown = path.join(temp, 'google-down');
  const googleSlow = path.join(temp, 'google-slow');
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
    if (name === 'list_tasks' && fs.existsSync(${JSON.stringify(googleDown)})) {
      result = {isError:true,content:[{type:'text',text:'protocol mismatch'}]};
    } else {
      const data = name === 'email_list_accounts' ? [{id:'acct',email:'self@example.test'}]
      : name === 'email_test_account' ? {success:true}
      : name === 'email_send' ? (fs.appendFileSync(${JSON.stringify(sends)}, 'sent\\n'), {success:true})
      : {tasks:[]};
      result = {content:[{type:'text',text:JSON.stringify(data)}]};
    }
  } else result = {tools:[]};
  const response = JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n';
  if (m.method === 'tools/call' && m.params.name === 'list_tasks' &&
      fs.existsSync(${JSON.stringify(googleSlow)})) {
    setTimeout(() => process.stdout.write(response), 1500);
  } else process.stdout.write(response);
});`);
  writeFileSync(config, JSON.stringify({ mcpServers: Object.fromEntries(['email', 'google-workspace']
    .map((name) => [name, { type: 'stdio', command: process.execPath, args: [server] }])) }));
  writeFileSync(settings, '| Critical tools | email, google-workspace |\n' +
    '| Agent email account | self@example.test |\n| Google account (Tasks) | self@example.test |\n' +
    '| Critical tool probe timeout | `90s` — normal budget |\n');
  writeFileSync(googleDown, '1');
  const check = (now, connectedProbes, mcpConfig = config) => spawnSync(process.execPath, [
    path.join(here, '..', 'skills', 'overnight-agent', 'check-critical-tools.mjs'),
    '--settings', settings, '--mcp-config', mcpConfig, '--state', capabilities, '--ledger', ledger,
    '--state-dir', state, '--now', now,
    ...(connectedProbes ? ['--connected-probes', connectedProbes] : []),
  ], { encoding: 'utf8', timeout: 90000 });
  const run1 = check('2026-09-29T10:00:00Z');
  assert.equal(run1.status, 2, run1.stderr);
  assert.equal(JSON.parse(run1.stdout).status, 'degraded');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1);
  const run2 = check('2026-09-29T10:30:00Z');
  assert.equal(run2.status, 2, run2.stderr);
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1);
  rmSync(googleDown);
  const run3 = check('2026-09-29T11:00:00Z');
  assert.equal(run3.status, 0, run3.stderr);
  assert.equal(JSON.parse(run3.stdout).status, 'completed');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 2);
  const run4 = check('2026-09-29T13:00:00Z');
  assert.equal(run4.status, 2, run4.stderr);
  const afterGap = JSON.parse(run4.stdout);
  assert.match(afterGap.headline,
    /^⚠ GAP: no runs from 2026-09-29T11:00:00.000Z to 2026-09-29T13:00:00.000Z \(3 slots\)/);
  assert.equal(afterGap.run.trigger, null);
  assert.equal(afterGap.runGap.missedSlots, 3);
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 3);
  const run5 = check('2026-09-29T13:30:00Z');
  assert.equal(run5.status, 0, run5.stderr);
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 3);
  writeFileSync(googleSlow, '1');
  writeFileSync(settings, readFileSync(settings, 'utf8').replace('`90s`', '`1s`'));
  const directEmail = path.join(temp, 'connected-probes.json');
  writeFileSync(directEmail, JSON.stringify({ email: { status: 'ok' } }));
  const run6 = check('2026-09-29T14:00:00Z', directEmail);
  assert.equal(run6.status, 0, run6.stderr);
  const firstSlow = JSON.parse(run6.stdout);
  assert.equal(firstSlow.tools['google-workspace'].status, 'slow');
  assert.equal(firstSlow.status, 'completed');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 3);
  const run7 = check('2026-09-29T14:30:00Z', directEmail);
  assert.equal(run7.status, 2, run7.stderr);
  assert.equal(JSON.parse(run7.stdout).tools['google-workspace'].status, 'down');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 4,
    `${run7.stderr}\n${JSON.stringify(JSON.parse(run7.stdout).tools)}`);
  const disconnectedConfig = path.join(temp, 'disconnected-mcp-config.json');
  writeFileSync(disconnectedConfig, JSON.stringify({ mcpServers: {
    email: { type: 'stdio', command: 'missing-email-server' },
    'google-workspace': { type: 'stdio', command: 'missing-google-server' },
  } }));
  const bothConnected = path.join(temp, 'both-connected.json');
  writeFileSync(bothConnected, JSON.stringify({
    email: { status: 'ok' }, 'google-workspace': { status: 'ok' },
  }));
  const connectedRun = check('2026-09-29T15:00:00Z', bothConnected, disconnectedConfig);
  assert.equal(connectedRun.status, 0, connectedRun.stderr);
  assert.equal(JSON.parse(connectedRun.stdout).status, 'completed');
  console.log('PASS settings, connected probes, real-call probe, timeout/slow/down, outage/recovery, gap, skip, tray');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
