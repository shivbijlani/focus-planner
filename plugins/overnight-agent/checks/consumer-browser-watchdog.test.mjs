import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_CHECKS_DEFAULTS, BROWSER_CHECKS_SECTION_HEADING, loadBrowserChecksPolicy,
  loadReliabilityPolicy, parseBrowserChecksPolicy, RELIABILITY_SECTION_HEADING,
} from './oa-user-settings.mjs';
import {
  browserWorkloadPaths, readBrowserStatus, resolveBrowserPlan, runBrowserWorkload,
} from './consumer-browser-watchdog.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const settings = rows => [
  '# Overnight Agent — user settings',
  '',
  '## Browser slots',
  '',
  '| Slot | Profile dir |',
  '| --- | --- |',
  '| `edge-cdp-1` | `edge1` |',
  '',
  `## ${RELIABILITY_SECTION_HEADING}`,
  '',
  '| Setting | Value |',
  '| --- | --- |',
  '| Enabled | `off` |',
  '',
  ...(rows === null ? [] : [
    `## ${BROWSER_CHECKS_SECTION_HEADING}`,
    '',
    '| Setting | Value |',
    '| --- | --- |',
    ...rows,
  ]),
].join('\n');

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oa-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function settingsFile(t, rows) {
  const dir = await home(t);
  const path = join(dir, 'user-settings.md');
  await writeFile(path, settings(rows), 'utf8');
  return path;
}

function recordingWatchdog(report = { slots: [], unhealthy: 0, healthy: true }, exitCode = 0) {
  const calls = [];
  const run = async invocation => {
    calls.push(invocation);
    return { exitCode, stdout: JSON.stringify(report), stderr: '', timedOut: false };
  };
  return { calls, run };
}

const has = (plan, flag) => plan.watchdogArgs.includes(flag);

test('browser checks are completely off by default, including observation', async t => {
  assert.deepEqual(BROWSER_CHECKS_DEFAULTS, { enabled: false, observe: false, intervalMinutes: 60 });
  assert.equal(resolveBrowserPlan({}).dispatch, false);
  assert.equal(resolveBrowserPlan({}).reason, 'disabled');

  // A missing file, a missing section, and an empty section all dispatch nothing.
  const dir = await home(t);
  const noSection = await settingsFile(t, null);
  const empty = await settingsFile(t, []);
  for (const policy of [
    await loadBrowserChecksPolicy({ settingsPath: join(dir, 'absent.md') }),
    await loadBrowserChecksPolicy({ settingsPath: noSection }),
    await loadBrowserChecksPolicy({ settingsPath: empty }),
    await loadBrowserChecksPolicy({ env: {} }),
  ]) {
    const paths = browserWorkloadPaths(dir);
    const watchdog = recordingWatchdog();
    const result = await runBrowserWorkload({ paths, policy, runWatchdog: watchdog.run });
    assert.equal(result.dispatched, false);
    assert.equal(result.status, 'disabled');
    assert.equal(watchdog.calls.length, 0, 'no browser status check of any kind');
    assert.equal(existsSync(paths.state), false, 'nothing is written while off');
    assert.equal(existsSync(paths.lock), false, 'no lock is taken while off');
  }
});

test('Enabled = off wins over Observe', async t => {
  const path = await settingsFile(t, ['| Enabled | `off` |', '| Observe | `on` |']);
  const policy = await loadBrowserChecksPolicy({ settingsPath: path });
  const watchdog = recordingWatchdog();
  const result = await runBrowserWorkload({ paths: browserWorkloadPaths(await home(t)), policy,
    runWatchdog: watchdog.run });
  assert.equal(result.status, 'disabled');
  assert.equal(watchdog.calls.length, 0);
});

test('Enabled = on alone still runs nothing: Observe is its own opt-in', () => {
  const plan = resolveBrowserPlan({ enabled: true });
  assert.equal(plan.dispatch, false);
  assert.equal(plan.reason, 'no-opt-ins');
});

