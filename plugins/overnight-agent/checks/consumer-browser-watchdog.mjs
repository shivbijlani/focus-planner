/*
 * consumer-browser-watchdog.mjs -- the tray's browser-check WORKLOAD (GH #698,
 * simplified for GH #738).
 *
 * The optional tray (oa-supervisor-tray.ps1) is the ONE resident dispatcher for
 * browser checks. It runs this file as a child process; this file reads the
 * policy from `## Tray browser checks` in the external user-settings.md (via
 * oa-user-settings.mjs, the one reader) and, only if the user opted in, runs
 * browser-watchdog.ps1 -- a read-only status check. It does not reimplement any
 * browser logic:
 *
 *   browser-watchdog.ps1    thin wrapper: run the checker, report the result
 *   check-browser-slots.ps1 which profiles exist and whether each is in use
 *                            (a `SingletonLock` file check, never a CDP port)
 *   browser-slot-table.ps1  the `## Browser slots` table (source of truth)
 *
 * POLICY, DETERMINISTICALLY (resolveBrowserPlan):
 *   * OFF BY DEFAULT, INCLUDING OBSERVATION. A missing file, a missing section
 *     or `Enabled = off` runs nothing: no probe, no state written.
 *   * `Enabled = on` alone still runs nothing: `Observe` is the one remaining
 *     opt-in, and it is strictly read-only.
 *
 *   GH #738 removed `Thaw stuck slots` and `Auto-launch closed slots`: each
 *   Playwright MCP server now launches its own profile directly and closes
 *   with the session that opened it, so there is no shared slot left for a
 *   tray workload to launch or thaw on anyone's behalf.
 *
 * INDEPENDENT OF THE RELIABILITY WORKLOAD: its own section, its own state file
 * (browser-checks-state.json), its own lock (browser-checks.lock), its own
 * interval. It shares no M/N state, no action lock and no cooldown with
 * reliability-supervisor.mjs, and never imports it.
 *
 * NEVER TOUCHES A BROWSER: the only process this file can stop is the checker
 * script it started itself, on an overall timeout. Browser and MCP worker
 * processes are never launched, killed or reparented.
 */

import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSER_CHECKS_DEFAULTS, loadBrowserChecksPolicy } from './oa-user-settings.mjs';

export const POLICY_RECHECK_MINUTES = 15;
export const RECENT_LIMIT = 10;
export const WATCHDOG_TIMEOUT_MS = 15 * 60 * 1000;

export function browserWorkloadPaths(home = process.env.LOCALAPPDATA &&
  join(process.env.LOCALAPPDATA, 'overnight-agent')) {
  if (!home) throw new Error('LOCALAPPDATA is required for the browser-check workload home');
  return {
    home,
    state: join(home, 'browser-checks-state.json'),
    lock: join(home, 'browser-checks.lock'),
    watchdog: join(home, 'browser-watchdog.ps1'),
  };
}

/**
 * Pure: the declared values -> exactly what may run. `reportOnly` is the tray's
 * host-level -NoAct diagnostic; observation is already read-only, so it has
 * nothing left to remove, but it still never turns a disabled workload on.
 */
export function resolveBrowserPlan(values = {}, { reportOnly = false } = {}) {
  const policy = { ...BROWSER_CHECKS_DEFAULTS, ...values };
  const base = { intervalMinutes: policy.intervalMinutes, observe: false };
  if (!policy.enabled) return { ...base, dispatch: false, mode: 'off', reason: 'disabled', watchdogArgs: [] };
  if (!policy.observe) {
    return { ...base, dispatch: false, mode: 'off', reason: 'no-opt-ins', watchdogArgs: [] };
  }
  // reportOnly is the tray's host-level -NoAct diagnostic. Observation is
  // already read-only (browser-watchdog.ps1 never launches, closes or thaws
  // anything), so it can only be a no-op here -- kept as a parameter so a
  // caller does not need to know that.
  void reportOnly;
  return { ...base, dispatch: true, mode: 'observe', reason: null, observe: true, watchdogArgs: ['-Json', '-Quiet'] };
}

