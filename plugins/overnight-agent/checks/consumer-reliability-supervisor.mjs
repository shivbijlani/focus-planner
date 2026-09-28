import { appendFile, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  acquireExclusiveLock, assessActivity, atomicJsonWrite, commandAdapters, cooldownStatus,
  createSupervisor, determineReason, loadConfig, loadState, restartCycleStatus, validateConfig,
} from './reliability-supervisor.mjs';
import { listCopilotProcesses } from './windows-app-actuator.mjs';

function guiIdentity(rows) {
  const candidates = rows.filter(row =>
    /^(github|githubcopilot|github copilot)\.exe$/i.test(row.name ?? '') &&
    /[\\/]GitHub Copilot[\\/]/i.test(row.path ?? ''));
  if (!candidates.length) return { running: false, evidence: 'known' };
  if (candidates.length !== 1 || !candidates[0].mainWindowHandle ||
      !candidates[0].startTime || !candidates[0].path) {
    return { running: false, evidence: 'unknown' };
  }
  const { pid, path, startTime } = candidates[0];
  return { running: true, evidence: 'known', startedAt: startTime,
    identity: { pid, path, startTime } };
}

function launchDesktop(executable) {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveLaunch(); });
  });
}

export function supervisorPaths(home = process.env.LOCALAPPDATA &&
  join(process.env.LOCALAPPDATA, 'overnight-agent')) {
  if (!home) throw new Error('LOCALAPPDATA is required for durable supervisor state');
  return {
    home,
    config: join(home, 'reliability-supervisor.json'),
    state: join(home, 'reliability-supervisor-state.json'),
    lock: join(home, 'reliability-supervisor-action.lock'),
    audit: join(home, 'reliability-supervisor-audit.jsonl'),
    snapshot: join(home, 'reliability-supervisor-snapshot.json'),
  };
}

export function requireSqliteRuntime(version = process.versions.node) {
  if (Number(version.split('.')[0]) < 24) {
    throw new Error('Reliability supervision requires Node.js 24+ with node:sqlite');
  }
}

export function nextEvaluationDelay(config, lastCycle, nowMs = Date.now()) {
  let delay = config.supervisor.checkIntervalSeconds * 1_000;
  const evaluatedAt = Date.parse(lastCycle.checkedAt);
  for (const time of [lastCycle.actuator?.cycle?.opportunityAt,
    lastCycle.actuator?.cycle?.hardDeadlineAt]) {
    const boundary = Date.parse(time);
    if (!Number.isFinite(boundary)) continue;
    if (boundary > nowMs) delay = Math.min(delay, boundary - nowMs);
    else if (evaluatedAt < boundary) delay = 0;
  }
  if (lastCycle.actuator?.status === 'cooldown') {
    delay = Math.min(delay, Math.max(0, lastCycle.actuator.cooldown.remainingMs));
  }
  return delay;
}

export async function reconcileConsumerConfig(paths) {
  const config = await loadConfig(paths.config);
  const snapshotPath = config.supervisor.inputPath ?? paths.snapshot;
  const helper = join(resolve(fileURLToPath(new URL('.', import.meta.url))), 'windows-app-actuator.mjs');
  const db = join(homedir(), '.copilot', 'data.db');
  const store = join(homedir(), '.copilot', 'session-store.db');
  const sessions = join(homedir(), '.copilot', 'session-state');
  const command = (subcommand, args) => ({ file: process.execPath, args: [helper, subcommand, ...args] });
  const dbArgs = ['--snapshot', snapshotPath, '--db', db, '--session-store', store,
    '--session-state', sessions];
  const old = ['--old-pid', '{oldPid}', '--old-start-time', '{oldStartTime}',
    '--old-path', '{oldPath}'];
  const desired = {
    snapshot: command('snapshot', dbArgs),
    requestShutdown: command('shutdown', [
      '--snapshot', snapshotPath, '--attempt', '{attemptId}', '--deadline', '{deadlineSeconds}', ...old]),
    forceTerminate: command('force', [
      ...old, '--authorization', '{authorization}', '--restart-mode', '{restartMode}',
      '--deadline', '{deadlineSeconds}']),
    launch: command('launch', ['--path', '{oldPath}', ...old]),
    readiness: command('readiness', [...dbArgs, '--deadline', '{deadlineSeconds}',
      ...old, '--not-before', '{notBefore}']),
    verifyScheduler: command('scheduler', [
      ...dbArgs, '--deadline', '{deadlineSeconds}',
      '--before', '{beforeSequence}', '--before-due-workflows', '{beforeDueWorkflows}',
      '--work-was-due', '{workWasDue}', '--not-before', '{notBefore}',
      '--new-pid', '{newPid}', '--new-start-time', '{newStartTime}', '--new-path', '{newPath}']),
  };
  const commands = Object.fromEntries(Object.entries(desired).map(([name, value]) => [
    name, !config.commands[name] ||
      config.commands[name].args?.some(arg => /windows-app-actuator\.mjs$/i.test(arg))
      ? value : config.commands[name],
  ]));
  const updated = validateConfig({
    ...config,
    supervisor: { ...config.supervisor, inputPath: snapshotPath },
    commands,
  });
  if (JSON.stringify(updated) !== JSON.stringify(config)) {
    await atomicJsonWrite(paths.config, updated, { expectedRaw: await readFile(paths.config, 'utf8') });
  }
  return updated;
}

