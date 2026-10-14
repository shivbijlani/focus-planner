import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadBrowserChecksPolicy, loadReliabilityPolicy, loadUpdateChecksPolicy, parseUpdateChecksPolicy,
  UPDATE_CHECKS_DEFAULTS, UPDATE_CHECKS_SECTION_HEADING,
} from './oa-user-settings.mjs';
import {
  CLI_COMMANDS, compareVersions, isCheckDue, marketplaceManifestPath, PLUGIN_SPEC, readUpdateStatus, resolveUpdatePlan,
  runCopilotCli, runUpdateWorkload, staleCheckNote, updateWorkloadPaths,
} from './consumer-update-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-09-28T08:00:00.000Z');
const clockAt = ms => ({ now: () => ms });

const settings = rows => [
  '# Overnight Agent — user settings',
  '',
  '## Tray reliability supervision',
  '',
  '| Setting | Value |',
  '| --- | --- |',
  '| Enabled | `off` |',
  '',
  '## Tray browser checks',
  '',
  '| Setting | Value |',
  '| --- | --- |',
  '| Enabled | `on` |',
  '',
  ...(rows === null ? [] : [
    `## ${UPDATE_CHECKS_SECTION_HEADING}`,
    '',
    '| Setting | Value |',
    '| --- | --- |',
    ...rows,
  ]),
].join('\n');

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oa-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function settingsFile(t, rows) {
  const path = join(await home(t), 'user-settings.md');
  await writeFile(path, settings(rows), 'utf8');
  return path;
}

const policyOf = values => ({ source: 'user-settings', settingsPath: 'U.md', values });

/**
 * A scripted Copilot CLI. `installed` is what `plugin list` reports, `catalog`
 * what `marketplace browse` reports; `install` bumps installed to `installTo`.
 */
function fakeCli({
  marketplaces = [{ name: 'copilot-plugins' }, { name: 'focus-planner' }],
  installed = { name: 'overnight-agent', marketplace: 'focus-planner', version: '1.53.0' },
  catalog = [{ name: 'overnight-agent', marketplace: 'focus-planner', version: '1.53.0' }],
  installTo = null, installExit = 0, failOn = null,
} = {}) {
  const calls = [];
  let current = installed;
  const ok = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false });
  const run = async args => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    if (failOn && key.startsWith(failOn)) return { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false };
    if (key === CLI_COMMANDS.marketplaceList.join(' ')) return ok(marketplaces);
    if (key === CLI_COMMANDS.pluginList.join(' ')) return ok(current ? [{ name: 'calendar', version: '1.0.0' }, current] : []);
    if (key === CLI_COMMANDS.marketplaceRefresh.join(' ')) return ok({});
    if (key === CLI_COMMANDS.marketplaceBrowse.join(' ')) return ok(catalog);
    if (key === CLI_COMMANDS.install.join(' ')) {
      if (installExit === 0 && installTo) current = { ...current, version: installTo };
      return { exitCode: installExit, stdout: '', stderr: installExit ? 'install failed' : '', timedOut: false };
    }
    throw new Error(`unexpected CLI call: ${key}`);
  };
  return { calls, run };
}

test('defaults: enabled, daily, Auto apply off, marketplace source', () => {
  assert.deepEqual(UPDATE_CHECKS_DEFAULTS,
    { enabled: true, intervalMinutes: 1440, autoApply: false, source: 'marketplace' });
  assert.deepEqual(resolveUpdatePlan({}),
    { enabled: true, intervalMinutes: 1440, autoApply: false, source: 'marketplace' });
});

test('a missing file, section or row falls back to the defaults', async t => {
  const dir = await home(t);
  for (const policy of [
    await loadUpdateChecksPolicy({ settingsPath: join(dir, 'absent.md') }),
    await loadUpdateChecksPolicy({ settingsPath: await settingsFile(t, null) }),
    await loadUpdateChecksPolicy({ settingsPath: await settingsFile(t, []) }),
    await loadUpdateChecksPolicy({ env: {} }),
  ]) {
    assert.deepEqual(policy.values, {});
    assert.deepEqual(resolveUpdatePlan(policy.values), { ...UPDATE_CHECKS_DEFAULTS });
  }
  const partial = await loadUpdateChecksPolicy({ settingsPath: await settingsFile(t, ['| Auto apply | `on` |']) });
  assert.deepEqual(resolveUpdatePlan(partial.values), { ...UPDATE_CHECKS_DEFAULTS, autoApply: true });
});

