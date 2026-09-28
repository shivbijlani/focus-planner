import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireExclusiveLock, assessActivity, DEFAULT_CONFIG, determineReason,
} from './reliability-supervisor.mjs';
import { sameIdentity, descendantProcessIds, revalidateIdentity } from './windows-app-actuator.mjs';
import {
  nextEvaluationDelay, reconcileConsumerConfig, requireSqliteRuntime,
  runConsumerSupervisor, supervisorPaths,
} from './consumer-reliability-supervisor.mjs';

const hour = 3_600_000;
const now = Date.parse('2026-09-26T12:00:00.000Z');
const old = { pid: 321, path: 'C:\\Programs\\GitHub Copilot\\github.exe',
  startTime: new Date(now - 4 * hour).toISOString() };
const app = { running: true, evidence: 'known', startedAt: old.startTime, identity: old };

test('M needs continuous verified quiet; N overrides unknown or active evidence', () => {
  const state = { restartCycleStartedAt: old.startTime };
  const atM = Date.parse(old.startTime) + 3 * hour;
  assert.equal(determineReason({ app }, DEFAULT_CONFIG, state, atM - 1).due, false);
  const reason = determineReason({ app }, DEFAULT_CONFIG, state, atM);
  assert.equal(reason.restartMode, 'quiet-opportunity');
  const incomplete = assessActivity({ complete: false, sessions: [] }, DEFAULT_CONFIG, atM);
  assert.equal(incomplete.verdict, 'unknown');
  const early = assessActivity({ complete: true, sessions: [], quietObservedSince:
    new Date(atM - 14 * 60_000).toISOString() }, DEFAULT_CONFIG, atM);
  assert.notEqual(early.verdict, 'idle');
  const quiet = assessActivity({ complete: true, sessions: [], quietObservedSince:
    new Date(atM - 15 * 60_000).toISOString() }, DEFAULT_CONFIG, atM);
  assert.equal(quiet.verdict, 'idle');
  const hard = determineReason({ app }, DEFAULT_CONFIG, state, now);
  assert.equal(hard.restartMode, 'hard-deadline');
  assert.equal(hard.trigger, 'hard-deadline');
  assert.equal(determineReason({ app: { running: false } }, DEFAULT_CONFIG, state, now).due, false);
});

test('identity and tree checks refuse reused PIDs, different paths and unrelated processes', () => {
  const root = { ...old, name: 'github.exe', mainWindowHandle: 7, parentPid: 1 };
  const child = { pid: 322, path: 'C:\\Programs\\GitHub Copilot\\copilot.exe',
    startTime: new Date(now - 2 * hour).toISOString(), parentPid: 321 };
  const foreign = { ...child, pid: 323, parentPid: 999 };
  assert.equal(sameIdentity(old, { ...old, path: 'C:\\Other\\github.exe' }), false);
  assert.deepEqual(descendantProcessIds([root, child, foreign], root.pid), [322]);
  assert.equal(typeof revalidateIdentity, 'function');
});

test('runtime rejects Node versions without the enterprise SQLite evidence reader', () => {
  assert.throws(() => requireSqliteRuntime('21.7.1'), /Node.js 24/);
  assert.doesNotThrow(() => requireSqliteRuntime('24.21.0'));
});

test('next evaluation wakes at M/N and cooldown rather than waiting for periodic tick', () => {
  const config = DEFAULT_CONFIG;
  const base = { checkedAt: new Date(now).toISOString(), actuator: {
    cycle: { opportunityAt: new Date(now + 12_000).toISOString(),
      hardDeadlineAt: new Date(now + 25_000).toISOString() },
  } };
  assert.equal(nextEvaluationDelay(config, base, now), 12_000);
  assert.equal(nextEvaluationDelay(config, { ...base, actuator: {
    ...base.actuator, status: 'cooldown', cooldown: { remainingMs: 8_000 },
  } }, now), 8_000);
  assert.equal(nextEvaluationDelay(config, base, now + 13_000), 0);
});

