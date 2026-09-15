// Isolated Windows fixtures only: no installed OA home, task registration or app actions.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP supervisor deployment: Windows fixture');
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.cwd(), `.sd-${randomUUID().slice(0, 8)}`);
const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const runtime = [
  'oa-supervisor.ps1', 'oa-supervisor-lifecycle.ps1', 'oa-supervisor-daemon.ps1',
  'supervisor-activity.mjs', 'supervisor-defaults.json', 'stuck-run-sweep.mjs',
];
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = (script, extra = []) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra];
function run(command, argv, cwd = root) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${argv.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await sleep(50);
  }
}
const children = [];
fs.mkdirSync(root, { recursive: true });
async function testDaemon(engine) {
  // This stub has no process APIs or app access; -OaHome is always an isolated directory.
  const daemonHome = path.join(root, engine === ps ? 'PS5 daemon home' : 'pwsh daemon home');
  fs.mkdirSync(daemonHome);
  const stub = `
param([string]$OaHome, [switch]$NoAct)
$events = Join-Path $OaHome 'ticks.jsonl'
$next = [DateTimeOffset]::UtcNow.AddMilliseconds(150).ToOffset([TimeSpan]::FromHours(-7)).ToString('o')
@{ noAct = [bool]$NoAct; utc = [DateTimeOffset]::UtcNow.ToString('o'); engine = $PSVersionTable.PSVersion.Major; nextCheckUtc = $next } |
  ConvertTo-Json -Compress | Add-Content -LiteralPath $events
$count = @(Get-Content -LiteralPath $events).Count
if ($count -ge 2) { [IO.File]::WriteAllText((Join-Path $OaHome 'supervisor-daemon.stop'), 'stop') }
@{ state = 'FIXTURE'; nextCheckUtc = $next } |
  ConvertTo-Json -Compress
exit 1
`;
  write(path.join(daemonHome, 'oa-supervisor.ps1'), stub);
  // A reused/live PID in an old file does not own an OS file lock.
  write(path.join(daemonHome, 'supervisor-daemon.lock'), JSON.stringify({ pid: process.pid }));
  const started = Date.now();
  run(engine, args(path.join(here, 'oa-supervisor-daemon.ps1'), ['-OaHome', daemonHome, '-NoAct']));
  const ticks = fs.readFileSync(path.join(daemonHome, 'ticks.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(ticks.length, 2);
  assert.ok(ticks.every(t => t.noAct));
  assert.ok(ticks.every(t => t.engine === (engine === ps ? 5 : 7)), 'child uses the selected daemon engine');
  assert.ok(Date.now() - started < 15_000, 'must honor nextCheckUtc, not fixed 15-minute sleep');
  const heartbeat = JSON.parse(fs.readFileSync(path.join(daemonHome, 'supervisor-daemon-heartbeat.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(heartbeat.noAct, true);
  assert.equal(Date.parse(heartbeat.nextCheckUtc), Date.parse(ticks.at(-1).nextCheckUtc), 'offset-bearing deadline instant must survive both engines exactly');
  assert.equal(heartbeat.lastError, null, 'exit 1 means action success, not child failure');

  fs.rmSync(path.join(daemonHome, 'supervisor-daemon.stop'));
  fs.rmSync(path.join(daemonHome, 'ticks.jsonl'));
  fs.rmSync(path.join(daemonHome, 'supervisor-daemon-heartbeat.json'));
  write(path.join(daemonHome, 'oa-supervisor.ps1'), stub.replace('AddMilliseconds(150)', 'AddSeconds(60)'));
  const child = spawn(engine, args(path.join(here, 'oa-supervisor-daemon.ps1'), ['-OaHome', daemonHome]), {
    cwd: root, stdio: 'ignore', windowsHide: true,
  });
  children.push(child);
  await until(() => fs.existsSync(path.join(daemonHome, 'supervisor-daemon-heartbeat.json')), 'first daemon heartbeat');
  const beforeDuplicate = Date.now();
  const duplicateOutput = run(engine, args(path.join(here, 'oa-supervisor-daemon.ps1'), ['-OaHome', daemonHome, '-Once']));
  assert.equal(fs.readFileSync(path.join(daemonHome, 'ticks.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1,
    `a concurrent daemon must not execute another tick; firstExit=${child.exitCode}; duration=${Date.now() - beforeDuplicate}; second=${duplicateOutput}`);
  write(path.join(daemonHome, 'supervisor-daemon.stop'), 'stop');
  await until(() => child.exitCode !== null, 'cooperative shutdown during UTC-aware wait');
  assert.equal(child.exitCode, 0);
  fs.rmSync(path.join(daemonHome, 'supervisor-daemon.stop'));
  write(path.join(daemonHome, 'oa-supervisor.ps1'), `param([string]$OaHome, [switch]$NoAct)\n'{"state":"BAD"}'\n`);
  run(engine, args(path.join(here, 'oa-supervisor-daemon.ps1'), ['-OaHome', daemonHome, '-Once']));
  const readBeat = () => JSON.parse(fs.readFileSync(path.join(daemonHome, 'supervisor-daemon-heartbeat.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(readBeat().lastState, 'DAEMON-ERROR');
  assert.match(readBeat().lastError, /nextCheckUtc/);
  fs.rmSync(path.join(daemonHome, 'oa-supervisor.ps1'));
  run(engine, args(path.join(here, 'oa-supervisor-daemon.ps1'), ['-OaHome', daemonHome, '-Once']));
  assert.match(readBeat().lastError, /Supervisor missing/);
  assert.ok(Date.parse(readBeat().nextCheckUtc) > Date.parse(readBeat().lastCheckUtc), 'missing child schedules a future retry');

  fs.rmSync(path.join(daemonHome, 'ticks.jsonl'));
  fs.rmSync(path.join(daemonHome, 'supervisor-daemon-errors.jsonl'));
  write(path.join(daemonHome, 'supervisor-config.json'), '{"retryInitialSeconds":1,"retryMaxSeconds":2}');
  write(path.join(daemonHome, 'oa-supervisor.ps1'), `
param([string]$OaHome, [switch]$NoAct)
$events = Join-Path $OaHome 'ticks.jsonl'
@{ noAct = [bool]$NoAct; utc = [DateTimeOffset]::UtcNow.ToString('o') } |
  ConvertTo-Json -Compress | Add-Content -LiteralPath $events
$count = @(Get-Content -LiteralPath $events).Count
if ($count -eq 1) { '{"state":"MISSING-NEXT"}'; exit 0 }
if ($count -eq 2) { '{invalid-json'; exit 0 }
if ($count -eq 3) { exit 17 }
[IO.File]::WriteAllText((Join-Path $OaHome 'supervisor-daemon.stop'), 'stop')
@{ state = 'RECOVERED'; nextCheckUtc = [DateTimeOffset]::UtcNow.AddSeconds(60).ToString('o') } |
  ConvertTo-Json -Compress
`);
  run(engine, args(path.join(here, 'oa-supervisor-daemon.ps1'), ['-OaHome', daemonHome, '-NoAct']));
  const errors = fs.readFileSync(path.join(daemonHome, 'supervisor-daemon-errors.jsonl'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(errors.map(e => e.retrySeconds), [1, 2, 2], 'retry doubles and caps without relying on Task Scheduler');
  assert.ok(errors.every(e => e.error && Number.isFinite(Date.parse(e.nextCheckUtc))));
  assert.equal(readBeat().lastState, 'RECOVERED');
  assert.equal(readBeat().consecutiveFailures, 0);
  assert.equal(readBeat().lastError, null);
  const recoveredTicks = fs.readFileSync(path.join(daemonHome, 'ticks.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(recoveredTicks.every(t => t.noAct), 'retries retain detect-only');
  for (let i = 1; i < recoveredTicks.length; i++) {
    assert.ok(Date.parse(recoveredTicks[i].utc) >= Date.parse(errors[i - 1].nextCheckUtc) - 50,
      'retry must not execute before its absolute UTC deadline');
  }
  console.log(`PASS dispatcher (${engine === ps ? 'Windows PowerShell 5.1' : 'pwsh'}): nextCheckUtc, detect-only, exclusive singleton, stale PID, cooperative stop, bounded child-error recovery`);
}

try {
  for (const engine of [ps, 'pwsh.exe']) await testDaemon(engine);
  if (!process.argv.includes('--dispatcher-only')) {
    // Copy the exact runtime artifact closure, then exercise installer copy-only mode.
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    for (const name of [...runtime, 'install-oa-supervisor.ps1']) {
      assert.ok(fs.existsSync(path.join(here, name)), `missing shipped dependency ${name}`);
      fs.copyFileSync(path.join(here, name), path.join(source, name));
    }
    const home = path.join(root, 'installed fixture');
    const override = '{"preventiveStartHours":1,"preventiveDeadlineHours":2}\n';
    write(path.join(home, 'supervisor-config.json'), override);
    run(ps, args(path.join(source, 'install-oa-supervisor.ps1'), ['-DeployOnly', '-OaHome', home]));
    for (const name of runtime) assert.equal(sha(path.join(home, name)), sha(path.join(here, name)), `installer hash ${name}`);
    assert.equal(fs.readFileSync(path.join(home, 'supervisor-config.json'), 'utf8'), override);

    // Mock ALL scheduler/process commands before exercising registration and fallback.
    // StartupDirectory confines the only shim write to this fixture.
    const wrapper = path.join(root, 'mock-installer.ps1');
    write(wrapper, `
param([string]$Source, [string]$FixtureHome, [string]$Startup, [string]$Record, [switch]$Fallback)
$global:fixtureCaptured = @{}
function Get-CimInstance { param($ClassName, $Filter) @() }
function New-ScheduledTaskAction { param($Execute, $Argument)
  $global:fixtureCaptured.action = $Argument; @{ Execute = $Execute; Argument = $Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, [switch]$Once, $At, $RepetitionInterval, $RepetitionDuration) @{} }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) $global:fixtureCaptured.logonType=$LogonType; @{} }
function New-ScheduledTaskSettingsSet {
  param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries,
    [switch]$StartWhenAvailable, $ExecutionTimeLimit, $MultipleInstances, $RestartCount, $RestartInterval)
  $global:fixtureCaptured.limit = $ExecutionTimeLimit.TotalSeconds
  $global:fixtureCaptured.multiple = $MultipleInstances
  $global:fixtureCaptured.restartCount = $RestartCount
  $global:fixtureCaptured.restartSeconds = $RestartInterval.TotalSeconds
  @{}
}
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force)
  if ($Fallback) { throw 'fixture denied registration' }
}
function Start-ScheduledTask { param($TaskName) $global:fixtureCaptured.taskStarted = $true }
function Start-Process {
  param($FilePath, $ArgumentList, $WindowStyle)
  $global:fixtureCaptured.startedArguments = $ArgumentList
}
& (Join-Path $Source 'install-oa-supervisor.ps1') -OaHome $FixtureHome -StartupDirectory $Startup -NoAct
$global:fixtureCaptured | ConvertTo-Json | Set-Content -LiteralPath $Record -Encoding utf8
`);
    const startup = path.join(root, 'startup');
    fs.mkdirSync(startup);
    for (const fallback of [false, true]) {
      const record = path.join(root, `dispatch-${fallback}.json`);
      run(ps, args(wrapper, ['-Source', source, '-FixtureHome', home, '-Startup', startup,
        '-Record', record, ...(fallback ? ['-Fallback'] : [])]));
      const captured = JSON.parse(fs.readFileSync(record, 'utf8').replace(/^\uFEFF/, ''));
      assert.match(captured.action, /oa-supervisor-daemon\.ps1/);
      assert.match(captured.action, / -NoAct$/);
      assert.equal(captured.limit, 0);
      assert.equal(captured.logonType, 'Interactive', 'supervisor must share the desktop GUI logon session, not S4U');
      assert.equal(captured.multiple, 'IgnoreNew');
      assert.equal(captured.restartSeconds, 60);
      assert.ok(captured.restartCount > 0);
      if (fallback) {
        assert.equal(captured.startedArguments, captured.action, 'immediate fallback inherits -NoAct');
        assert.ok(fs.readFileSync(path.join(startup, 'Overnight Agent supervisor.cmd'), 'utf8').includes(captured.action),
          'Startup fallback inherits the same resident action and -NoAct');
      } else {
        assert.equal(captured.taskStarted, true);
      }
    }
    fs.rmSync(path.join(source, 'supervisor-defaults.json'));
    const rejected = spawnSync(ps, args(path.join(source, 'install-oa-supervisor.ps1'), ['-DeployOnly', '-OaHome', path.join(root, 'incomplete')]),
      { cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.ifError(rejected.error);
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.existsSync(path.join(root, 'incomplete')), false, 'missing closure fails before copying');

    // Real flat-home sync against a private synthetic git ref, never main or a live home.
    const repo = path.join(root, 'repo');
    const checks = path.join(repo, 'plugins', 'overnight-agent', 'checks');
    fs.mkdirSync(checks, { recursive: true });
    for (const name of runtime) fs.copyFileSync(path.join(here, name), path.join(checks, name));
    write(path.join(checks, 'run-sweeps.ps1'), "$Suite = @(@{ n = 'config-probe'; bridge = $false })\n");
    write(path.join(checks, 'config-probe.mjs'), "import { join } from 'node:path';\nconst HERE = '.';\njoin(HERE, 'supervisor-config.json');\n");
    write(path.join(checks, 'supervisor-config.json'), override);
    run('git', ['init', '--quiet'], repo);
    run('git', ['config', 'core.autocrlf', 'false'], repo);
    run('git', ['config', 'core.longpaths', 'true'], repo);
    run('git', ['add', '.'], repo);
    run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], repo);
    // Even a repo version of a historically matching override cannot overwrite local config.
    write(path.join(checks, 'supervisor-config.json'), '{"preventiveStartHours":99}\n');
    run('git', ['add', '.'], repo);
    run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture update'], repo);
    const flat = path.join(root, 'flat home');
    write(path.join(flat, 'supervisor-config.json'), override);
    run(ps, args(path.join(here, 'sync-oa-home.ps1'), [
      '-Repo', repo, '-OaHome', flat, '-Ref', 'HEAD', '-SkipFetch', '-SkipBackup',
      '-StatePath', path.join(root, 'sync-state.json'), '-Json',
    ]));
    for (const name of runtime) assert.equal(sha(path.join(flat, name)), sha(path.join(here, name)), `flat-home hash ${name}`);
    assert.ok(fs.existsSync(path.join(flat, 'config-probe.mjs')), 'override probe must actually enter the required closure');
    assert.equal(fs.readFileSync(path.join(flat, 'supervisor-config.json'), 'utf8'), override);
    console.log(`PASS deployment: ${runtime.length} exact installer and flat-home hashes; overrides preserved; incomplete closure refused; task/fallback -NoAct and resident settings`);
  }
} finally {
  // Only fixture children created above can be terminated; never enumerate live processes.
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
      await until(() => child.exitCode !== null || child.signalCode !== null, 'fixture cleanup');
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