test('hourly is selectable, and every cadence spelling is read', () => {
  const read = value => parseUpdateChecksPolicy(settings([`| Check interval | \`${value}\` |`])).values.intervalMinutes;
  assert.equal(read('hourly'), 60);
  assert.equal(read('Daily'), 1440);
  assert.equal(read('weekly'), 10080);
  assert.equal(read('6h'), 360);
  assert.equal(read('90m'), 90);
});

test('invalid values are refused by name', () => {
  for (const [rows, expected] of [
    [['| Check interval | `soon` |'], /'Check interval'.*must be 'hourly', 'daily', 'weekly'/],
    [['| Check interval | `5m` |'], /'Check interval'.*from 60 to 10080 minutes/],
    [['| Auto apply | `maybe` |'], /'Auto apply'.*must be 'on' or 'off'/],
    [['| Source | `git` |'], /'Source'.*must be one of: marketplace/],
    [['| Channel | `beta` |'], /'Channel'.*not a supported setting/],
    [['| Enabled | `on` |', '| Enabled | `off` |'], /declared twice/],
  ]) {
    assert.throws(() => parseUpdateChecksPolicy(settings(rows), { settingsPath: 'U.md' }), expected);
  }
});

test('the bundled template documents the section and parses to exactly the defaults', async () => {
  const template = join(here, '..', 'skills', 'overnight-agent', 'user-settings.md');
  const policy = await loadUpdateChecksPolicy({ settingsPath: template });
  assert.equal(policy.source, 'user-settings');
  assert.deepEqual(policy.values, { ...UPDATE_CHECKS_DEFAULTS });
});

test('an unreadable update section never runs the CLI and never disturbs the other workloads', async t => {
  const path = await settingsFile(t, ['| Auto apply | `sometimes` |']);
  const saved = process.env.OVERNIGHT_AGENT_SETTINGS;
  process.env.OVERNIGHT_AGENT_SETTINGS = path;
  t.after(() => {
    if (saved === undefined) delete process.env.OVERNIGHT_AGENT_SETTINGS;
    else process.env.OVERNIGHT_AGENT_SETTINGS = saved;
  });
  const cli = fakeCli();
  const paths = updateWorkloadPaths(await home(t));
  const result = await runUpdateWorkload({ paths, runCli: cli.run, clock: clockAt(NOW) });
  assert.equal(result.status, 'policy-error');
  assert.match(result.error, /Auto apply/);
  assert.equal(cli.calls.length, 0);
  assert.equal(existsSync(paths.state), false);
  assert.deepEqual((await loadReliabilityPolicy({ settingsPath: path })).values, { enabled: false });
  assert.deepEqual((await loadBrowserChecksPolicy({ settingsPath: path })).values, { enabled: true });
});

test('Enabled = off runs nothing and writes nothing', async t => {
  const cli = fakeCli();
  const paths = updateWorkloadPaths(await home(t));
  const result = await runUpdateWorkload({ paths, policy: policyOf({ enabled: false }), runCli: cli.run, force: true });
  assert.equal(result.status, 'disabled');
  assert.equal(cli.calls.length, 0);
  assert.equal(existsSync(paths.state), false);
  assert.equal(existsSync(paths.lock), false);
});

test('with Auto apply off an available update is only reported, never installed', async t => {
  const cli = fakeCli({ catalog: [{ name: 'overnight-agent', version: '1.54.0' }] });
  const paths = updateWorkloadPaths(await home(t));
  const result = await runUpdateWorkload({ paths, policy: policyOf({}), runCli: cli.run, clock: clockAt(NOW) });
  assert.equal(result.status, 'update-available');
  assert.equal(result.outcome.summary, 'update available: 1.53.0 -> 1.54.0 (Auto apply is off)');
  assert.ok(!cli.calls.some(call => call.startsWith('plugin install')), 'no install without Auto apply');
  assert.equal(result.nextEvaluationAt, '2026-09-29T08:00:00.000Z', 'daily by default');

  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.lastCheckedAt, '2026-09-28T08:00:00.000Z');
  assert.equal(state.availableVersion, '1.54.0');
  assert.equal(state.installedVersion, '1.53.0');
  assert.equal(state.lastResult, 'update-available');
  assert.equal(existsSync(paths.lock), false, 'the lock is released');
});