test('consumer wiring installs enterprise snapshot and scheduler verification commands', async t => {
  const home = await mkdtemp(join(tmpdir(), 'oa-actuator-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = supervisorPaths(home);
  const config = await reconcileConsumerConfig(paths);
  assert.equal(config.supervisor.inputPath, paths.snapshot);
  assert.equal(config.commands.snapshot.args[0], join(import.meta.dirname, 'windows-app-actuator.mjs'));
  assert.ok(config.commands.snapshot.args.includes('--session-store'));
  assert.ok(config.commands.snapshot.args.includes('--session-state'));
  assert.ok(config.commands.verifyScheduler.args.includes('--before-due-workflows'));
  assert.ok(config.commands.forceTerminate.args.includes('--restart-mode'));
  assert.deepEqual(await reconcileConsumerConfig(paths), config);
});

test('OS-owned daemon wakes at supervisor M/N boundary before its periodic interval', async t => {
  if (process.platform !== 'win32') return t.skip('Windows daemon');
  const root = await mkdtemp(join(tmpdir(), 'oa-daemon-boundary-'));
  const home = join(root, 'overnight-agent');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home);
  await writeFile(join(home, 'oa-supervisor.ps1'), `
$countPath = Join-Path $PSScriptRoot 'count.txt'
$count = if (Test-Path $countPath) { [int](Get-Content $countPath -Raw) } else { 0 }
($count + 1) | Set-Content $countPath
@{ state = 'HEALTHY'; actResult = @{ nextEvaluationAt =
  (Get-Date).ToUniversalTime().AddMilliseconds(700).ToString('o') } } | ConvertTo-Json -Compress -Depth 4
`);
  const daemon = spawn('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File',
    join(import.meta.dirname, 'oa-supervisor-daemon.ps1'), '-IntervalMinutes', '15'], {
    env: { ...process.env, LOCALAPPDATA: root }, stdio: 'ignore', windowsHide: true,
  });
  t.after(async () => {
    if (daemon.exitCode === null) {
      daemon.kill();
      await new Promise(resolveDone => daemon.once('exit', resolveDone));
    }
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 20_000;
  let count = 0;
  while (Date.now() < deadline) {
    try { count = Number(await readFile(join(home, 'count.txt'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (count >= 2) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.ok(count >= 2, 'the daemon did not wake at the 700ms boundary');
});

test('one action lock excludes another owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'oa-reliability-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'action.lock');
  const first = await acquireExclusiveLock(path);
  try {
    await assert.rejects(acquireExclusiveLock(path), error => error.code === 'LOCKED');
    await first.assertOwned();
  } finally {
    await first.release();
  }
  const second = await acquireExclusiveLock(path);
  await second.release();
});

test('hard deadline persists intent and cooldown before force; failed attempt keeps old cycle', async t => {
  const home = await mkdtemp(join(tmpdir(), 'oa-reliability-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const files = supervisorPaths(home);
  const snapshot = { app, activity: { complete: false, sessions: [] },
    scheduler: { evidence: 'unknown', workDue: false } };
  const seen = [];
  const adapters = {
    inspect: async () => snapshot,
    requestShutdown: async () => { throw new Error('N must not request graceful shutdown'); },
    awaitShutdown: async () => { throw new Error('N must not await graceful shutdown'); },
    forceShutdown: async options => {
      await options.assertActionOwned();
      await options.beforeTerminate({ activity: { verdict: 'active' } });
      const state = JSON.parse(await readFile(files.state, 'utf8'));
      assert.equal(state.restartCycleStartedAt, old.startTime);
      assert.equal(state.attempts[0].restartIntentPersisted, true);
      seen.push('forced');
      throw new Error('synthetic termination failure');
    },
    launch: async () => { throw new Error('failed shutdown must not relaunch'); },
    awaitReady: async () => {},
    verifyScheduler: async () => {},
  };
  const clock = { now: () => now, sleep: async () => {} };
  const first = await runConsumerSupervisor({ paths: files, adapters, clock });
  assert.equal(first.status, 'failed');
  assert.deepEqual(seen, ['forced']);
  const state = JSON.parse(await readFile(files.state, 'utf8'));
  assert.equal(state.restartCycleStartedAt, old.startTime);
  assert.equal(JSON.parse((await readFile(files.audit, 'utf8')).trim()).outcome, 'failed');
  const second = await runConsumerSupervisor({ paths: files, adapters, clock });
  assert.equal(second.status, 'cooldown');
  assert.deepEqual(seen, ['forced']);
});

test('quiet opportunity postpones on unknown activity without recording a restart intent', async t => {
  const home = await mkdtemp(join(tmpdir(), 'oa-opportunity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const opportunity = Date.parse(old.startTime) + 3 * hour + 60_000;
  const snapshot = { app, activity: { complete: false, sessions: [] },
    scheduler: { evidence: 'unknown' } };
  const never = async () => { throw new Error('unknown activity cannot terminate the app at M'); };
  const result = await runConsumerSupervisor({
    paths: supervisorPaths(home), clock: { now: () => opportunity, sleep: async () => {} },
    adapters: {
      inspect: async () => snapshot, requestShutdown: never, awaitShutdown: never,
      forceShutdown: never, launch: never, awaitReady: never, verifyScheduler: never,
    },
  });
  assert.equal(result.status, 'postponed');
  assert.equal(result.attempt.restartIntentPersisted, false);
});

test('successful guarded replacement moves the cycle anchor to the new GUI identity', async t => {
  const home = await mkdtemp(join(tmpdir(), 'oa-replacement-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const files = supervisorPaths(home);
  const replacement = { ...old, pid: 987, startTime: new Date(now + 1000).toISOString() };
  const snapshot = { app, activity: { complete: false, sessions: [] },
    scheduler: { evidence: 'unknown', workDue: false } };
  const adapters = {
    inspect: async () => snapshot,
    requestShutdown: async () => { throw new Error('hard deadline cannot use graceful path'); },
    awaitShutdown: async () => {},
    forceShutdown: async options => {
      await options.beforeTerminate({ activity: { verdict: 'active' } });
      return { ok: true, method: 'verified-process-tree-force' };
    },
    launch: async () => ({ ok: true }),
    awaitReady: async () => ({ ok: true, identity: replacement }),
    verifyScheduler: async () => ({ ok: true, scheduler: 'not-verified' }),
  };
  const result = await runConsumerSupervisor({
    paths: files, adapters, clock: { now: () => now, sleep: async () => {} },
  });
  assert.equal(result.status, 'restarted');
  assert.equal(result.attempt.activityOverridden, true);
  const state = JSON.parse(await readFile(files.state, 'utf8'));
  assert.equal(state.restartCycleStartedAt, replacement.startTime);
});

test('schedule-dead launch shares action lock, audit and cooldown without terminating anything', async t => {
  const home = await mkdtemp(join(tmpdir(), 'oa-launch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const files = supervisorPaths(home);
  const executable = join(home, 'github.exe');
  await writeFile(executable, '');
  let launched = false;
  const processes = () => launched ? [{
    ...old, name: 'github.exe', startTime: new Date(now).toISOString(),
    mainWindowHandle: 12,
  }] : [];
  const options = {
    paths: files, launchMissing: true, appExecutable: executable, processes,
    launch: async () => { launched = true; },
    clock: { now: () => now, sleep: async () => {} },
  };
  const first = await runConsumerSupervisor(options);
  assert.equal(first.status, 'launched');
  assert.equal(first.attempt.restartIntentPersisted, true);
  const second = await runConsumerSupervisor(options);
  assert.equal(second.status, 'cooldown');
  assert.equal((await readFile(files.audit, 'utf8')).trim().split('\n').length, 1);
});