test('Observe is a read-only status check', () => {
  const plan = resolveBrowserPlan({ enabled: true, observe: true });
  assert.equal(plan.dispatch, true);
  assert.equal(plan.mode, 'observe');
  assert.ok(has(plan, '-Json'));
  assert.ok(has(plan, '-Quiet'));
  // No launch/thaw flags exist any more -- GH #738 removed both actions.
  assert.ok(!has(plan, '-NoLaunch') && !has(plan, '-NoRepair') && !has(plan, '-ReportOnly'));

  // The host-level -NoAct diagnostic can never turn a disabled workload on,
  // and observation is already read-only so it has nothing left to remove.
  assert.deepEqual(resolveBrowserPlan({ enabled: true, observe: true }, { reportOnly: true }), plan);
  assert.equal(resolveBrowserPlan({}, { reportOnly: true }).dispatch, false);
});

test('the browser section is parsed by the shared reader and refuses what it cannot read', async t => {
  const path = await settingsFile(t, [
    '| Enabled | `on` — run browser checks from the tray |', '| Observe | `on` |',
    '| Check interval | `2h` |',
  ]);
  const policy = await loadBrowserChecksPolicy({ settingsPath: path });
  assert.equal(policy.source, 'user-settings');
  assert.deepEqual(policy.values, { enabled: true, observe: true, intervalMinutes: 120 });

  for (const [rows, expected] of [
    [['| Observe | `maybe` |'], /must be 'on' or 'off'/],
    [['| Check interval | `5m` |'], /must be from 15 to 1440 minutes/],
    [['| Thaw stuck slots | `on` |'], /not a supported setting/],
    [['| Auto launch closed slots | `on` |'], /not a supported setting/],
    [['| Observe | `on` |', '| Observe | `off` |'], /declared twice/],
  ]) {
    assert.throws(() => parseBrowserChecksPolicy(settings(rows), { settingsPath: 'U.md' }), expected);
  }
});

test('an unreadable browser section never dispatches and never disturbs reliability policy', async t => {
  const path = await settingsFile(t, ['| Observe | `sometimes` |']);
  const dir = await home(t);
  const saved = process.env.OVERNIGHT_AGENT_SETTINGS;
  process.env.OVERNIGHT_AGENT_SETTINGS = path;
  t.after(() => {
    if (saved === undefined) delete process.env.OVERNIGHT_AGENT_SETTINGS;
    else process.env.OVERNIGHT_AGENT_SETTINGS = saved;
  });
  const watchdog = recordingWatchdog();
  const result = await runBrowserWorkload({ paths: browserWorkloadPaths(dir), runWatchdog: watchdog.run });
  assert.equal(result.status, 'policy-error');
  assert.match(result.error, /Observe/);
  assert.equal(watchdog.calls.length, 0);
  // Separate workloads, separate policies: reliability still reads its own section.
  assert.deepEqual((await loadReliabilityPolicy({ settingsPath: path })).values, { enabled: false });
});

test('a dispatched run uses its own state file, its own interval, and the same settings file', async t => {
  const path = await settingsFile(t, ['| Enabled | `on` |', '| Observe | `on` |', '| Check interval | `30m` |']);
  const policy = await loadBrowserChecksPolicy({ settingsPath: path });
  const dir = await home(t);
  const paths = browserWorkloadPaths(dir);
  assert.ok(!/reliability/i.test(paths.state) && !/reliability/i.test(paths.lock),
    'no shared state or lock with the reliability workload');
  const report = { slots: [
    { slot: 'edge-cdp-1', account: 'primary', profile_dir: 'edge1', state: 'in-use', healthy: true, detail: 'profile is open' },
    { slot: 'edge-cdp-2', account: 'second', profile_dir: 'edge2', state: 'not-signed-in', healthy: true, detail: 'no profile yet' },
  ], unhealthy: 0, healthy: true };
  const watchdog = recordingWatchdog(report, 0);
  const nowMs = Date.parse('2026-09-28T08:00:00.000Z');
  const result = await runBrowserWorkload({ paths, policy, runWatchdog: watchdog.run, clock: { now: () => nowMs } });

  assert.equal(result.status, 'healthy');
  assert.equal(watchdog.calls.length, 1);
  assert.equal(watchdog.calls[0].script, paths.watchdog);
  const args = watchdog.calls[0].args;
  assert.ok(args.includes('-Json') && args.includes('-Quiet'));
  assert.equal(args[args.indexOf('-SettingsPath') + 1], path, 'the slot table comes from the same file');
  assert.equal(result.nextEvaluationAt, '2026-09-28T08:30:00.000Z');
  assert.equal(result.outcome.summary, 'healthy: 2/2 profile(s) reported on');
  assert.equal(existsSync(paths.lock), false, 'the lock is released');

  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.recent.length, 1);
  assert.equal(state.recent[0].mode, 'observe');
  assert.equal(state.recent[0].slots[0].state, 'in-use');

  const status = await readBrowserStatus({ paths, policy });
  assert.equal(status.policy.observe, true);
  assert.equal(status.recent[0].status, 'healthy');
});