function windowsPowerShell() {
  const root = process.env.SystemRoot;
  return root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

/** Runs browser-watchdog.ps1 as a child; resolves { exitCode, stdout, stderr, timedOut }. */
export function runWatchdogScript({ script, args, timeoutMs = WATCHDOG_TIMEOUT_MS, powershell = windowsPowerShell() }) {
  return new Promise(resolveRun => {
    const child = spawn(powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    // Stops only the watchdog script this file started -- never a browser.
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      resolveRun({ exitCode: -1, stdout, stderr: String(error?.message ?? error), timedOut });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

function parseWatchdogReport(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

export function summarizeOutcome(plan, run, nowMs) {
  const report = run.timedOut ? null : parseWatchdogReport(run.stdout);
  const slots = Array.isArray(report?.slots) ? report.slots : report?.slots ? [report.slots] : [];
  const outcome = {
    at: new Date(nowMs).toISOString(),
    mode: plan.mode,
    exitCode: run.exitCode,
    status: 'failed',
    unhealthy: Number(report?.unhealthy ?? 0),
    slots: slots.map(slot => ({
      slot: slot.slot ?? slot.mcp ?? null, account: slot.account ?? null,
      profileDir: slot.profile_dir ?? null, state: slot.state ?? null,
      healthy: Boolean(slot.healthy), detail: slot.detail ?? null,
    })),
    error: null,
  };
  if (run.timedOut) {
    outcome.error = `browser-watchdog.ps1 exceeded ${Math.round(WATCHDOG_TIMEOUT_MS / 60000)} min`;
  } else if (!report || report.error) {
    outcome.error = String(report?.error ?? run.stderr ?? 'no JSON report').trim().slice(0, 300) ||
      `browser-watchdog.ps1 exited ${run.exitCode} with no JSON report`;
  } else if (run.exitCode === 0) {
    outcome.status = 'healthy';
  } else if (run.exitCode === 2) {
    outcome.status = 'attention';
  } else {
    outcome.error = `browser-watchdog.ps1 exited ${run.exitCode}`;
  }
  const total = outcome.slots.length;
  outcome.summary = outcome.status === 'failed'
    ? `failed: ${outcome.error}`
    : `${outcome.status}: ${total - outcome.unhealthy}/${total} profile(s) reported on`;
  return outcome;
}

async function readState(path) {
  try {
    const parsed = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    return { recent: Array.isArray(parsed?.recent) ? parsed.recent : [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { recent: [] };
    throw error;
  }
}

async function writeState(path, state) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

// This workload's OWN lock, so an on-demand run and a tray run never overlap.
// Deliberately not the reliability action lock.
async function acquireBrowserLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return { release: () => unlink(path).catch(() => {}) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(await readFile(path, 'utf8')); } catch { /* torn/empty */ }
      if (owner && processAlive(Number(owner.pid))) return null;
      await unlink(path).catch(() => {});
    }
  }
  return null;
}

function nextAt(nowMs, minutes) {
  return new Date(nowMs + minutes * 60_000).toISOString();
}

function describePolicy(declared, plan) {
  return {
    valid: true, source: declared.source, settingsPath: declared.settingsPath,
    enabled: declared.values.enabled ?? BROWSER_CHECKS_DEFAULTS.enabled,
    observe: declared.values.observe ?? BROWSER_CHECKS_DEFAULTS.observe,
    intervalMinutes: plan.intervalMinutes,
  };
}

export async function runBrowserWorkload({
  paths = browserWorkloadPaths(), reportOnly = false, clock = { now: () => Date.now() },
  policy: suppliedPolicy, runWatchdog = runWatchdogScript, extraWatchdogArgs = [],
} = {}) {
  const nowMs = clock.now();
  let declared;
  try {
    declared = suppliedPolicy ?? await loadBrowserChecksPolicy();
  } catch (error) {
    return { status: 'policy-error', error: String(error?.message ?? error), dispatched: false,
      nextEvaluationAt: nextAt(nowMs, POLICY_RECHECK_MINUTES) };
  }
  const plan = resolveBrowserPlan(declared.values, { reportOnly });
  const policy = describePolicy(declared, plan);
  if (!plan.dispatch) {
    // Completely off: no probe, no lock, no state write.
    let recent = [];
    try { recent = (await readState(paths.state)).recent.slice(-5).reverse(); } catch { /* status only */ }
    return { status: plan.reason, dispatched: false, plan, policy, recent,
      nextEvaluationAt: nextAt(nowMs, POLICY_RECHECK_MINUTES) };
  }
  const lock = await acquireBrowserLock(paths.lock);
  if (!lock) {
    return { status: 'busy', dispatched: false, plan, policy, recent: [],
      nextEvaluationAt: nextAt(nowMs, POLICY_RECHECK_MINUTES) };
  }
  try {
    const args = [...plan.watchdogArgs, '-SettingsPath', declared.settingsPath, ...extraWatchdogArgs];
    const run = await runWatchdog({ script: paths.watchdog, args });
    const outcome = summarizeOutcome(plan, run, clock.now());
    const state = await readState(paths.state).catch(() => ({ recent: [] }));
    state.recent = [...state.recent, outcome].slice(-RECENT_LIMIT);
    await writeState(paths.state, state);
    return { status: outcome.status, dispatched: true, plan, policy, outcome,
      recent: state.recent.slice(-5).reverse(), error: outcome.error,
      nextEvaluationAt: nextAt(clock.now(), plan.intervalMinutes) };
  } finally {
    await lock.release();
  }
}

/** Read-only view for the tray: never probes a browser and never writes. */
export async function readBrowserStatus({
  paths = browserWorkloadPaths(), policy: suppliedPolicy, reportOnly = false,
} = {}) {
  let policy;
  let plan = null;
  try {
    const declared = suppliedPolicy ?? await loadBrowserChecksPolicy();
    plan = resolveBrowserPlan(declared.values, { reportOnly });
    policy = describePolicy(declared, plan);
  } catch (error) {
    policy = { valid: false, enabled: false, error: String(error?.message ?? error) };
  }
  let recent = [];
  let stateError = null;
  try { recent = (await readState(paths.state)).recent.slice(-5).reverse(); } catch (error) {
    stateError = String(error?.message ?? error);
  }
  return { status: 'status', policy, plan, recent, errors: [stateError].filter(Boolean) };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--status') {
    console.log(JSON.stringify(await readBrowserStatus()));
    return;
  }
  if (argv.some(arg => arg !== '--report-only')) {
    throw new Error('Usage: node consumer-browser-watchdog.mjs [--status | --report-only]');
  }
  const result = await runBrowserWorkload({ reportOnly: argv.includes('--report-only') });
  console.log(JSON.stringify(result));
  if (result.status === 'failed' || result.status === 'policy-error') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Browser-check workload failed: ${error.stack ?? error}`);
    process.exitCode = 2;
  });
}