test('the real browse shape gets its version from the refreshed marketplace cache', async t => {
  const browse = JSON.parse(await readFile(join(here, 'fixtures', 'marketplace-browse.json'), 'utf8'));
  const localAppData = await home(t);
  const marketplace = {
    name: 'focus-planner',
    source: 'GitHub: shivbijlani/focus-planner',
  };
  const manifestPath = marketplaceManifestPath(marketplace, { LOCALAPPDATA: localAppData });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    name: 'focus-planner',
    plugins: [{ name: 'overnight-agent', version: '1.54.0' }],
  }), 'utf8');

  const cli = fakeCli({ marketplaces: [marketplace], catalog: browse });
  const result = await runUpdateWorkload({
    paths: updateWorkloadPaths(await home(t)),
    policy: policyOf({}),
    runCli: cli.run,
    env: { LOCALAPPDATA: localAppData },
    clock: clockAt(NOW),
  });
  assert.equal(result.status, 'update-available');
  assert.equal(result.outcome.availableVersion, '1.54.0');
  assert.match(result.outcome.notes.at(-1), /refreshed marketplace cache/);
});

test('a missing marketplace version source is reported as a capability gap', async t => {
  const browse = JSON.parse(await readFile(join(here, 'fixtures', 'marketplace-browse.json'), 'utf8'));
  const cli = fakeCli({
    marketplaces: [{ name: 'focus-planner', source: 'Local: C:\\catalog' }],
    catalog: browse,
  });
  const result = await runUpdateWorkload({
    paths: updateWorkloadPaths(await home(t)),
    policy: policyOf({}),
    runCli: cli.run,
    env: { LOCALAPPDATA: await home(t) },
    clock: clockAt(NOW),
  });
  assert.equal(result.status, 'capability-gap');
  assert.match(result.error, /browse output has no version/);
  assert.match(result.error, /does not expose a readable cache location/);
});