test('a report that surfaces attention (e.g. an unreadable slot table) is never called "healthy"', async t => {
  const path = await settingsFile(t, ['| Enabled | `on` |', '| Observe | `on` |']);
  const policy = await loadBrowserChecksPolicy({ settingsPath: path });
  const paths = browserWorkloadPaths(await home(t));
  const report = { slots: [{ slot: null, state: 'error', healthy: false, detail: 'slot table unreadable' }], unhealthy: 1, healthy: false };
  const watchdog = recordingWatchdog(report, 2);
  const result = await runBrowserWorkload({ paths, policy, runWatchdog: watchdog.run });
  assert.equal(result.status, 'attention');
  assert.equal(result.outcome.unhealthy, 1);
});

test('a live lock owned by another run makes this run step aside', async t => {
  const path = await settingsFile(t, ['| Enabled | `on` |', '| Observe | `on` |']);
  const policy = await loadBrowserChecksPolicy({ settingsPath: path });
  const paths = browserWorkloadPaths(await home(t));
  await writeFile(paths.lock, JSON.stringify({ pid: process.pid }), 'utf8');
  const watchdog = recordingWatchdog();
  const result = await runBrowserWorkload({ paths, policy, runWatchdog: watchdog.run });
  assert.equal(result.status, 'busy');
  assert.equal(watchdog.calls.length, 0);
});

// End to end through the REAL browser-watchdog.ps1 with a fixture checker (the
// same shape mutcheck-browser-watchdog.ps1 uses): a read-only status check never
// launches or closes anything, regardless of what state the fixture reports.
const fixtureChecker = `param([switch]$Json, [string]$SettingsPath)
Add-Content -LiteralPath $env:OABW_CALLS -Value 'checked'
ConvertTo-Json -InputObject @([pscustomobject]@{ slot='fixture-slot'; account='fixture'; profile_dir='fixture-dir'; state='in-use'; healthy=$true; detail='fixture' }) -Depth 4
exit 0
`;

test('end to end: Observe runs the checker and reports status; nothing is ever launched',
  { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, async t => {
    const dir = await home(t);
    const checker = join(dir, 'fixture-check.ps1');
    await writeFile(checker, fixtureChecker, 'utf8');
    const paths = { ...browserWorkloadPaths(dir), watchdog: join(here, 'browser-watchdog.ps1') };
    process.env.OABW_CALLS = join(dir, 'calls.txt');
    await writeFile(process.env.OABW_CALLS, '', 'utf8');
    t.after(() => { delete process.env.OABW_CALLS; });

    const result = await runBrowserWorkload({
      paths, policy: { source: 'user-settings', settingsPath: join(dir, 'user-settings.md'), values: { enabled: true, observe: true } },
      extraWatchdogArgs: ['-CheckerPath', checker],
    });
    const calls = await readFile(process.env.OABW_CALLS, 'utf8');
    assert.equal(result.dispatched, true);
    assert.equal(calls.trim(), 'checked');
    assert.equal(result.outcome.slots[0].state, 'in-use');
    assert.equal(result.outcome.status, 'healthy');
  });
