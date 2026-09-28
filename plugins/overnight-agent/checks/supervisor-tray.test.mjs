import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = import.meta.dirname;
const tray = join(dir, 'oa-supervisor-tray.ps1');
const startupLib = join(dir, 'oa-supervisor-startup.ps1');
const installer = join(dir, 'install-oa-supervisor.ps1');
const windows = process.platform === 'win32';
const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function ps(script, env = {}) {
  const result = spawnSync('powershell.exe', [...psArgs, '-Command', script], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`powershell failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

// One cleanup hook per test: stop every tray FIRST (it holds the lock file open), then
// remove the fake home, so a failed assertion can never leave a tray running.
async function fakeHome(t, supervisorBody, browserBody) {
  const root = await mkdtemp(join(tmpdir(), 'oa-tray-'));
  const home = join(root, 'overnight-agent');
  await mkdir(home);
  if (supervisorBody) await writeFile(join(home, 'oa-supervisor.ps1'), supervisorBody);
  if (browserBody) await writeFile(join(home, 'browser-watchdog.ps1'), browserBody);
  const trays = [];
  t.after(async () => {
    for (const { child, exited } of trays) {
      if (child.exitCode === null) { child.kill(); await exited; }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  return { root, home, trays };
}

function startTray(ctx, extra = []) {
  const child = spawn('powershell.exe', [...psArgs, '-STA', '-File', tray,
    '-IntervalMinutes', '15', '-NoTrayIcon', ...extra], {
    env: { ...process.env, LOCALAPPDATA: ctx.root }, stdio: 'ignore', windowsHide: true,
  });
  const exited = new Promise(resolveExit => child.once('exit', code => resolveExit(code)));
  const handle = { child, exited };
  ctx.trays.push(handle);
  return handle;
}

async function waitFor(predicate, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return false;
}

async function readBeat(home) {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse((await readFile(join(home, 'supervisor-daemon-heartbeat.json'), 'utf8')).replace(/^\uFEFF/, ''));
    } catch (error) {
      if (i >= 20) throw error;
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

async function readCount(home) {
  try { return Number(await readFile(join(home, 'count.txt'), 'utf8')); }
  catch (error) { if (['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) return 0; throw error; }
}

const countingSupervisor = `
$countPath = Join-Path $PSScriptRoot 'count.txt'
$count = if (Test-Path $countPath) { [int](Get-Content $countPath -Raw) } else { 0 }
($count + 1) | Set-Content $countPath
@{ state = 'HEALTHY'; actResult = @{ nextEvaluationAt =
  (Get-Date).ToUniversalTime().AddMilliseconds(700).ToString('o') } } | ConvertTo-Json -Compress -Depth 4
`;
const quietSupervisor = `@{ state = 'HEALTHY'; actResult = @{
  nextEvaluationAt = (Get-Date).ToUniversalTime().AddMinutes(15).ToString('o')
} } | ConvertTo-Json -Compress -Depth 4`;
const countingBrowser = `
param([switch]$Json)
$countPath = Join-Path $PSScriptRoot 'browser-count.txt'
$count = if (Test-Path $countPath) { [int](Get-Content $countPath -Raw) } else { 0 }
($count + 1) | Set-Content $countPath
@{ healthy = $true; unhealthy = 0 } | ConvertTo-Json -Compress
`;

test('only one startup route exists: no scheduled task, Startup shim or service is ever created', () => {
  for (const file of [tray, startupLib, installer]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?<!Un)Register-ScheduledTask|New-ScheduledTask|schtasks(\.exe)?\s+\/Create/i, file);
    assert.doesNotMatch(source, /New-Service|sc(\.exe)?\s+create/i, file);
    assert.doesNotMatch(source, /Set-Content[^\n]*shim|Out-File[^\n]*Startup/i, file);
  }
  const daemon = readFileSync(join(dir, 'oa-supervisor-daemon.ps1'), 'utf8');
  assert.match(daemon, /RETIRED/);
  assert.doesNotMatch(daemon, /oa-supervisor\.ps1'\s*\)|& powershell/i, 'retired daemon must not run the checker');
});

test('Run-entry command launches the deployed tray hidden with the chosen policy flags', { skip: !windows }, () => {
  const line = ps(`. '${startupLib}'; Get-OaTrayCommandLine -TrayPath 'C:\\h\\oa-supervisor-tray.ps1' -IntervalMinutes 15 -NoAct -PowerShellPath 'C:\\ps.exe'`);
  assert.equal(line, '"C:\\ps.exe" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden ' +
    '-File "C:\\h\\oa-supervisor-tray.ps1" -IntervalMinutes 15 -NoAct');
});

test('owner identity requires matching script, host and start time before a stop', { skip: !windows }, () => {
  const result = ps(`. '${startupLib}'
$rec = [pscustomobject]@{ pid = 5; startedUtc = '2026-09-26T12:00:00.0000000Z' }
$good = [pscustomobject]@{ Name = 'powershell.exe'; CommandLine = 'powershell -File C:\\h\\oa-supervisor-tray.ps1'; CreationDate = [datetime]::Parse('2026-09-26T12:00:30Z').ToUniversalTime() }
$legacy = [pscustomobject]@{ Name = 'powershell.exe'; CommandLine = 'powershell -File C:\\h\\oa-supervisor-daemon.ps1'; CreationDate = $good.CreationDate }
$other = [pscustomobject]@{ Name = 'powershell.exe'; CommandLine = 'powershell -File C:\\x\\other.ps1'; CreationDate = $good.CreationDate }
$reused = [pscustomobject]@{ Name = 'powershell.exe'; CommandLine = $good.CommandLine; CreationDate = $good.CreationDate.AddHours(1) }
$host2 = [pscustomobject]@{ Name = 'notepad.exe'; CommandLine = $good.CommandLine; CreationDate = $good.CreationDate }
@((Test-OaOwnerIdentity $rec $good), (Test-OaOwnerIdentity $rec $legacy), (Test-OaOwnerIdentity $rec $other),
  (Test-OaOwnerIdentity $rec $reused), (Test-OaOwnerIdentity $rec $host2), (Test-OaOwnerIdentity $null $good)) -join ','`);
  assert.equal(result, 'True,True,False,False,False,False');
});

test('migration removes both legacy task routes and both exact Startup shims', { skip: !windows }, async t => {
  const { root } = await fakeHome(t);
  const oaShim = join(root, 'Overnight Agent supervisor.cmd');
  const browserShim = join(root, 'CopilotBrowserWatchdog.vbs');
  await writeFile(oaShim, 'old');
  await writeFile(browserShim, 'old');
  const result = ps(`. '${startupLib}'
function Get-OaLegacyInstall {
  [ordered]@{ taskInstalled = $true; browserTaskInstalled = $true; taskError = $null;
    shimPath = '${oaShim}'; browserShimPath = '${browserShim}' }
}
function Unregister-ScheduledTask { param([string]$TaskName, [string]$TaskPath, [switch]$Confirm)
  $script:removedTasks += @($TaskName)
}
$script:removedTasks = @()
$removed = Remove-OaLegacyInstall
@{ tasks = @($script:removedTasks); entries = @($removed);
  shimsGone = (-not (Test-Path '${oaShim}') -and -not (Test-Path '${browserShim}')) } |
  ConvertTo-Json -Compress -Depth 3`);
  const migration = JSON.parse(result);
  assert.deepEqual(migration.tasks, ['Overnight Agent supervisor', 'Copilot browser watchdog']);
  assert.equal(migration.shimsGone, true);
  assert.equal(migration.entries.length, 4);
});

test('failed browser-task removal prevents legacy-shim cleanup', { skip: !windows }, async t => {
  const { root } = await fakeHome(t);
  const browserShim = join(root, 'CopilotBrowserWatchdog.vbs');
  await writeFile(browserShim, 'old');
  const result = ps(`. '${startupLib}'
function Get-OaLegacyInstall {
  [ordered]@{ taskInstalled = $false; browserTaskInstalled = $true; taskError = $null;
    shimPath = '${join(root, 'missing.cmd')}'; browserShimPath = '${browserShim}' }
}
function Unregister-ScheduledTask { throw 'access denied' }
try { [void](Remove-OaLegacyInstall); 'unexpected-success' }
catch { "blocked=$([bool](Test-Path '${browserShim}'))" }`);
  assert.equal(result, 'blocked=True');
});

test('tray scheduler wakes at the supervisor M/N boundary before its periodic interval', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  const { root, home } = ctx;
  startTray(ctx);
  assert.ok(await waitFor(async () => (await readCount(home)) >= 2), 'the tray did not wake at the 700ms boundary');
  const beat = await readBeat(home);
  assert.equal(beat.kind, 'tray');
  assert.equal(beat.paused, false);
  assert.equal(beat.lastState, 'HEALTHY');
});

test('a second tray cannot start while the supervisor lock is held', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, quietSupervisor);
  const { root, home } = ctx;
  startTray(ctx);
  assert.ok(await waitFor(() => existsSync(join(home, 'supervisor-daemon-heartbeat.json'))));
  const second = startTray(ctx);
  const code = await Promise.race([second.exited, new Promise(r => setTimeout(() => r('timeout'), 30_000))]);
  assert.equal(code, 0, 'second tray must exit instead of supervising in parallel');
});

test('paused tray keeps its heartbeat but starts no evaluations', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  const { root, home } = ctx;
  await writeFile(join(home, 'supervisor-tray.json'), JSON.stringify({ paused: true }));
  startTray(ctx);
  assert.ok(await waitFor(() => existsSync(join(home, 'supervisor-daemon-heartbeat.json'))));
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(await readCount(home), 0);
  const beat = await readBeat(home);
  assert.equal(beat.paused, true);
});

test('browser checks are independently off by default and paused when opted in', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, quietSupervisor, countingBrowser);
  const { home } = ctx;
  startTray(ctx);
  assert.ok(await waitFor(() => existsSync(join(home, 'supervisor-daemon-heartbeat.json'))));
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(existsSync(join(home, 'browser-count.txt')), false);
  const first = await readBeat(home);
  assert.equal(first.browserEnabled, false);
  assert.equal(first.browserEvaluating, false);
  assert.equal(first.browserLastCheckUtc, null);
});

test('opted-in browser check runs from the tray and persists its last outcome', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, quietSupervisor, countingBrowser);
  const { home } = ctx;
  await writeFile(join(home, 'supervisor-tray.json'), JSON.stringify({ browserEnabled: true }));
  startTray(ctx);
  assert.ok(await waitFor(async () => existsSync(join(home, 'browser-count.txt')), 30_000),
    'the tray did not run its browser check');
  const persisted = await waitFor(async () => {
    try {
      const saved = JSON.parse((await readFile(join(home, 'supervisor-tray.json'), 'utf8')).replace(/^\uFEFF/, ''));
      return (Array.isArray(saved.browserRecent) ? saved.browserRecent : [saved.browserRecent])
        .some(entry => entry?.state === 'HEALTHY');
    } catch { return false; }
  }, 30_000);
  assert.ok(persisted, `browser outcome was not persisted: ${JSON.stringify(await readBeat(home))}; state=${await readFile(join(home, 'supervisor-tray.json'), 'utf8')}`);
  const beat = await readBeat(home);
  assert.equal(beat.browserEnabled, true);
  assert.equal(beat.browserState, 'HEALTHY');
});

test('paused browser component never runs even when reliability checks do', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor, countingBrowser);
  const { home } = ctx;
  await writeFile(join(home, 'supervisor-tray.json'), JSON.stringify({ browserEnabled: true, browserPaused: true }));
  startTray(ctx);
  assert.ok(await waitFor(async () => (await readCount(home)) >= 1));
  assert.equal(existsSync(join(home, 'browser-count.txt')), false);
  const beat = await readBeat(home);
  assert.equal(beat.browserPaused, true);
});

test('verified stop request exits the tray gracefully and releases the lock', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  const { root, home } = ctx;
  await writeFile(join(home, 'supervisor-tray.json'), JSON.stringify({ paused: true }));
  const { exited } = startTray(ctx);
  assert.ok(await waitFor(() => existsSync(join(home, 'supervisor-daemon-heartbeat.json'))));
  let outcome;
  try { outcome = ps(`. '${startupLib}'; Stop-OaSupervisorOwner`, { LOCALAPPDATA: root }); }
  catch (error) { throw new Error(`${error.message}\nheartbeat: ${JSON.stringify(await readBeat(home))}`); }
  assert.equal(outcome, 'stopped-gracefully');
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(home, 'supervisor-daemon.lock')), false);
});

test('retired legacy daemon exits without running the checker', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  const { root, home } = ctx;
  const result = spawnSync('powershell.exe', [...psArgs, '-File', join(dir, 'oa-supervisor-daemon.ps1')], {
    env: { ...process.env, LOCALAPPDATA: root }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0);
  assert.equal(await readCount(home), 0);
  assert.match(await readFile(join(home, 'supervisor-log.jsonl'), 'utf8'), /LEGACY-DAEMON-RETIRED/);
});

test('default installer run reports status and registers or starts nothing', { skip: !windows }, async t => {
  const { root, home } = await fakeHome(t);
  const before = ps(`. '${startupLib}'; (Get-OaTrayStartup).command`);
  const result = spawnSync('powershell.exe', [...psArgs, '-File', installer, '-Json'], {
    env: { ...process.env, LOCALAPPDATA: root }, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.match(status.route, /HKCU Run/);
  assert.match(status.limitation, /signed in/);
  assert.equal(status.running, false);
  assert.equal(ps(`. '${startupLib}'; (Get-OaTrayStartup).command`), before);
  assert.equal(existsSync(join(home, 'oa-supervisor-tray.ps1')), false);
  assert.equal(existsSync(join(home, 'supervisor-daemon.lock')), false);
});
