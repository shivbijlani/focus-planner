/*
 * consumer-update-check.mjs -- the tray's plugin UPDATE-CHECK workload (GH #701).
 *
 * The optional tray (oa-supervisor-tray.ps1) runs this file as a child process.
 * It reads its policy from `## Tray update checks` in the external
 * user-settings.md (via oa-user-settings.mjs, the one reader) and asks the
 * Copilot plugin marketplace whether a newer overnight-agent is available.
 *
 * POLICY (UPDATE_CHECKS_DEFAULTS): Enabled on, Check interval daily (hourly is
 * selectable), Auto apply OFF, Source marketplace. With Auto apply off the
 * workload only REPORTS "update available"; nothing on disk is replaced.
 *
 * THE ONLY SOURCE IS THE COPILOT PLUGIN MARKETPLACE, driven through the Copilot
 * CLI and nothing else:
 *
 *   copilot plugin marketplace list --json            is focus-planner registered?
 *   copilot plugin list --json                        is overnight-agent installed, which version?
 *   copilot plugin marketplace update focus-planner   refresh that catalog (best effort)
 *   %LOCALAPPDATA%\copilot\marketplaces\...\marketplace.json catalog version
 *   copilot plugin marketplace browse focus-planner --json   catalog membership
 *   copilot plugin install overnight-agent@focus-planner     apply (Auto apply only)
 *   copilot plugin list --json                        re-verify the installed version
 *
 * It never runs git, never fetches the repository's main branch, and never calls
 * the maintainer-only deploy adapters (auto-deploy-plugin.ps1,
 * deploy-installed-plugin.ps1, sync-oa-home.ps1).
 *
 * IDEMPOTENT: a run inside the interval is a no-op ('not-due') that touches no
 * CLI and writes nothing, so tray restarts never cause extra checks. Apply only
 * happens when the catalog version is strictly newer than the installed one, and
 * the installed version is read again afterwards to confirm it moved.
 *
 * INDEPENDENT OF THE OTHER WORKLOADS: its own section, its own state file
 * (update-check-state.json), its own lock (update-check.lock), its own interval.
 * It imports neither the reliability nor the browser workload and shares no
 * cooldown with them.
 *
 * STALE FALLBACK: `--stale-note` reads only policy + state (no CLI, no writes) and
 * prints a note when the last completed check is older than the interval, so a
 * caller outside the tray can mention it without blocking.
 */

import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UPDATE_CHECKS_DEFAULTS, loadUpdateChecksPolicy } from './oa-user-settings.mjs';

export const MARKETPLACE_NAME = 'focus-planner';
export const PLUGIN_NAME = 'overnight-agent';
export const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const POLICY_RECHECK_MINUTES = 15;
export const FAILURE_RETRY_MINUTES = 60;
export const RECENT_LIMIT = 10;
export const CLI_TIMEOUT_MS = 2 * 60 * 1000;
export const APPLY_TIMEOUT_MS = 10 * 60 * 1000;

// Every CLI invocation this workload can make, stated once. Nothing outside this
// table is ever spawned.
export const CLI_COMMANDS = Object.freeze({
  marketplaceList: ['plugin', 'marketplace', 'list', '--json'],
  pluginList: ['plugin', 'list', '--json'],
  marketplaceRefresh: ['plugin', 'marketplace', 'update', MARKETPLACE_NAME],
  marketplaceBrowse: ['plugin', 'marketplace', 'browse', MARKETPLACE_NAME, '--json'],
  install: ['plugin', 'install', PLUGIN_SPEC],
});

// Results that mean "the check itself completed", so the interval restarts.
const COMPLETED = new Set([
  'up-to-date', 'update-available', 'applied', 'capability-gap',
  'marketplace-missing', 'not-installed', 'not-marketplace-install',
]);

export function updateWorkloadPaths(home = process.env.LOCALAPPDATA &&
  join(process.env.LOCALAPPDATA, 'overnight-agent')) {
  if (!home) throw new Error('LOCALAPPDATA is required for the update-check workload home');
  return {
    home,
    state: join(home, 'update-check-state.json'),
    lock: join(home, 'update-check.lock'),
  };
}