export async function runConsumerSupervisor({
  paths = supervisorPaths(), noAct = false, recoveryReason = null, launchMissing = false,
  clock = { now: () => Date.now() }, adapters: suppliedAdapters,
  processes = listCopilotProcesses, launch = launchDesktop,
  appExecutable = process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, 'Programs', 'GitHub Copilot', 'github.exe'),
} = {}) {
  if (!suppliedAdapters) requireSqliteRuntime();
  const config = suppliedAdapters ? await loadConfig(paths.config) : await reconcileConsumerConfig(paths);
  if (!config.supervisor.enabled) return { status: 'disabled' };
  if (launchMissing && !noAct) {
    let lock;
    try {
      lock = await acquireExclusiveLock(paths.lock);
    } catch (error) {
      if (error.code === 'LOCKED') return { status: 'locked' };
      throw error;
    }
    try {
      const state = await loadState(paths.state);
      const cooldown = cooldownStatus(state, config, clock.now());
      if (!cooldown.allowed) return { status: 'cooldown', cooldown };
      const before = guiIdentity(await processes());
      if (before.evidence !== 'known' || before.running) {
        return { status: 'postponed', blockedBy: 'app-identity-not-absent' };
      }
      if (!appExecutable) throw new Error('LOCALAPPDATA is required to locate the installed app');
      await stat(appExecutable);
      const attempt = { id: randomUUID(), reason: 'consumer-schedule-dead-launch',
        attemptedAt: new Date(clock.now()).toISOString(), restartIntentAt: new Date(clock.now()).toISOString(),
        restartIntentPersisted: true, outcome: 'in-progress', oldIdentity: null };
      state.attempts.push(attempt);
      state.attempts = state.attempts.slice(-config.evidence.maxAttempts);
      state.activeAttempt = attempt.id;
      await lock.assertOwned();
      await atomicJsonWrite(paths.state, state);
      try {
        await lock.assertOwned();
        await launch(appExecutable);
        const deadline = clock.now() + config.startup.readinessDeadlineSeconds * 1000;
        let current;
        do {
          current = guiIdentity(await processes());
          if (current.running && current.evidence === 'known') break;
          if (current.evidence !== 'known') throw new Error('Launched GUI identity is ambiguous');
          await (clock.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
        } while (clock.now() < deadline);
        if (!current.running) throw new Error('App launch readiness deadline expired');
        attempt.newIdentity = current.identity;
        state.restartCycleStartedAt = current.startedAt;
        attempt.outcome = 'succeeded';
      } catch (error) {
        attempt.outcome = 'failed';
        attempt.error = String(error?.message ?? error);
      }
      attempt.completedAt = new Date(clock.now()).toISOString();
      state.activeAttempt = null;
      await lock.assertOwned();
      await atomicJsonWrite(paths.state, state);
      await appendFile(paths.audit, `${JSON.stringify(attempt)}\n`);
      return { status: attempt.outcome === 'succeeded' ? 'launched' : 'failed', attempt,
        error: attempt.error ?? null };
    } finally {
      await lock.release();
    }
  }
  const adapters = suppliedAdapters ?? commandAdapters(config, config.supervisor.inputPath);
  const input = recoveryReason
    ? { recoveryRequest: { id: `${recoveryReason}:${new Date(clock.now()).toISOString()}`,
      reasons: ['consumer-urgent-recovery', recoveryReason] } }
    : {};
  if (noAct) {
    const state = await loadState(paths.state);
    const snapshot = await adapters.inspect(input);
    return {
      status: 'detect-only',
      reason: determineReason({ ...input, ...snapshot }, config, state, clock.now()),
      activity: assessActivity(snapshot.activity, config, clock.now()),
      evidenceError: snapshot.snapshotError ?? null,
      cooldown: cooldownStatus(state, config, clock.now()),
      cycle: restartCycleStatus(state, config),
    };
  }
  const checkedAt = new Date(clock.now()).toISOString();
  const result = await createSupervisor({
    config, statePath: paths.state, lockPath: paths.lock, auditPath: paths.audit,
    adapters, clock: { now: clock.now, sleep: clock.sleep ?? (ms =>
      new Promise(resolve => setTimeout(resolve, ms))) },
  }).run(input);
  const cycle = result.cycle ?? restartCycleStatus(await loadState(paths.state), config);
  const lastCycle = { checkedAt, actuator: { ...result, cycle } };
  const hardDeadlineAt = cycle?.hardDeadlineAt;
  const overdue = Number.isFinite(Date.parse(hardDeadlineAt)) &&
    Date.parse(hardDeadlineAt) <= clock.now() ? {
      hardDeadlineAt, blockedBy: result.blockedBy ?? result.status,
    } : null;
  return { ...result, cycle, overdue,
    nextEvaluationAt: new Date(clock.now() + nextEvaluationDelay(config, lastCycle, clock.now())).toISOString() };
}

function summarizeAttempt(entry) {
  return {
    id: entry.id ?? null,
    at: entry.completedAt ?? entry.attemptedAt ?? null,
    reason: entry.reason ?? null,
    restartMode: entry.restartMode ?? null,
    outcome: entry.outcome ?? 'unknown',
    error: entry.error ? String(entry.error).slice(0, 200) : null,
  };
}

// Read-only view for the tray: never creates the policy file and never needs node:sqlite,
// so status stays visible even when the evidence runtime or the policy is broken.
export async function readSupervisorStatus({
  paths = supervisorPaths(), clock = { now: () => Date.now() }, recentLimit = 5,
} = {}) {
  const nowMs = clock.now();
  let config = null;
  let policy;
  try {
    config = await loadConfig(paths.config, { create: false });
    policy = {
      valid: true,
      enabled: config.supervisor.enabled,
      quietOpportunityHours: config.preventiveRestart.targetIntervalHours,
      hardDeadlineHours: config.preventiveRestart.hardIntervalHours,
      quietWindowMinutes: config.preventiveRestart.quietWindowMinutes,
      cooldownMinutes: config.appRestart.minIntervalMinutes,
    };
  } catch (error) {
    policy = { valid: false, enabled: false, error: String(error?.message ?? error) };
  }
  let state = null;
  let stateError = null;
  try { state = await loadState(paths.state); } catch (error) { stateError = String(error?.message ?? error); }
  let recent = [];
  let auditError = null;
  try {
    const lines = (await readFile(paths.audit, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-Math.max(recentLimit * 4, recentLimit)).reverse()) {
      try { recent.push(summarizeAttempt(JSON.parse(line))); } catch { /* skip torn line */ }
      if (recent.length >= recentLimit) break;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') auditError = String(error?.message ?? error);
  }
  const cooldown = config && state ? cooldownStatus(state, config, nowMs) : null;
  return {
    status: 'status',
    checkedAt: new Date(nowMs).toISOString(),
    policy,
    cycle: config && state ? restartCycleStatus(state, config) : null,
    cooldown: cooldown ? {
      active: !cooldown.allowed,
      until: cooldown.allowed ? null : new Date(nowMs + cooldown.remainingMs).toISOString(),
    } : null,
    activeAttempt: state?.activeAttempt ?? null,
    recent,
    errors: [stateError, auditError].filter(Boolean),
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--status') {
    console.log(JSON.stringify(await readSupervisorStatus()));
    return;
  }
  if (argv.some(arg => !['--no-act', '--recovery', '--launch-missing'].includes(arg) &&
      argv[argv.indexOf(arg) - 1] !== '--recovery') ||
      argv.filter(arg => arg === '--recovery').length > 1 ||
      (argv.includes('--recovery') && !argv[argv.indexOf('--recovery') + 1]) ||
      (argv.includes('--recovery') && argv.includes('--launch-missing'))) {
    throw new Error('Usage: node consumer-reliability-supervisor.mjs [--status | [--no-act] [--recovery reason | --launch-missing]]');
  }
  const recoveryReason = argv.includes('--recovery') ? argv[argv.indexOf('--recovery') + 1] : null;
  const result = await runConsumerSupervisor({ noAct: argv.includes('--no-act'), recoveryReason,
    launchMissing: argv.includes('--launch-missing') });
  console.log(JSON.stringify(result));
  if (result.status === 'failed') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Reliability supervisor failed: ${error.stack ?? error}`);
    process.exitCode = 2;
  });
}
