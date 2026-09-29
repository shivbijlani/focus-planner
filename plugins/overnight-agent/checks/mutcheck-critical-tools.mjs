import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, probeTool } from '../skills/overnight-agent/check-critical-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'oa-critical-'));
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const settings = path.join(temp, 'user-settings.md');
const config = path.join(temp, 'mcp-config.json');
const state = path.join(temp, 'state');
const oa = path.join(here, '..', 'skills', 'overnight-agent', 'oa-state.ps1');
try {
  writeFileSync(settings, '| Critical tools | `email, bogus-tool` |\n');
  writeFileSync(config, JSON.stringify({ mcpServers: { email: {}, 'google-workspace': {} } }));
  const policy = (extra = []) => spawnSync(shell, [
    '-NoProfile', '-File', oa, 'critical-tools', '-UserSettings', settings,
    '-McpConfig', config, '-StateDir', state, ...extra,
  ], { encoding: 'utf8', timeout: 15000 });
  const unknown = policy();
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /bogus-tool/);
  writeFileSync(settings, '| Critical tools | `email, google-workspace` |\n');
  assert.deepEqual(JSON.parse(policy().stdout).tools, ['email', 'google-workspace']);
  writeFileSync(settings, '# no override\n');
  assert.deepEqual(JSON.parse(policy().stdout).tools, ['email', 'google-workspace']);

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
  const retry = await evaluate({ names: ['email'], probe: () => { throw Error('down'); },
    notify: () => false, now: new Date('2026-09-29T12:00:00Z') });
  assert.equal(retry.outages.email.lastAlertDate, null);
  assert.equal((await evaluate({ names: ['email'], probe: () => { throw Error('down'); },
    notify: (text, kind) => { assert.equal(kind, 'outage'); return true; },
    previous: retry, now: new Date('2026-09-29T12:30:00Z') })).outages.email.lastAlertDate, '2026-09-29');

  let calls = [];
  await probeTool('google-workspace', '| Google account (Tasks) | `example@test.com` |', {
    call: (...args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: '{"tasks":[]}' }] };
    },
  });
  assert.deepEqual(calls[0].slice(0, 3), ['google-workspace', 'call', 'list_tasks']);
  assert.match(calls[0][3], /"max_results":1/);
  await assert.rejects(probeTool('google-workspace', '| Google account (Tasks) | example@test.com |', {
    call: () => ({ isError: true }),
  }), /isError/);
  await assert.rejects(probeTool('unfamiliar', '', { call: () => [] }), /no safe zero-argument read probe/);

  const helper = path.join(here, 'oa-supervisor-startup.ps1');
  const capabilities = path.join(temp, 'capabilities.json');
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
      : name === 'email_test_account' ? {success:true}
      : name === 'email_send' ? (fs.appendFileSync(${JSON.stringify(sends)}, 'sent\\n'), {success:true})
      : name === 'list_tasks' && fs.existsSync(${JSON.stringify(googleDown)}) ? {error:'protocol mismatch'}
      : {tasks:[]};
    result = {content:[{type:'text',text:JSON.stringify(data)}]};
  } else result = {tools:[]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  writeFileSync(config, JSON.stringify({ mcpServers: Object.fromEntries(['email', 'google-workspace']
    .map((name) => [name, { type: 'stdio', command: process.execPath, args: [server] }])) }));
  writeFileSync(settings, '| Critical tools | email, google-workspace |\n' +
    '| Agent email account | self@example.test |\n| Google account (Tasks) | self@example.test |\n');
  writeFileSync(googleDown, '1');
  const check = () => spawnSync(process.execPath, [
    path.join(here, '..', 'skills', 'overnight-agent', 'check-critical-tools.mjs'),
    '--settings', settings, '--mcp-config', config, '--state', capabilities,
  ], { encoding: 'utf8', timeout: 90000 });
  const run1 = check();
  assert.equal(run1.status, 2, run1.stderr);
  assert.equal(JSON.parse(run1.stdout).status, 'degraded');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1);
  const run2 = check();
  assert.equal(run2.status, 2, run2.stderr);
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1);
  rmSync(googleDown);
  const run3 = check();
  assert.equal(run3.status, 0, run3.stderr);
  assert.equal(JSON.parse(run3.stdout).status, 'completed');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 2);
  console.log('PASS critical-tool settings, real-call probe, outage/daily/recovery, skip, tray');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
