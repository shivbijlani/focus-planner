import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
async function fakeHome(t, supervisorBody, browserBody = `
param([switch]$Json, [switch]$ReportOnly)
'checked' | Add-Content (Join-Path $PSScriptRoot 'browser-count.txt')
@{ healthy = $true; report_only = [bool]$ReportOnly } | ConvertTo-Json
`) {
  const root = await mkdtemp(join(tmpdir(), 'oa-tray-'));
  const home = join(root, 'overnight-agent');
  await mkdir(home);
  await writeFile(join(home, 'supervisor-tray.json'), JSON.stringify({ browserEnabled: true }));
  for (const name of ['oa-supervisor-tray.ps1', 'oa-supervisor-components.ps1']) {
    await copyFile(join(dir, name), join(home, name));
  }
  await writeFile(join(home, 'oa-supervisor-startup.ps1'), (await readFile(startupLib, 'utf8')) + `
function Get-OaLegacyInstall { @{ browserTaskInstalled = $false; browserShimInstalled = $false; browserProcesses = @() } }
function Test-OaLegacyBrowserProcessRunning { $false }
`);
  if (supervisorBody) await writeFile(join(home, 'oa-supervisor.ps1'), supervisorBody);
  if (browserBody) await writeFile(join(home, 'browser-watchdog.ps1'), browserBody);
  const trays = [];
  t.after(async () => {
    for (const { child, exited } of trays) {
      if (child.exitCode === null) {
        await writeFile(join(home, 'supervisor-tray-stop.json'), JSON.stringify({ pid: child.pid }));
        if (!await waitFor(() => child.exitCode !== null, 15_000)) child.kill();
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  return { root, home, trays };
}

function startTray(ctx, extra = []) {
  const child = spawn('powershell.exe', [...psArgs, '-STA', '-File', join(ctx.home, 'oa-supervisor-tray.ps1'),
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

async function enableBrowser(ctx) {
  await writeFile(join(ctx.home, 'supervisor-tray.json'), JSON.stringify({ browserEnabled: true }));
}

const countingSupervisor = `
$countPath = Join-Path $PSScriptRoot 'count.txt'
$count = if (Test-Path $countPath) { [int](Get-Content $countPath -Raw) } else { 0 }
($count + 1) | Set-Content $countPath
@{ state = 'HEALTHY'; actResult = @{ nextEvaluationAt =
  (Get-Date).ToUniversalTime().AddMilliseconds(700).ToString('o') } } | ConvertTo-Json -Compress -Depth 4
`;

test('only one startup route exists: no scheduled task, Startup shim or service is ever created', () => {
  for (const file of [tray, startupLib, installer, join(dir, 'install-browser-watchdog-skill.ps1')]) {
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
$good = [pscustomobject]@{ ProcessId = 5; Name = 'powershell.exe'; CommandLine = 'powershell -File C:\\h\\oa-supervisor-tray.ps1'; CreationDate = [datetime]::Parse('2026-09-26T12:00:30Z').ToUniversalTime() }
$legacy = [pscustomobject]@{ ProcessId = 5; Name = 'powershell.exe'; CommandLine = 'powershell -File C:\\h\\oa-supervisor-daemon.ps1'; CreationDate = $good.CreationDate }
$other = [pscustomobject]@{ ProcessId = 5; Name = 'powershell.exe'; CommandLine = 'powershell -File C:\\x\\other.ps1'; CreationDate = $good.CreationDate }
$reused = [pscustomobject]@{ ProcessId = 5; Name = 'powershell.exe'; CommandLine = $good.CommandLine; CreationDate = $good.CreationDate.AddHours(1) }
$host2 = [pscustomobject]@{ ProcessId = 5; Name = 'notepad.exe'; CommandLine = $good.CommandLine; CreationDate = $good.CreationDate }
@((Test-OaOwnerIdentity $rec $good), (Test-OaOwnerIdentity $rec $legacy), (Test-OaOwnerIdentity $rec $other),
  (Test-OaOwnerIdentity $rec $reused), (Test-OaOwnerIdentity $rec $host2), (Test-OaOwnerIdentity $null $good)) -join ','`);
  assert.equal(result, 'True,True,False,False,False,False');
});

test('tray scheduler wakes at the supervisor M/N boundary before its periodic interval', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  const { root, home } = ctx;
  await enableBrowser(ctx);
  startTray(ctx);
  assert.ok(await waitFor(async () => (await readCount(home)) >= 2),
    `the tray did not wake at the 700ms boundary; heartbeat=${JSON.stringify(await readBeat(home))}`);
  const beat = await readBeat(home);
  assert.equal(beat.kind, 'tray');
  assert.equal(beat.paused, false);
  assert.equal(beat.lastState, 'HEALTHY');
  assert.equal(beat.components['browser-watchdog'].state, 'HEALTHY');
  const browserRuns = (await readFile(join(home, 'browser-count.txt'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(browserRuns.length, 1, 'M/N wakes must not accelerate the hourly browser check');
});

test('a second tray cannot start while the supervisor lock is held', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  const { root, home } = ctx;
  startTray(ctx);
  assert.ok(await waitFor(() => existsSync(join(home, 'supervisor-daemon-heartbeat.json'))));
  const second = startTray(ctx);
  const code = await Promise.race([second.exited, new Promise(r => setTimeout(() => r('timeout'), 15_000))]);
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
  assert.equal(existsSync(join(home, 'browser-count.txt')), false);
  const beat = await readBeat(home);
  assert.equal(beat.paused, true);
});

test('verified stop request exits the tray gracefully and releases the lock', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  const { root, home } = ctx;
  const { exited } = startTray(ctx);
  assert.ok(await waitFor(() => existsSync(join(home, 'supervisor-daemon-heartbeat.json'))));
  const outcome = ps(`. '${startupLib}'; Stop-OaSupervisorOwner`, { LOCALAPPDATA: root });
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
  for (const name of ['oa-supervisor-tray.ps1', 'oa-supervisor-components.ps1', 'oa-supervisor-startup.ps1']) {
    await rm(join(home, name));
  }
  const before = ps(`. '${startupLib}'; (Get-OaTrayStartup).command`);
  const result = spawnSync('powershell.exe', [...psArgs, '-File', installer, '-Json'], {
    env: { ...process.env, LOCALAPPDATA: root }, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.match(status.route, /HKCU Run/);
  assert.match(status.limitation, /signed in/);
  assert.equal(status.running, false);
  assert.deepEqual(status.components, ['oa-supervisor', 'browser-watchdog']);
  assert.equal(ps(`. '${startupLib}'; (Get-OaTrayStartup).command`), before);
  assert.equal(existsSync(join(home, 'oa-supervisor-tray.ps1')), false);
  assert.equal(existsSync(join(home, 'supervisor-daemon.lock')), false);
});

test('one fixed component roster forwards detect-only to both checks', { skip: !windows }, () => {
  const rows = JSON.parse(ps(`. '${join(dir, 'oa-supervisor-components.ps1')}'
$originalHome = $HOME
$rows = @(Get-OaSupervisorComponents -OaHome 'C:\\h' -NoAct)
if ($HOME -ne $originalHome) { throw 'Component resolver changed automatic HOME' }
$rows | ConvertTo-Json -Depth 4`));
  assert.deepEqual(rows.map(row => row.name), ['oa-supervisor', 'browser-watchdog']);
  assert.deepEqual(rows[0].arguments, ['-NoAct']);
  assert.deepEqual(rows[1].arguments, ['-Json', '-ReportOnly']);
  assert.equal(rows[1].intervalMinutes, 60);
});

test('detect-only reaches both real tray children', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, `
param([switch]$NoAct)
if (-not $NoAct) { throw 'NoAct was not forwarded' }
@{ state = 'HEALTHY' } | ConvertTo-Json -Compress
`, `
param([switch]$Json, [switch]$ReportOnly)
if (-not $Json -or -not $ReportOnly) { throw 'ReportOnly was not forwarded' }
@{ healthy = $true } | ConvertTo-Json
`);
  await enableBrowser(ctx);
  startTray(ctx, ['-NoAct']);
  const healthy = await waitFor(async () => {
    if (!existsSync(join(ctx.home, 'supervisor-daemon-heartbeat.json'))) return false;
    const beat = await readBeat(ctx.home);
    return Object.values(beat.components).every(s => s.state === 'HEALTHY');
  });
  assert.ok(healthy, JSON.stringify(await readBeat(ctx.home)));
});

test('browser errors remain visible without blocking OA evaluations', { skip: !windows }, async t => {
  for (const [label, body, expected] of [
    ['crash', "Write-Error 'fixture crash'; exit 3", 'ERROR'],
    ['malformed', "'not-json'", 'ERROR'],
    ['unhealthy', "'{\"healthy\":false}'; exit 2", 'UNHEALTHY'],
    ['missing', null, 'ERROR'],
  ]) {
    await t.test(label, async sub => {
      const ctx = await fakeHome(sub, countingSupervisor, body);
      await enableBrowser(ctx);
      startTray(ctx);
      assert.ok(await waitFor(async () => (await readCount(ctx.home)) >= 2));
      const beat = await readBeat(ctx.home);
      assert.equal(beat.components['browser-watchdog'].state, expected);
      assert.equal(beat.components['oa-supervisor'].state, 'HEALTHY');
      if (expected === 'ERROR') assert.ok(beat.components['browser-watchdog'].error);
    });
  }
});

test('hung checker is bounded and its owned worker exits while the other component runs', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, `
$child = Start-Process node -ArgumentList @('-e', '"setInterval(()=>{},1000)"') -PassThru -NoNewWindow
$child.Id | Set-Content (Join-Path $PSScriptRoot 'worker.txt')
Start-Sleep -Seconds 120
`);
  await enableBrowser(ctx);
  startTray(ctx, ['-EvaluationTimeoutSeconds', '5']);
  assert.ok(await waitFor(async () => (await readBeat(ctx.home)).components['oa-supervisor'].lastExitCode === 124));
  const beat = await readBeat(ctx.home);
  assert.equal(beat.components['browser-watchdog'].state, 'HEALTHY');
  assert.match(beat.components['oa-supervisor'].error, /Timed out/);
  const pid = Number((await readFile(join(ctx.home, 'worker.txt'), 'utf8')).replace(/^\uFEFF/, '').trim());
  assert.equal(ps(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`), 'False');
});

test('exit cancels an in-flight checker before releasing the supervisor lock', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, `
$PID | Set-Content (Join-Path $PSScriptRoot 'worker.txt')
Start-Sleep -Seconds 120
`);
  const { exited } = startTray(ctx);
  assert.ok(await waitFor(() => existsSync(join(ctx.home, 'worker.txt'))));
  const pid = Number((await readFile(join(ctx.home, 'worker.txt'), 'utf8')).replace(/^\uFEFF/, '').trim());
  assert.equal(ps(`. '${startupLib}'; Stop-OaSupervisorOwner`, { LOCALAPPDATA: ctx.root }), 'stopped-gracefully');
  assert.equal(await exited, 0);
  assert.equal(ps(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`), 'False');
});

test('migration removes both known legacy routes and fails closed when removal is denied', { skip: !windows }, async t => {
  const { root } = await fakeHome(t);
  const oaShim = join(root, 'oa.cmd');
  const browserShim = join(root, 'browser.vbs');
  await writeFile(oaShim, 'fixture');
  await writeFile(browserShim, 'fixture');
  const script = `. '${startupLib}'
function Get-OaLegacyShimPath { '${oaShim}' }
function Get-BrowserWatchdogLegacyShimPath { '${browserShim}' }
function Get-OaLegacyBrowserProcesses { @() }
function Get-ScheduledTask {
  [pscustomobject]@{ TaskName = 'Overnight Agent supervisor'; TaskPath = '\\' }
  [pscustomobject]@{ TaskName = 'Copilot browser watchdog'; TaskPath = '\\' }
}
$script:removedTasks = @()
function Unregister-ScheduledTask { param($TaskName, $TaskPath, $Confirm, $ErrorAction)
  if ($TaskPath -ne '\\') { throw 'Migration must be scoped to root tasks' }
  $script:removedTasks += $TaskName
}
$removed = Remove-OaLegacyInstall
@{ tasks = $script:removedTasks; removed = $removed } | ConvertTo-Json -Depth 4`;
  const result = JSON.parse(ps(script));
  assert.deepEqual(result.tasks, ['Overnight Agent supervisor', 'Copilot browser watchdog']);
  assert.equal(existsSync(oaShim), false);
  assert.equal(existsSync(browserShim), false);
  assert.equal(result.removed.length, 4);
  assert.match(ps(script.replace('$script:removedTasks += $TaskName', "throw 'access denied'")
    .replace('$removed = Remove-OaLegacyInstall', "try { Remove-OaLegacyInstall; throw 'UNEXPECTED' } catch { $_.Exception.Message }; return")), /could not be removed/);
  assert.match(ps(script.replaceAll("TaskPath = '\\'", "TaskPath = '\\unrelated\\'")
    .replace('$removed = Remove-OaLegacyInstall', "try { Remove-OaLegacyInstall; throw 'UNEXPECTED' } catch { $_.Exception.Message }; return")), /outside the root task folder/);
});

test('browser consent defaults off inside the one tray and a component pause does not pause OA', { skip: !windows }, async t => {
  for (const [name, saved] of [['default-off', null], ['paused', { browserEnabled: true, browserPaused: true }]]) {
    await t.test(name, async sub => {
      const ctx = await fakeHome(sub, countingSupervisor);
      const statePath = join(ctx.home, 'supervisor-tray.json');
      if (saved) await writeFile(statePath, JSON.stringify(saved));
      else await rm(statePath);
      startTray(ctx);
      assert.ok(await waitFor(async () => (await readCount(ctx.home)) >= 2));
      const beat = await readBeat(ctx.home);
      assert.equal(existsSync(join(ctx.home, 'browser-count.txt')), false);
      assert.equal(beat.components['browser-watchdog'].enabled, Boolean(saved));
      assert.equal(beat.components['browser-watchdog'].paused, Boolean(saved));
      assert.equal(beat.components['oa-supervisor'].state, 'HEALTHY');
    });
  }
});

test('tray-owned browser history survives restart without adding a dispatcher', { skip: !windows }, async t => {
  const ctx = await fakeHome(t, countingSupervisor);
  await enableBrowser(ctx);
  const first = startTray(ctx);
  assert.ok(await waitFor(async () => (await readBeat(ctx.home)).components['browser-watchdog'].state === 'HEALTHY'));
  const saved = JSON.parse((await readFile(join(ctx.home, 'supervisor-tray.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(saved.browserEnabled, true);
  assert.equal(saved.browserRecent.at(-1).state, 'HEALTHY');
  assert.equal(saved.browserRecent.at(-1).exitCode, 0);
  ps(`. '${startupLib}'; Stop-OaSupervisorOwner`, { LOCALAPPDATA: ctx.root });
  assert.equal(await first.exited, 0);
  startTray(ctx);
  assert.ok(await waitFor(async () => {
    const state = JSON.parse((await readFile(join(ctx.home, 'supervisor-tray.json'), 'utf8')).replace(/^\uFEFF/, ''));
    return state.browserRecent?.length === 2;
  }));
});

test('canonical installer deploys every component dependency and re-runs from the flat home', { skip: !windows }, async t => {
  const { root, home } = await fakeHome(t);
  const source = join(root, 'source with spaces');
  await mkdir(source);
  const installerText = await readFile(installer, 'utf8');
  const names = [...installerText.match(/\$DeployedFiles = @\(([\s\S]*?)\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const name of names) {
    const from = existsSync(join(dir, name)) ? join(dir, name) : join(dir, '..', 'skills', 'overnight-agent', name);
    await copyFile(from, join(source, name));
  }
  await copyFile(installer, join(source, 'install-oa-supervisor.ps1'));
  const fixtureHelpers = `
function Get-OaLegacyInstall { @{ taskInstalled = $false; shimInstalled = $false; browserProcesses = @() } }
function Remove-OaLegacyInstall { @() }
function Stop-OaSupervisorOwner { 'none' }
function Get-OaSupervisorOwner { $null }
function Enable-OaTrayStartup { param($CommandLine) $CommandLine | Set-Content (Join-Path (Get-OaHome) 'fixture-run.txt') }
function Get-OaTrayStartup { @{ enabled = $true; route = 'fixture'; command = '' } }
`;
  await writeFile(join(source, 'oa-supervisor-startup.ps1'),
    (await readFile(startupLib, 'utf8')) + fixtureHelpers);
  const run = (file, localAppData = root) => spawnSync('powershell.exe', [...psArgs, '-File', file, '-Enable', '-NoStart'], {
    env: { ...process.env, LOCALAPPDATA: localAppData }, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  const first = run(join(source, 'install-oa-supervisor.ps1'));
  assert.equal(first.status, 0, first.stderr);
  for (const name of names) assert.ok(existsSync(join(home, name)), `missing ${name}`);
  assert.match(await readFile(join(home, 'fixture-run.txt'), 'utf8'), /oa-supervisor-tray\.ps1/);
  await copyFile(installer, join(home, 'install-oa-supervisor.ps1'));
  const aliasRoot = join(tmpdir(), `oa-tray-alias-${process.pid}-${Date.now()}`);
  await symlink(root, aliasRoot, 'junction');
  try {
    const second = run(join(home, 'install-oa-supervisor.ps1'), aliasRoot);
    assert.equal(second.status, 0, second.stderr);
  } finally {
    await rm(aliasRoot, { recursive: true, force: true });
  }
});