test('only the marketplace CLI commands are ever run: never git, never a deploy script', async t => {
  const cli = fakeCli({ catalog: [{ name: 'overnight-agent', version: '2.0.0' }], installTo: '2.0.0' });
  await runUpdateWorkload({ paths: updateWorkloadPaths(await home(t)), policy: policyOf({ autoApply: true }),
    runCli: cli.run, clock: clockAt(NOW) });
  const allowed = new Set(Object.values(CLI_COMMANDS).map(args => args.join(' ')));
  assert.ok(cli.calls.length >= 5);
  for (const call of cli.calls) {
    assert.ok(allowed.has(call), `unexpected command: ${call}`);
    assert.ok(call.startsWith('plugin '), `every command is a copilot plugin subcommand: ${call}`);
  }
  assert.ok(cli.calls.includes(`plugin install ${PLUGIN_SPEC}`));

  const source = await readFile(join(here, 'consumer-update-check.mjs'), 'utf8');
  assert.doesNotMatch(source, /['"`]git['"`\s]/, 'no git invocation');
  assert.doesNotMatch(source, /['"`][^'"`\n]*origin\/main/, 'no origin/main');
  assert.doesNotMatch(source, /['"`][^'"`\n]*(auto-deploy-plugin|deploy-installed-plugin|sync-oa-home)\.ps1/,
    'no maintainer deploy script is referenced as code');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(reliability-supervisor|consumer-browser-watchdog|windows-app-actuator)/,
    'imports neither the reliability nor the browser workload');
});

test('Auto apply installs from the marketplace and re-verifies the installed version', async t => {
  const cli = fakeCli({ catalog: [{ name: 'overnight-agent', version: '1.54.0' }], installTo: '1.54.0' });
  const paths = updateWorkloadPaths(await home(t));
  const result = await runUpdateWorkload({ paths, policy: policyOf({ autoApply: true }), runCli: cli.run, clock: clockAt(NOW) });
  assert.equal(result.status, 'applied');
  assert.equal(result.outcome.summary, 'updated 1.53.0 -> 1.54.0');
  const installAt = cli.calls.indexOf(`plugin install ${PLUGIN_SPEC}`);
  assert.ok(installAt > 0);
  assert.equal(cli.calls[installAt + 1], CLI_COMMANDS.pluginList.join(' '), 'installed version is read again after apply');
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.installedVersion, '1.54.0');
  assert.ok(state.lastAppliedAt);
});

test('an apply that does not move the installed version is reported as apply-failed', async t => {
  const cli = fakeCli({ catalog: [{ name: 'overnight-agent', version: '1.54.0' }], installTo: null });
  const result = await runUpdateWorkload({ paths: updateWorkloadPaths(await home(t)), policy: policyOf({ autoApply: true }),
    runCli: cli.run, clock: clockAt(NOW) });
  assert.equal(result.status, 'apply-failed');
  assert.match(result.error, /still 1\.53\.0/);

  const failing = fakeCli({ catalog: [{ name: 'overnight-agent', version: '1.54.0' }], installExit: 1 });
  const failed = await runUpdateWorkload({ paths: updateWorkloadPaths(await home(t)), policy: policyOf({ autoApply: true }),
    runCli: failing.run, clock: clockAt(NOW) });
  assert.equal(failed.status, 'apply-failed');
});

test('host --report-only can only remove Auto apply', async t => {
  assert.equal(resolveUpdatePlan({ autoApply: true }, { reportOnly: true }).autoApply, false);
  assert.equal(resolveUpdatePlan({ enabled: false }, { reportOnly: true }).enabled, false);
  const cli = fakeCli({ catalog: [{ name: 'overnight-agent', version: '1.54.0' }], installTo: '1.54.0' });
  const result = await runUpdateWorkload({ paths: updateWorkloadPaths(await home(t)), policy: policyOf({ autoApply: true }),
    reportOnly: true, runCli: cli.run, clock: clockAt(NOW) });
  assert.equal(result.status, 'update-available');
  assert.ok(!cli.calls.some(call => call.startsWith('plugin install')));
});

test('idempotency guards: marketplace registered, plugin installed from it, versions compared', async t => {
  const cases = [
    [{ marketplaces: [{ name: 'copilot-plugins' }] }, 'marketplace-missing'],
    [{ installed: null }, 'not-installed'],
    [{ installed: { name: 'overnight-agent', marketplace: 'local', version: '1.0.0' } }, 'not-marketplace-install'],
    [{ catalog: [{ name: 'overnight-agent', version: '1.53.0' }] }, 'up-to-date'],
    [{ catalog: [{ name: 'overnight-agent', version: '1.52.9' }] }, 'up-to-date'],
    [{ catalog: [{ name: 'overnight-agent' }] }, 'capability-gap'],
    [{ failOn: 'plugin marketplace list' }, 'failed'],
  ];
  for (const [options, expected] of cases) {
    const cli = fakeCli({ ...options, installTo: '9.9.9' });
    const result = await runUpdateWorkload({ paths: updateWorkloadPaths(await home(t)),
      policy: policyOf({ autoApply: true }), runCli: cli.run, clock: clockAt(NOW) });
    assert.equal(result.status, expected, JSON.stringify(options));
    assert.ok(!cli.calls.some(call => call.startsWith('plugin install')), `no install when ${expected}`);
  }
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.54.0-beta', '1.54.0'), -1);
  assert.equal(compareVersions('v2.0', '2.0.0'), 0);
});

test('a run inside the interval touches no CLI and writes nothing; tray restarts add no checks', async t => {
  const paths = updateWorkloadPaths(await home(t));
  const first = fakeCli();
  await runUpdateWorkload({ paths, policy: policyOf({}), runCli: first.run, clock: clockAt(NOW) });
  const before = await readFile(paths.state, 'utf8');

  const again = fakeCli();
  const later = NOW + 23 * 3600_000;
  const result = await runUpdateWorkload({ paths, policy: policyOf({}), runCli: again.run, clock: clockAt(later) });
  assert.equal(result.status, 'not-due');
  assert.equal(again.calls.length, 0);
  assert.equal(await readFile(paths.state, 'utf8'), before, 'state untouched');
  assert.equal(result.last.lastResult, 'up-to-date', 'the tray still sees the last result');

  const hourly = await runUpdateWorkload({ paths, policy: policyOf({ intervalMinutes: 60 }), runCli: again.run,
    clock: clockAt(NOW + 61 * 60_000) });
  assert.equal(hourly.dispatched, true, 'hourly re-checks after an hour');

  const forced = fakeCli();
  const now = await runUpdateWorkload({ paths, policy: policyOf({}), runCli: forced.run, force: true,
    clock: clockAt(NOW + 62 * 60_000) });
  assert.equal(now.dispatched, true, '"Check for updates now" bypasses the interval');
});

test('a failed check retries within the hour, not after a whole day', async t => {
  const paths = updateWorkloadPaths(await home(t));
  await runUpdateWorkload({ paths, policy: policyOf({}), runCli: fakeCli({ failOn: 'plugin list' }).run, clock: clockAt(NOW) });
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.lastResult, 'failed');
  assert.equal(state.lastCheckedAt, null, 'a failure is not a completed check');
  const plan = resolveUpdatePlan({});
  assert.equal(isCheckDue(state, plan, NOW + 30 * 60_000), false);
  assert.equal(isCheckDue(state, plan, NOW + 61 * 60_000), true);
});

test('stale fallback notes an old check without running the CLI or writing', async t => {
  const paths = updateWorkloadPaths(await home(t));
  const never = await staleCheckNote({ paths, policy: policyOf({}), clock: clockAt(NOW) });
  assert.equal(never.stale, true);
  assert.match(never.note, /stale \(last completed: never/);
  assert.equal(existsSync(paths.state), false);

  await runUpdateWorkload({ paths, policy: policyOf({}), clock: clockAt(NOW),
    runCli: fakeCli({ catalog: [{ name: 'overnight-agent', version: '1.54.0' }] }).run });
  const fresh = await staleCheckNote({ paths, policy: policyOf({}), clock: clockAt(NOW + 3600_000) });
  assert.equal(fresh.stale, false);
  assert.match(fresh.note, /update available: 1\.53\.0 -> 1\.54\.0/);
  const old = await staleCheckNote({ paths, policy: policyOf({}), clock: clockAt(NOW + 25 * 3600_000) });
  assert.equal(old.stale, true);
  assert.equal((await staleCheckNote({ paths, policy: policyOf({ enabled: false }), clock: clockAt(NOW + 99 * 3600_000) })).note, null);
});

test('own state file and lock; a live lock makes the run step aside', async t => {
  const paths = updateWorkloadPaths(await home(t));
  assert.match(paths.state, /update-check-state\.json$/);
  assert.match(paths.lock, /update-check\.lock$/);
  for (const other of ['reliability', 'browser', 'supervisor-tray']) {
    assert.ok(!paths.state.includes(other) && !paths.lock.includes(other));
  }
  await writeFile(paths.lock, JSON.stringify({ pid: process.pid }), 'utf8');
  const cli = fakeCli();
  const result = await runUpdateWorkload({ paths, policy: policyOf({}), runCli: cli.run, force: true });
  assert.equal(result.status, 'busy');
  assert.equal(cli.calls.length, 0);
  const status = await readUpdateStatus({ paths, policy: policyOf({ intervalMinutes: 60 }) });
  assert.equal(status.policy.intervalMinutes, 60);
  assert.equal(status.policy.autoApply, false);
});

test('the real CLI runner can be pointed at a fixture script (used by the tray tests)', async t => {
  const dir = await home(t);
  const fixture = join(dir, 'fake-copilot.mjs');
  await writeFile(fixture, "console.log(JSON.stringify(process.argv.slice(2)));\n", 'utf8');
  const run = await runCopilotCli(CLI_COMMANDS.pluginList, { env: { ...process.env, OA_COPILOT_CLI: fixture } });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(JSON.parse(run.stdout), CLI_COMMANDS.pluginList);
});
