// Real PS entry point, real SQLite/log evidence, fake time and OS processes only.
import assert from 'node:assert/strict';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-window-'));
const subject = process.env.SUPERVISOR_TEST_SUBJECT || path.join(here, 'oa-supervisor.ps1');
const engines = process.env.SUPERVISOR_TEST_POWERSHELL ? [process.env.SUPERVISOR_TEST_POWERSHELL]
  : process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'];
const base = Date.parse('2026-09-15T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const bootstrap = path.join(root, 'bootstrap.ps1');
fs.writeFileSync(bootstrap, `
param([string]$Supervisor, [string]$FixtureFile, [string]$FixtureHome)
$ErrorActionPreference = 'Stop'
$global:fixtureFile = $FixtureFile
$jsonOptions = @{}
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $jsonOptions.DateKind='String' }
$global:f = Get-Content -LiteralPath $FixtureFile -Raw | ConvertFrom-Json @jsonOptions
$global:clock = [datetime]::Parse($global:f.now).ToUniversalTime()
$global:inventoryCalls = 0
function global:Save-Fixture {
  $global:f.now = $global:clock.ToString('o')
  $global:f | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $global:fixtureFile -Encoding UTF8
}
function global:Get-Date { return $global:clock }
function global:Start-Sleep {
  param([int]$Seconds, [int]$Milliseconds)
  $global:clock = $global:clock.AddSeconds($Seconds).AddMilliseconds($Milliseconds)
}
function global:Get-CimInstance {
  [CmdletBinding()] param([string]$ClassName)
  $global:inventoryCalls++
  if ($global:f.inventoryFailure) { throw 'fixture inventory failure' }
  if ($global:f.recheckBusy -and $global:inventoryCalls -eq 2) {
    Add-Content -LiteralPath $global:f.manualLog -Value ('{"type":"assistant.turn_start","timestamp":"' + $global:clock.ToString('o') + '"}')
  }
  if ($global:f.recheckIdleActivity -and $global:inventoryCalls -eq 2) {
    foreach ($type in @('assistant.turn_start','assistant.turn_end')) {
      Add-Content -LiteralPath $global:f.manualLog -Value ('{"type":"' + $type + '","timestamp":"' + $global:clock.ToString('o') + '"}')
    }
  }
  foreach ($p in $global:f.processes) {
    [pscustomobject]@{ ProcessId=$p.id; ParentProcessId=$p.parentId; ExecutablePath=$p.path; Name=$p.name; SessionId=1; CreationDate=[datetime]::Parse($p.startedUtc).ToUniversalTime() }
  }
}
function global:Get-Process {
  [CmdletBinding()] param([int[]]$Id, [string[]]$Name)
  if ($Id -contains $PID) { return [pscustomobject]@{ SessionId=1 } }
  foreach ($p in $global:f.processes) {
    if ($Id -and $p.id -notin $Id) { continue }
    if ($Name -and $p.name.Replace('.exe','') -notin $Name) { continue }
    $started = [datetime]::Parse($p.startedUtc).ToUniversalTime()
    if ($global:f.pidReuse -and $global:inventoryCalls -ge 2 -and $p.id -eq 100) { $started = $started.AddSeconds(1) }
    $o = [pscustomobject]@{ Id=$p.id; Path=$p.path; ProcessName=$p.name.Replace('.exe',''); StartTime=$started; SessionId=1; MainWindowHandle=42; Responding=([bool]$p.ready); Handle=42 }
    $o | Add-Member ScriptMethod Dispose {}
    $o | Add-Member ScriptMethod WaitForExit { param($Timeout) return $true }
    $o
  }
}
function global:Stop-Process {
  [CmdletBinding()] param([int[]]$Id,[switch]$Force)
  @{kind='kill'; ids=$Id} | ConvertTo-Json -Compress | Add-Content -LiteralPath $global:f.actions
  $global:f.processes = @($global:f.processes | Where-Object { $_.id -notin $Id })
  Save-Fixture
  if ($global:f.crashAfterKill) { exit 77 }
}
function global:Start-Process {
  [CmdletBinding()] param([string]$FilePath,[switch]$PassThru)
  @{kind='launch'; exe=$FilePath} | ConvertTo-Json -Compress | Add-Content -LiteralPath $global:f.actions
  if ($global:f.launchFailure) { throw 'fixture launch failed' }
  $global:f.processes += [pscustomobject]@{id=200;parentId=0;path=$FilePath;name='github.exe';startedUtc=$global:clock.ToString('o');ready=(-not $global:f.readinessFailure)}
  Save-Fixture
  if ($global:f.crashAfterLaunch) { exit 78 }
  $o = [pscustomobject]@{Id=200}
  $o | Add-Member ScriptMethod Dispose {}
  return $o
}
& $Supervisor -OaHome $FixtureHome -ResourceFactsJson $global:f.resource -NoAct:([bool]$global:f.noAct)
exit $LASTEXITCODE
`);

let passed = 0;
function check(name, fn) {
  if (process.env.SUPERVISOR_TEST_FILTER && !name.includes(process.env.SUPERVISOR_TEST_FILTER)) return;
  fn(); passed++; console.log(`PASS ${name}`);
}
function fixture(engine, name, options = {}) {
  const dir = fs.mkdtempSync(path.join(root, `${name}-`));
  const home = path.join(dir, 'profile');
  const oa = path.join(dir, 'custom-oa-home');
  const sessions = path.join(home, '.copilot', 'session-state');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(oa);
  const configPath = path.join(dir, 'fixture.json');
  const statePath = path.join(oa, 'supervisor-state.json');
  const appExe = path.join(dir, 'github.exe');
  fs.writeFileSync(appExe, 'fixture: never execute');
  const dbPath = path.join(home, '.copilot', 'data.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions(id TEXT,is_running INTEGER);
    CREATE TABLE workflows(id TEXT,name TEXT,enabled INTEGER,schedule TEXT);
    CREATE TABLE workflow_runs(id TEXT,task_id TEXT,session_id TEXT,status TEXT,trigger TEXT,started_at TEXT,completed_at TEXT,error_message TEXT);
    INSERT INTO workflows VALUES('wf','Overnight Agent',1,'*/30 * * * *');`);
  db.prepare('INSERT INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)').run(
    'run', 'wf', 'finished', options.fault === 'stuck' ? 'running' : 'completed', 'schedule',
    iso(base - (options.fault ? 100 : 1) * 60000), iso(base - 10000), null,
  );
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('finished', 0);
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('manual', options.activity === 'BUSY' ? 1 : 0);
  db.close();
  const processes = [
    { id: 100, parentId: 0, path: appExe, name: 'github.exe', startedUtc: iso(base - (options.ageHours ?? 13) * 3600000), ready: true },
    { id: 101, parentId: 100, path: path.join(dir, 'copilot.exe'), name: 'copilot.exe', startedUtc: iso(base - 3600000), ready: true },
    { id: 102, parentId: 101, path: path.join(dir, 'tool.exe'), name: 'tool.exe', startedUtc: iso(base - 3500000), ready: true },
    { id: 300, parentId: 0, path: path.join(dir, 'foreign', 'github.exe'), name: 'github.exe', startedUtc: iso(base - 3600000), ready: true },
    { id: 301, parentId: 0, path: path.join(dir, 'copilot.exe'), name: 'copilot.exe', startedUtc: iso(base - 3600000), ready: true },
  ];
  function session(id, pid, type) {
    const folder = path.join(sessions, id);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, `inuse.${pid}.lock`), '');
    const file = path.join(folder, 'events.jsonl');
    fs.writeFileSync(file, [
      { type: 'session.start', timestamp: iso(base - 3599000) },
      { type: 'assistant.turn_start', timestamp: iso(base - 10000) },
      ...(type === 'BUSY' ? [{ type: 'tool.execution_start', data: { toolCallId: 'long' }, timestamp: iso(base - 9000) }]
        : [{ type: 'session.task_complete', timestamp: iso(base - 7000) }, { type: 'assistant.turn_end', timestamp: iso(base - 6000) }]),
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    if (type === 'UNKNOWN') fs.writeFileSync(file, '{partial');
    return file;
  }
  session('finished', 101, 'IDLE');
  const manualLog = session('manual', 301, options.activity ?? 'IDLE');
  const resource = path.join(dir, 'resource.json');
  fs.writeFileSync(resource, JSON.stringify(options.resource ?? { queueLength: 0, appCpuHours: 0, appAgeHours: 13 }));
  const config = {
    now: iso(base), processes, manualLog, resource, actions: path.join(dir, 'actions.jsonl'),
    noAct: false, launchFailure: false, readinessFailure: false, inventoryFailure: false,
    recheckBusy: false, pidReuse: false, crashAfterKill: false, crashAfterLaunch: false, ...options, resource,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const settings = { appExe, readinessTimeoutSeconds: 1, ...options.settings };
  fs.writeFileSync(path.join(oa, 'supervisor-config.json'), JSON.stringify(settings));
  let originalWorkflows = fs.readFileSync(dbPath);
  const originalSettings = fs.readFileSync(path.join(oa, 'supervisor-config.json'));
  const calls = () => fs.existsSync(config.actions) ? fs.readFileSync(config.actions, 'utf8').replaceAll('\uFEFF', '').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : [];
  const load = () => JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const update = data => fs.writeFileSync(configPath, JSON.stringify({ ...load(), ...data }));
  return {
    statePath, oa, dbPath, calls, load, update, appExe, manualLog,
    refreshExpectedDb() { originalWorkflows = fs.readFileSync(dbPath); },
    advance(seconds) { update({ now: iso(Date.parse(load().now) + seconds * 1000) }); },
    invoke(sut = subject, allowCrash = false, allowFailure = false) {
      const run = spawnSync(engine, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', bootstrap, '-Supervisor', sut, '-FixtureFile', configPath, '-FixtureHome', oa], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: path.join(dir, 'local'), TEMP: dir, NODE_NO_WARNINGS: '1',
          STUCK_RUN_DB: dbPath, STUCK_RUN_SESSION_ROOT: sessions, STUCK_RUN_BACKUP_DIR: path.join(dir, 'backups') },
      });
      assert.ifError(run.error);
      assert.deepEqual(fs.readFileSync(dbPath), originalWorkflows, 'workflows/schedule DB remains byte-for-byte unchanged');
      assert.deepEqual(fs.readFileSync(path.join(oa, 'supervisor-config.json')), originalSettings);
      if (allowCrash) { assert.ok([77, 78].includes(run.status)); return run; }
      const line = run.stdout.split(/\r?\n/).filter(l => l.startsWith('{')).at(-1);
      assert.ok(line, `no JSON: ${run.status}\n${run.stdout}\n${run.stderr}`);
      const result = JSON.parse(line);
      if (!allowFailure) assert.notEqual(result.state, 'SUPERVISOR-FAILED', JSON.stringify(result));
      const log = JSON.parse(fs.readFileSync(path.join(oa, 'supervisor-log.jsonl'), 'utf8').replaceAll('\uFEFF', '').trim().split(/\r?\n/).at(-1));
      assert.deepEqual(log, result);
      return { ...result, exitCode: run.status };
    },
  };
}

try {
  for (const engine of engines) {
    check(`${engine}: before A never performs preventive restart`, () => {
      const f = fixture(engine, 'before-a', { ageHours: 11 });
      assert.equal(f.invoke().decision, 'before-window');
      f.advance(30); assert.equal(f.invoke().decision, 'before-window');
      assert.deepEqual(f.calls(), []);
    });
    check(`${engine}: non-UTC clock input schedules the exact UTC deadline, not a seven-hour offset`, () => {
      const f = fixture(engine, 'offset-clock', { ageHours: 24 - 10 / 3600, activity: 'BUSY' });
      f.update({ now: '2026-09-15T05:00:00-07:00' });
      const first = f.invoke();
      assert.equal(Date.parse(first.nextCheckUtc), base + 10000);
      assert.equal(Date.parse(first.ts), base);
      f.advance(10);
      assert.equal(f.invoke().reason, 'deadline-forced');
    });
    check(`${engine}: at A measures quiet, then restarts only exact owned identities`, () => {
      const f = fixture(engine, 'at-a', { ageHours: 12 });
      const first = f.invoke();
      assert.equal(first.decision, 'measuring-quiet');
      assert.equal(Date.parse(first.nextCheckUtc), base + 30000);
      f.advance(30);
      const r = f.invoke();
      assert.equal(r.reason, 'preventive-quiet'); assert.equal(r.acted, true, JSON.stringify(r));
      assert.deepEqual(f.calls().filter(c => c.kind === 'kill').flatMap(c => c.ids).sort(), [100, 101, 102]);
      assert.equal(f.calls().filter(c => c.kind === 'launch').length, 1);
      assert.equal(Date.parse(r.cycle.startedUtc), base + 30000);
      assert.equal(r.automationRecovery.state, 'not-observed');
      f.advance(1);
      assert.equal(f.invoke().decision, 'before-window');
      assert.equal(f.calls().filter(c => c.kind === 'launch').length, 1, 'duplicate tick cannot restart again');
    });
    for (const activity of ['BUSY', 'UNKNOWN']) {
      check(`${engine}: completed parent and ${activity} manual/child work veto early restart`, () => {
        const f = fixture(engine, `early-${activity}`, { activity });
        f.invoke(); f.advance(31);
        assert.equal(f.invoke().decision, 'wait-activity');
        assert.deepEqual(f.calls(), []);
      });
      check(`${engine}: B forces restart exactly at deadline despite ${activity}`, () => {
        const f = fixture(engine, `deadline-${activity}`, { activity, ageHours: 24 - 10 / 3600 });
        const first = f.invoke();
        assert.equal(Date.parse(first.nextCheckUtc), base + 10000);
        f.advance(10);
        const r = f.invoke();
        assert.equal(r.reason, 'deadline-forced'); assert.equal(r.acted, true, JSON.stringify(r));
        assert.deepEqual(f.calls().filter(c => c.kind === 'kill').flatMap(c => c.ids).sort(), [100, 101, 102]);
      });
    }
    check(`${engine}: sleep across B forces next available tick without resetting clock`, () => {
      const f = fixture(engine, 'sleep', { activity: 'BUSY', ageHours: 20 });
      const original = f.invoke().cycle;
      f.advance(6 * 3600);
      const r = f.invoke();
      assert.equal(r.reason, 'deadline-forced'); assert.notEqual(r.cycle.identity, original.identity);
    });
    check(`${engine}: quiet final recheck can veto restart`, () => {
      const f = fixture(engine, 'recheck');
      f.invoke(); f.advance(30); f.update({ recheckBusy: true });
      assert.equal(f.invoke().reason, 'activity-changed-before-action');
      assert.deepEqual(f.calls(), []);
    });
    check(`${engine}: PID reuse at B never kills a different incarnation`, () => {
      const f = fixture(engine, 'pid-reuse', { ageHours: 24, pidReuse: true, activity: 'BUSY' });
      const r = f.invoke();
      assert.match(r.error, /identity changed/); assert.deepEqual(f.calls(), []);
      assert.equal(r.attempt.count, 1);
    });
    for (const failure of ['launchFailure', 'readinessFailure']) {
      check(`${engine}: ${failure} preserves old cycle, backs off, never repeats kills`, () => {
        const f = fixture(engine, failure, { ageHours: 24, activity: 'BUSY', [failure]: true });
        const first = f.invoke();
        assert.equal(first.acted, false);
        assert.equal(Date.parse(first.cycle.startedUtc), base - 24 * 3600000);
        const kills = f.calls().filter(c => c.kind === 'kill').length;
        f.advance(1);
        const second = f.invoke(); assert.equal(second.decision, 'retry-backoff');
        f.advance(65);
        const third = f.invoke();
        assert.equal(third.acted, false);
        assert.equal(f.calls().filter(c => c.kind === 'kill').length, kills);
        assert.equal(third.attempt.count, 2);
      });
    }
    check(`${engine}: launch failure then success anchors actual app start exactly once`, () => {
      const f = fixture(engine, 'retry-success', { ageHours: 24, launchFailure: true });
      f.invoke(); f.advance(61); f.update({ launchFailure: false });
      const r = f.invoke(); assert.equal(r.acted, true); assert.equal(r.attempt, null);
      assert.equal(Date.parse(r.cycle.startedUtc), base + 61000);
    });
    check(`${engine}: retry backoff is capped at the configured maximum`, () => {
      const f = fixture(engine, 'retry-cap', { ageHours: 24, launchFailure: true });
      f.invoke();
      const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
      state.attempt.count = 20; state.attempt.retryUtc = iso(base - 1000);
      fs.writeFileSync(f.statePath, JSON.stringify(state));
      const r = f.invoke();
      assert.equal(Date.parse(r.attempt.retryUtc), base + 900000);
      assert.equal(r.attempt.count, 21);
    });
    check(`${engine}: delayed readiness anchors process birth, not verification time`, () => {
      const f = fixture(engine, 'late-readiness', { ageHours: 24, readinessFailure: true });
      f.invoke(); f.advance(50);
      const config = f.load();
      config.processes.find(p => p.id === 200).ready = true;
      f.update(config);
      const r = f.invoke();
      assert.equal(r.attempt, null); assert.equal(Date.parse(r.cycle.startedUtc), base);
      assert.equal(f.calls().filter(c => c.kind === 'launch').length, 1);
    });
    for (const phase of ['crashAfterKill', 'crashAfterLaunch']) {
      check(`${engine}: supervisor crash ${phase} recovers durable intent without duplicate restart`, () => {
        const f = fixture(engine, phase, { ageHours: 24, [phase]: true });
        f.invoke(subject, true);
        assert.ok(fs.existsSync(f.statePath));
        f.update({ [phase]: false }); f.advance(61);
        const r = f.invoke();
        assert.equal(r.attempt, null, JSON.stringify(r));
        assert.equal(f.calls().filter(c => c.kind === 'launch').length, 1);
        assert.equal(f.calls().filter(c => c.kind === 'kill').flatMap(c => c.ids).filter(id => id === 100).length, 1);
      });
    }
    check(`${engine}: manual app restart reconciles new creation time`, () => {
      const f = fixture(engine, 'manual');
      f.invoke(); f.advance(40);
      const state = f.load();
      state.processes[0].id = 400; state.processes[0].startedUtc = iso(base + 35000);
      f.update(state);
      const r = f.invoke();
      assert.equal(Date.parse(r.cycle.startedUtc), base + 35000);
      assert.equal(r.decision, 'before-window'); assert.deepEqual(f.calls(), []);
    });
    check(`${engine}: fault triggers cannot bypass early busy protection`, () => {
      const f = fixture(engine, 'fault', { ageHours: 1, activity: 'BUSY', fault: true,
        resource: { queueLength: 21, appCpuHours: 7.05, appAgeHours: 14.7 } });
      f.invoke(); f.advance(31);
      assert.equal(f.invoke().decision, 'wait-activity'); assert.deepEqual(f.calls(), []);
    });
    check(`${engine}: NoAct at B never writes cycle/attempt or touches processes`, () => {
      const f = fixture(engine, 'noact', { ageHours: 24, noAct: true });
      assert.equal(f.invoke().decision, 'deadline-forced');
      assert.deepEqual(f.calls(), []); assert.equal(fs.existsSync(f.statePath), false);
    });
    for (const settings of [
      { preventiveStartHours: -1 }, { preventiveStartHours: 24 }, { preventiveDeadlineHours: 0 },
      { pollSeconds: 0 }, { quietSeconds: 301 }, { retryInitialSeconds: 901 }, { appExe: 'relative.exe' },
      { preventiveStartHours: true }, { unexpectedYHours: 25 },
    ]) {
      check(`${engine}: invalid configuration ${JSON.stringify(settings)} is explicit and inert`, () => {
        const f = fixture(engine, 'invalid', { settings, ageHours: 24 });
        const r = f.invoke(subject, false, true);
        assert.equal(r.state, 'SUPERVISOR-FAILED'); assert.ok(r.error);
        assert.deepEqual(f.calls(), []);
      });
    }
    check(`${engine}: unreadable persisted state cannot silently restart a new cycle`, () => {
      const f = fixture(engine, 'corrupt', { ageHours: 24 });
      fs.writeFileSync(f.statePath, '{corrupt');
      assert.equal(f.invoke(subject, false, true).state, 'SUPERVISOR-FAILED');
      assert.equal(fs.readFileSync(f.statePath, 'utf8'), '{corrupt'); assert.deepEqual(f.calls(), []);
    });
    check(`${engine}: readiness and independently observed schedule recovery are distinct`, () => {
      const f = fixture(engine, 'resumption', { ageHours: 24 });
      assert.equal(f.invoke().automationRecovery.state, 'not-observed');
      f.advance(60);
      const db = new DatabaseSync(f.dbPath);
      db.prepare('INSERT INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)').run('new-run', 'wf', 'manual', 'running', 'schedule', iso(base + 30000), null, null);
      db.close(); f.refreshExpectedDb();
      assert.equal(f.invoke().automationRecovery.state, 'schedule-observed');
    });
    check(`${engine}: fault-only spacing prevents immediate repeat after verified restart`, () => {
      const f = fixture(engine, 'fault-spacing', { ageHours: 1, fault: true });
      f.invoke(); f.advance(30); assert.equal(f.invoke().acted, true);
      f.advance(31);
      assert.equal(f.invoke().decision, 'before-window');
      assert.equal(f.calls().filter(c => c.kind === 'launch').length, 1);
    });
    check(`${engine}: work between idle polls resets the measured quiet interval`, () => {
      const f = fixture(engine, 'intervening-work');
      f.invoke(); f.advance(30);
      fs.appendFileSync(f.manualLog, [
        { type: 'assistant.turn_start', timestamp: iso(base + 10000) },
        { type: 'assistant.turn_end', timestamp: iso(base + 29000) },
      ].map(e => JSON.stringify(e)).join('\n') + '\n');
      assert.equal(f.invoke().decision, 'measuring-quiet');
      assert.deepEqual(f.calls(), []);
      f.advance(29);
      assert.equal(f.invoke().acted, true);
    });
    check(`${engine}: completed work discovered by the final recheck restarts quiet measurement`, () => {
      const f = fixture(engine, 'recheck-idle');
      f.invoke(); f.advance(30); f.update({ recheckIdleActivity: true });
      assert.equal(f.invoke().reason, 'activity-changed-before-action');
      assert.deepEqual(f.calls(), []);
    });
    check(`${engine}: recycled persisted descendant PID does not block recovery or kill its new owner`, () => {
      const f = fixture(engine, 'recycled-retry', { ageHours: 24, crashAfterKill: true });
      f.invoke(subject, true);
      const config = f.load();
      config.processes.find(p => p.id === 102).startedUtc = iso(base + 1000);
      config.processes.find(p => p.id === 102).parentId = 0;
      f.update({ ...config, crashAfterKill: false });
      f.advance(61);
      assert.equal(f.invoke().acted, true);
      assert.ok(!f.calls().filter(c => c.kind === 'kill').flatMap(c => c.ids).includes(102));
      assert.ok(f.load().processes.some(p => p.id === 102));
    });
    check(`${engine}: overlapping invocations serialize and stale lock filenames do not block`, () => {
      const f = fixture(engine, 'lock', { ageHours: 24 });
      const ready = path.join(f.oa, 'holder-ready');
      const stop = path.join(f.oa, 'holder-stop');
      const done = path.join(f.oa, 'holder-done');
      const script = path.join(f.oa, 'holder.ps1');
      fs.writeFileSync(script, `param($Lock,$Ready,$Stop,$Done)
$h=[IO.File]::Open($Lock,'OpenOrCreate','ReadWrite','None')
try { [IO.File]::WriteAllText($Ready,'ready'); $until=[datetime]::UtcNow.AddSeconds(20)
while(-not (Test-Path $Stop) -and [datetime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 50 }
} finally { $h.Dispose(); [IO.File]::WriteAllText($Done,'done') }`);
      const child = spawn(engine, ['-NoProfile', '-File', script, path.join(f.oa, 'supervisor-tick.lock'), ready, stop, done], { stdio: 'ignore' });
      const waitFile = file => {
        const until = Date.now() + 10000;
        while (!fs.existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        assert.ok(fs.existsSync(file), `fixture child ${child.pid} did not signal ${file}`);
      };
      try {
        waitFile(ready);
        assert.equal(f.invoke().state, 'TICK-BUSY'); assert.deepEqual(f.calls(), []);
      } finally { fs.writeFileSync(stop, 'stop'); waitFile(done); }
      assert.equal(f.invoke().reason, 'deadline-forced');
    });
    check(`${engine}: real-entry early-veto and deadline mutations fail independently`, () => {
      const sources = ['oa-supervisor.ps1', 'oa-supervisor-lifecycle.ps1', 'supervisor-defaults.json', 'supervisor-activity.mjs'];
      for (const [label, find, replace, activity, hours] of [
        ['early', "if ($Activity.state -ne 'IDLE')", 'if ($false)', 'BUSY', 13],
        ['deadline', 'if ($age -ge $Config.preventiveDeadlineHours)', 'if ($false)', 'BUSY', 24],
      ]) {
        const dir = fs.mkdtempSync(path.join(root, `mutant-${label}-`));
        for (const file of sources) fs.copyFileSync(path.join(here, file), path.join(dir, file));
        const lib = path.join(dir, 'oa-supervisor-lifecycle.ps1');
        let text = fs.readFileSync(lib, 'utf8');
        assert.ok(text.includes(find));
        text = text.replace(find, replace);
        if (label === 'early') {
          // Remove the immediate recheck too: this mutation independently disables
          // the entire early-activity veto, not the unrelated deadline.
          text = text.replace("$activity.state -ne 'IDLE'", '$false')
            .replace("$activity.state -eq 'IDLE' -and $ready", '$ready')
            .replace("$freshActivity.state -ne 'IDLE' -or ($app -and -not $ready)", '$false');
        }
        fs.writeFileSync(lib, text);
        const f = fixture(engine, `mutant-${label}`, { activity, ageHours: hours });
        const sut = path.join(dir, 'oa-supervisor.ps1');
        f.invoke(sut); f.advance(31);
        const result = f.invoke(sut);
        if (label === 'early') assert.ok(f.calls().some(c => c.kind === 'kill'), 'early-veto mutant must wrongly interrupt busy work');
        else assert.deepEqual(f.calls(), [], `deadline mutant must wrongly miss B: ${JSON.stringify(result)}`);
      }
    });
    if (engine === 'powershell' && !process.env.SUPERVISOR_TEST_SUBJECT) {
      check(`${engine}: pre-fix real entry reproduces collateral kills; new entry preserves early busy work`, () => {
        const source = execFileSync('git', ['show', '9de909778f9457dfa26c5129e93430fb7883d425:plugins/overnight-agent/checks/oa-supervisor.ps1'], { encoding: 'utf8' });
        // Only adapt the fixture-home interface; restart policy and effects are original.
        const old = source.replace('param(', 'param(\n  [string]$OaHome,')
          .replace("$OaHome    = Join-Path $env:LOCALAPPDATA 'overnight-agent'", '');
        const oldFile = path.join(root, 'original-supervisor.ps1');
        fs.writeFileSync(oldFile, old);
        const red = fixture(engine, 'red-original', { activity: 'BUSY', fault: true });
        red.invoke(oldFile);
        assert.deepEqual(red.calls().filter(c => c.kind === 'kill').flatMap(c => c.ids).sort(), [100, 101, 300, 301]);
        const green = fixture(engine, 'green-fixed', { activity: 'BUSY', fault: true });
        green.invoke(); green.advance(31); green.invoke();
        assert.deepEqual(green.calls(), []);
      });
    }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`${passed} real-entry window checks passed`);