/** Pure: declared values -> the effective policy. `reportOnly` can only remove apply. */
export function resolveUpdatePlan(values = {}, { reportOnly = false } = {}) {
  const policy = { ...UPDATE_CHECKS_DEFAULTS, ...values };
  return {
    enabled: policy.enabled === true,
    intervalMinutes: policy.intervalMinutes,
    source: policy.source,
    autoApply: policy.autoApply === true && !reportOnly,
  };
}

/** Numeric dotted compare; a pre-release tag sorts below its release. */
export function compareVersions(a, b) {
  const parse = value => {
    const [core, pre = ''] = String(value ?? '').trim().replace(/^v/i, '').split('-', 2);
    return { parts: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

const isVersion = value => typeof value === 'string' && /^v?\d+(\.\d+)*(-[\w.]+)?$/.test(value.trim());

/** Stale = enabled and the last COMPLETED check is older than the interval. Pure. */
export function isCheckDue(state, plan, nowMs) {
  const last = Date.parse(state?.lastCheckedAt ?? '');
  if (Number.isFinite(last) && nowMs < last + plan.intervalMinutes * 60_000) return false;
  const attempt = Date.parse(state?.lastAttemptAt ?? '');
  if (Number.isFinite(attempt) && nowMs < attempt + Math.min(FAILURE_RETRY_MINUTES, plan.intervalMinutes) * 60_000) {
    return false;
  }
  return true;
}

function nextDueAt(state, plan, nowMs) {
  const candidates = [];
  const last = Date.parse(state?.lastCheckedAt ?? '');
  if (Number.isFinite(last)) candidates.push(last + plan.intervalMinutes * 60_000);
  const attempt = Date.parse(state?.lastAttemptAt ?? '');
  if (Number.isFinite(attempt) && !(Number.isFinite(last) && last >= attempt)) {
    candidates.push(attempt + Math.min(FAILURE_RETRY_MINUTES, plan.intervalMinutes) * 60_000);
  }
  return new Date(candidates.length ? Math.max(nowMs, Math.min(...candidates)) : nowMs).toISOString();
}

function copilotCommand(env = process.env) {
  const override = env.OA_COPILOT_CLI;
  if (override && /\.(mjs|cjs|js)$/i.test(override)) return { file: process.execPath, prefix: [override] };
  return { file: override || 'copilot', prefix: [] };
}

/** Runs the Copilot CLI with one of CLI_COMMANDS; resolves { exitCode, stdout, stderr, timedOut }. */
export function runCopilotCli(args, { timeoutMs = CLI_TIMEOUT_MS, env = process.env } = {}) {
  const { file, prefix } = copilotCommand(env);
  return new Promise(resolveRun => {
    let child;
    try {
      // A shell is needed only to resolve an npm `copilot.cmd` shim on Windows;
      // every argument comes from CLI_COMMANDS, never from user input.
      child = spawn(file, [...prefix, ...args], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32' && !prefix.length,
      });
    } catch (error) {
      resolveRun({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
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

function parseJsonArray(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start));
    if (Array.isArray(parsed)) return parsed;
    for (const key of ['plugins', 'marketplaces', 'items']) {
      if (Array.isArray(parsed?.[key])) return parsed[key];
    }
    return null;
  } catch { return null; }
}

function cliFailure(run, what) {
  const detail = run.timedOut ? 'timed out' : String(run.stderr || run.stdout || `exit ${run.exitCode}`).trim();
  return `${what} failed: ${detail.slice(0, 300)}`;
}

export function marketplaceManifestPath(marketplace, env = process.env) {
  const source = String(marketplace?.source ?? '').trim();
  const match = /^GitHub:\s*([^/\\\s]+)\/([^/\\\s]+?)(?:\.git)?$/i.exec(source);
  if (!match || !env.LOCALAPPDATA) return null;
  const cacheName = `${match[1]}-${match[2]}`.toLowerCase();
  return join(env.LOCALAPPDATA, 'copilot', 'marketplaces', cacheName, '.github', 'plugin', 'marketplace.json');
}

async function readCachedCatalogVersion(marketplace, { env, readText }) {
  const manifestPath = marketplaceManifestPath(marketplace, env);
  if (!manifestPath) {
    return { error: `the Copilot CLI does not expose a readable cache location for marketplace source ` +
      `'${marketplace?.source || 'unknown'}'` };
  }
  let manifest;
  try {
    manifest = JSON.parse((await readText(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    return { error: `the refreshed marketplace cache could not be read at '${manifestPath}': ` +
      String(error?.message ?? error) };
  }
  const listed = Array.isArray(manifest?.plugins) &&
    manifest.plugins.find(item => item?.name === PLUGIN_NAME);
  if (!listed) return { error: `${PLUGIN_NAME} is absent from the refreshed marketplace manifest at '${manifestPath}'` };
  if (!isVersion(listed.version)) {
    return { error: `${PLUGIN_NAME} has no comparable version in the refreshed marketplace manifest at '${manifestPath}'` };
  }
  return { version: listed.version.trim(), manifestPath };
}

async function readInstalled(runCli) {
  const run = await runCli(CLI_COMMANDS.pluginList, { timeoutMs: CLI_TIMEOUT_MS });
  const list = run.exitCode === 0 ? parseJsonArray(run.stdout) : null;
  if (!list) return { error: cliFailure(run, '`copilot plugin list --json`') };
  const entry = list.find(item => item?.name === PLUGIN_NAME && item?.marketplace === MARKETPLACE_NAME) ??
    list.find(item => item?.name === PLUGIN_NAME) ?? null;
  return { entry };
}

/** The check itself. Pure over `runCli`, so tests drive it with a recorder. */
export async function performUpdateCheck({
  plan, runCli = runCopilotCli, env = process.env, readText = readFile,
}) {
  const result = { installedVersion: null, availableVersion: null, applied: false, notes: [] };

  const markets = await runCli(CLI_COMMANDS.marketplaceList, { timeoutMs: CLI_TIMEOUT_MS });
  const marketList = markets.exitCode === 0 ? parseJsonArray(markets.stdout) : null;
  if (!marketList) return { ...result, status: 'failed', error: cliFailure(markets, '`copilot plugin marketplace list --json`') };
  const marketplace = marketList.find(item => item?.name === MARKETPLACE_NAME);
  if (!marketplace) {
    return { ...result, status: 'marketplace-missing',
      error: `marketplace '${MARKETPLACE_NAME}' is not registered with the Copilot CLI` };
  }

  const installed = await readInstalled(runCli);
  if (installed.error) return { ...result, status: 'failed', error: installed.error };
  if (!installed.entry) {
    return { ...result, status: 'not-installed', error: `${PLUGIN_SPEC} is not installed` };
  }
  result.installedVersion = isVersion(installed.entry.version) ? installed.entry.version.trim() : null;
  if (installed.entry.marketplace !== MARKETPLACE_NAME) {
    return { ...result, status: 'not-marketplace-install',
      error: `${PLUGIN_NAME} is installed from '${installed.entry.marketplace || installed.entry.source || 'elsewhere'}', ` +
        `not the ${MARKETPLACE_NAME} marketplace; leaving it alone` };
  }

  const refresh = await runCli(CLI_COMMANDS.marketplaceRefresh, { timeoutMs: CLI_TIMEOUT_MS });
  if (refresh.exitCode !== 0) result.notes.push(cliFailure(refresh, 'catalog refresh'));

  const browse = await runCli(CLI_COMMANDS.marketplaceBrowse, { timeoutMs: CLI_TIMEOUT_MS });
  const catalog = browse.exitCode === 0 ? parseJsonArray(browse.stdout) : null;
  if (!catalog) return { ...result, status: 'failed', error: cliFailure(browse, '`copilot plugin marketplace browse`') };
  const listed = catalog.find(item => item?.name === PLUGIN_NAME);
  if (!listed) {
    return { ...result, status: 'failed', error: `${PLUGIN_NAME} is not listed in the ${MARKETPLACE_NAME} catalog` };
  }
  result.availableVersion = isVersion(listed.version) ? listed.version.trim() : null;
  if (!result.availableVersion) {
    const cached = await readCachedCatalogVersion(marketplace, { env, readText });
    if (cached.version) {
      result.availableVersion = cached.version;
      result.notes.push(`catalog version read from refreshed marketplace cache: ${cached.manifestPath}`);
    } else {
      return { ...result, status: 'capability-gap',
        error: `catalog version unavailable: browse output has no version, and ${cached.error}` };
    }
  }
  if (!result.availableVersion || !result.installedVersion) {
    return { ...result, status: 'capability-gap',
      error: 'the Copilot CLI did not report a comparable installed plugin version' };
  }
  if (compareVersions(result.availableVersion, result.installedVersion) <= 0) {
    return { ...result, status: 'up-to-date', error: null };
  }
  if (!plan.autoApply) return { ...result, status: 'update-available', error: null };

  const apply = await runCli(CLI_COMMANDS.install, { timeoutMs: APPLY_TIMEOUT_MS });
  if (apply.exitCode !== 0) {
    return { ...result, status: 'apply-failed', error: cliFailure(apply, `\`copilot plugin install ${PLUGIN_SPEC}\``) };
  }
  const after = await readInstalled(runCli);
  if (after.error) return { ...result, status: 'apply-failed', error: `re-verify: ${after.error}` };
  const nowVersion = after.entry?.version;
  if (isVersion(nowVersion) && compareVersions(nowVersion, result.availableVersion) >= 0) {
    return { ...result, status: 'applied', applied: true, previousVersion: result.installedVersion,
      installedVersion: nowVersion.trim(), error: null };
  }
  return { ...result, status: 'apply-failed',
    error: `install reported success but the installed version is still ${nowVersion ?? 'unknown'}` };
}

export function summarizeResult(outcome) {
  switch (outcome.status) {
    case 'up-to-date': return `up to date (${outcome.installedVersion})`;
    case 'update-available':
      return `update available: ${outcome.installedVersion} -> ${outcome.availableVersion} (Auto apply is off)`;
    case 'applied': return `updated ${outcome.previousVersion} -> ${outcome.installedVersion}`;
    default: return `${outcome.status}: ${outcome.error ?? 'no detail'}`;
  }
}

async function readState(path) {
  try {
    const parsed = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    return { ...parsed, recent: Array.isArray(parsed?.recent) ? parsed.recent : [] };
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

// This workload's OWN lock. Deliberately not the reliability or browser lock.
async function acquireUpdateLock(path) {
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

function describePolicy(declared, plan) {
  return {
    valid: true, source: declared.source, settingsPath: declared.settingsPath,
    enabled: plan.enabled, intervalMinutes: plan.intervalMinutes,
    autoApply: declared.values.autoApply ?? UPDATE_CHECKS_DEFAULTS.autoApply,
    updateSource: plan.source,
  };
}

function lastView(state) {
  return {
    lastCheckedAt: state.lastCheckedAt ?? null, lastAttemptAt: state.lastAttemptAt ?? null,
    lastResult: state.lastResult ?? null, installedVersion: state.installedVersion ?? null,
    availableVersion: state.availableVersion ?? null, summary: state.summary ?? null,
    error: state.lastError ?? null,
  };
}

export async function runUpdateWorkload({
  paths = updateWorkloadPaths(), reportOnly = false, force = false, clock = { now: () => Date.now() },
  policy: suppliedPolicy, runCli = runCopilotCli, env = process.env, readText = readFile,
} = {}) {
  const nowMs = clock.now();
  const recheck = new Date(nowMs + POLICY_RECHECK_MINUTES * 60_000).toISOString();
  let declared;
  try {
    declared = suppliedPolicy ?? await loadUpdateChecksPolicy();
  } catch (error) {
    return { status: 'policy-error', error: String(error?.message ?? error), dispatched: false, nextEvaluationAt: recheck };
  }
  const plan = resolveUpdatePlan(declared.values, { reportOnly });
  const policy = describePolicy(declared, plan);
  let state;
  try { state = await readState(paths.state); } catch { state = { recent: [] }; }
  if (!plan.enabled) {
    return { status: 'disabled', dispatched: false, plan, policy, last: lastView(state), recent: state.recent.slice(-5).reverse(),
      nextEvaluationAt: recheck };
  }
  if (!force && !isCheckDue(state, plan, nowMs)) {
    // Idempotent: inside the interval nothing runs and nothing is written.
    const due = nextDueAt(state, plan, nowMs);
    return { status: 'not-due', dispatched: false, plan, policy, last: lastView(state),
      recent: state.recent.slice(-5).reverse(),
      nextEvaluationAt: Date.parse(due) < Date.parse(recheck) ? due : recheck };
  }
  const lock = await acquireUpdateLock(paths.lock);
  if (!lock) {
    return { status: 'busy', dispatched: false, plan, policy, last: lastView(state), recent: [], nextEvaluationAt: recheck };
  }
  try {
    const outcome = await performUpdateCheck({ plan, runCli, env, readText });
    const endMs = clock.now();
    const at = new Date(endMs).toISOString();
    outcome.summary = summarizeResult(outcome);
    const fresh = await readState(paths.state).catch(() => ({ recent: [] }));
    const next = {
      ...fresh,
      lastAttemptAt: at,
      lastCheckedAt: COMPLETED.has(outcome.status) ? at : fresh.lastCheckedAt ?? null,
      lastResult: outcome.status,
      lastError: outcome.error ?? null,
      summary: outcome.summary,
      installedVersion: outcome.installedVersion ?? fresh.installedVersion ?? null,
      availableVersion: outcome.availableVersion ?? fresh.availableVersion ?? null,
      recent: [...(fresh.recent ?? []), {
        at, status: outcome.status, summary: outcome.summary, autoApply: plan.autoApply,
        installedVersion: outcome.installedVersion, availableVersion: outcome.availableVersion,
      }].slice(-RECENT_LIMIT),
    };
    if (outcome.applied) next.lastAppliedAt = at;
    await writeState(paths.state, next);
    return { status: outcome.status, dispatched: true, plan, policy, outcome, last: lastView(next),
      recent: next.recent.slice(-5).reverse(), error: outcome.error ?? null,
      nextEvaluationAt: nextDueAt(next, plan, endMs) };
  } finally {
    await lock.release();
  }
}

/**
 * Stale fallback (non-blocking): policy + state only, no CLI and no writes.
 * Returns `{ stale, note }`; `note` is null when nothing needs saying.
 */
export async function staleCheckNote({
  paths = updateWorkloadPaths(), policy: suppliedPolicy, clock = { now: () => Date.now() },
} = {}) {
  let declared;
  try { declared = suppliedPolicy ?? await loadUpdateChecksPolicy(); } catch { return { stale: false, note: null }; }
  const plan = resolveUpdatePlan(declared.values);
  if (!plan.enabled) return { stale: false, note: null };
  let state;
  try { state = await readState(paths.state); } catch { state = {}; }
  const last = Date.parse(state.lastCheckedAt ?? '');
  const stale = !Number.isFinite(last) || clock.now() >= last + plan.intervalMinutes * 60_000;
  let note = null;
  if (stale) {
    note = `Plugin update check is stale (last completed: ${state.lastCheckedAt ?? 'never'}; interval ` +
      `${plan.intervalMinutes}m). Run 'node consumer-update-check.mjs' or the tray's 'Check for updates now'.`;
  } else if (state.lastResult === 'update-available') {
    note = `Overnight Agent update available: ${state.installedVersion} -> ${state.availableVersion}.`;
  }
  return { stale, note, last: lastView(state) };
}

/** Read-only view for the tray: never calls the CLI and never writes. */
export async function readUpdateStatus({ paths = updateWorkloadPaths(), policy: suppliedPolicy, reportOnly = false } = {}) {
  let policy;
  try {
    const declared = suppliedPolicy ?? await loadUpdateChecksPolicy();
    policy = describePolicy(declared, resolveUpdatePlan(declared.values, { reportOnly }));
  } catch (error) {
    policy = { valid: false, enabled: false, error: String(error?.message ?? error) };
  }
  let state = { recent: [] };
  const errors = [];
  try { state = await readState(paths.state); } catch (error) { errors.push(String(error?.message ?? error)); }
  return { status: 'status', policy, last: lastView(state), recent: state.recent.slice(-5).reverse(), errors };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--status') {
    console.log(JSON.stringify(await readUpdateStatus()));
    return;
  }
  if (argv.length === 1 && argv[0] === '--stale-note') {
    console.log(JSON.stringify(await staleCheckNote()));
    return;
  }
  if (argv.some(arg => arg !== '--report-only' && arg !== '--force')) {
    throw new Error('Usage: node consumer-update-check.mjs [--status | --stale-note | [--force] [--report-only]]');
  }
  const result = await runUpdateWorkload({ reportOnly: argv.includes('--report-only'), force: argv.includes('--force') });
  console.log(JSON.stringify(result));
  if (['failed', 'apply-failed', 'policy-error'].includes(result.status)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Update-check workload failed: ${error.stack ?? error}`);
    process.exitCode = 2;
  });
}
