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
  '| Slot | Port | Profile dir |',
  '| --- | --- | --- |',
  '| `edge-cdp-1` | 9225 | `edge1` |',
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

function recordingWatchdog(report = { slots: [], launched: 0, repaired: 0, unhealthy: 0, healthy: true }, exitCode = 0) {
  const calls = [];
  const run = async invocation => {
    calls.push(invocation);
    return { exitCode, stdout: JSON.stringify(report), stderr: '', timedOut: false };
  };
  return { calls, run };
}

const has = (plan, flag) => plan.watchdogArgs.includes(flag);

test('browser checks are completely off by default, including observation', async t => {
  assert.deepEqual(BROWSER_CHECKS_DEFAULTS,
    { enabled: false, observe: false, thaw: false, autoLaunch: false, intervalMinutes: 60 });
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
    assert.equal(watchdog.calls.length, 0, 'no browser probe of any kind');
    assert.equal(existsSync(paths.state), false, 'nothing is written while off');
    assert.equal(existsSync(paths.lock), false, 'no lock is taken while off');
  }
});

test('Enabled = off wins over every advanced opt-in', async t => {
  const path = await settingsFile(t, [
    '| Enabled | `off` |', '| Observe | `on` |', '| Thaw stuck slots | `on` |',
    '| Auto-launch closed slots | `on` |',
  ]);
  const policy = await loadBrowserChecksPolicy({ settingsPath: path });
  const watchdog = recordingWatchdog();
  const result = await runBrowserWorkload({ paths: browserWorkloadPaths(await home(t)), policy,
    runWatchdog: watchdog.run });
  assert.equal(result.status, 'disabled');
  assert.equal(watchdog.calls.length, 0);
});

test('Enabled = on alone still runs nothing: every action is its own opt-in', () => {
  const plan = resolveBrowserPlan({ enabled: true });
  assert.equal(plan.dispatch, false);
  assert.equal(plan.reason, 'no-opt-ins');
});

test('Observe alone is a read-only probe that can neither thaw nor launch', () => {
  const plan = resolveBrowserPlan({ enabled: true, observe: true });
  assert.equal(plan.dispatch, true);
  assert.equal(plan.mode, 'observe');
  assert.ok(has(plan, '-ReportOnly'));
  assert.equal(plan.thaw, false);
  assert.equal(plan.autoLaunch, false);
});

test('Thaw alone repairs stuck slots but never launches a closed one', () => {
  const plan = resolveBrowserPlan({ enabled: true, thaw: true });
  assert.equal(plan.mode, 'thaw');
  assert.ok(has(plan, '-NoLaunch'), 'auto-launch is not implied by thaw');
  assert.ok(!has(plan, '-NoRepair'));
  assert.ok(!has(plan, '-ReportOnly'));
});

test('Observe + Thaw still never implies Auto-launch', () => {
  const plan = resolveBrowserPlan({ enabled: true, observe: true, thaw: true });
  assert.ok(has(plan, '-NoLaunch'));
  assert.equal(plan.autoLaunch, false);
});

test('Auto-launch alone launches closed slots but does not thaw', () => {
  const plan = resolveBrowserPlan({ enabled: true, autoLaunch: true });
  assert.equal(plan.mode, 'auto-launch');
  assert.ok(has(plan, '-NoRepair'));
  assert.ok(!has(plan, '-NoLaunch'));
  assert.ok(!has(plan, '-ReportOnly'));
});

test('all opt-ins together allow both actions; host -NoAct can only remove them', () => {
  const all = { enabled: true, observe: true, thaw: true, autoLaunch: true };
  const plan = resolveBrowserPlan(all);
  assert.equal(plan.mode, 'thaw+auto-launch');
  assert.ok(!has(plan, '-NoLaunch') && !has(plan, '-NoRepair') && !has(plan, '-ReportOnly'));

  const reportOnly = resolveBrowserPlan(all, { reportOnly: true });
  assert.ok(has(reportOnly, '-ReportOnly'));
  assert.equal(reportOnly.autoLaunch, false);
  assert.equal(resolveBrowserPlan({}, { reportOnly: true }).dispatch, false,
    'report-only never turns a disabled workload on');
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
    [['| Auto launch | `on` |'], /not a supported setting/],
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
    { mcp: 'edge-cdp-1', port: 9225, state_before: 'stuck', action: 'would-repair', state_after: 'stuck', healthy: false },
    { mcp: 'edge-cdp-2', port: 9226, state_before: 'down', action: 'would-launch', state_after: 'down', healthy: false },
  ], launched: 0, repaired: 0, unhealthy: 2, healthy: false };
  const watchdog = recordingWatchdog(report, 2);
  const nowMs = Date.parse('2026-09-28T08:00:00.000Z');
  const result = await runBrowserWorkload({ paths, policy, runWatchdog: watchdog.run, clock: { now: () => nowMs } });

  assert.equal(result.status, 'attention');
  assert.equal(watchdog.calls.length, 1);
  assert.equal(watchdog.calls[0].script, paths.watchdog);
  const args = watchdog.calls[0].args;
  assert.ok(args.includes('-ReportOnly'));
  assert.equal(args[args.indexOf('-SettingsPath') + 1], path, 'the slot table comes from the same file');
  assert.equal(result.nextEvaluationAt, '2026-09-28T08:30:00.000Z');
  assert.equal(result.outcome.summary, 'attention: 0/2 slot(s) healthy');
  assert.equal(existsSync(paths.lock), false, 'the lock is released');

  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.recent.length, 1);
  assert.equal(state.recent[0].mode, 'observe');

  const status = await readBrowserStatus({ paths, policy });
  assert.equal(status.policy.observe, true);
  assert.equal(status.policy.autoLaunch, false);
  assert.equal(status.recent[0].status, 'attention');
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

// End to end through the REAL browser-watchdog.ps1 with fixture probe/launch
// tools (the same fixtures mutcheck-browser-watchdog.ps1 uses): a closed slot is
// launched only when Auto-launch is on.
const fixtureChecker = `param([switch]$Json, [switch]$Repair, [string]$SettingsPath)
$mode = (Get-Content -LiteralPath $env:OABW_STATE -Raw).Trim()
Add-Content -LiteralPath $env:OABW_CALLS -Value ("check:{0}:{1}" -f $mode, [bool]$Repair)
if ($mode -eq 'healthy') { $state='up'; $healthy=$true } else { $state='down'; $healthy=$false }
@([pscustomobject]@{ port=9999; mcp='fixture-slot'; state=$state; healthy=$healthy; repaired=0; detail=$mode }) | ConvertTo-Json -Depth 4
exit 0
`;
const fixtureEnsure = `param([string]$Slot='all', [string]$SettingsPath)
Add-Content -LiteralPath $env:OABW_CALLS -Value ("ensure:{0}" -f $Slot)
Set-Content -LiteralPath $env:OABW_STATE -Value 'healthy' -NoNewline
exit 0
`;

test('end to end: a closed slot is launched only when Auto-launch is explicitly on',
  { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, async t => {
    const dir = await home(t);
    const checker = join(dir, 'fixture-check.ps1');
    const ensure = join(dir, 'fixture-ensure.ps1');
    await writeFile(checker, fixtureChecker, 'utf8');
    await writeFile(ensure, fixtureEnsure, 'utf8');
    const paths = { ...browserWorkloadPaths(dir), watchdog: join(here, 'browser-watchdog.ps1') };
    const saved = { state: process.env.OABW_STATE, calls: process.env.OABW_CALLS };
    t.after(() => {
      for (const [key, value] of [['OABW_STATE', saved.state], ['OABW_CALLS', saved.calls]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });

    const cases = [
      [{ enabled: true, observe: true }, false],
      [{ enabled: true, thaw: true }, false],
      [{ enabled: true, observe: true, thaw: true }, false],
      [{ enabled: true, autoLaunch: true }, true],
    ];
    for (const [values, expectLaunch] of cases) {
      process.env.OABW_STATE = join(dir, 'state.txt');
      process.env.OABW_CALLS = join(dir, 'calls.txt');
      await writeFile(process.env.OABW_STATE, 'down', 'utf8');
      await writeFile(process.env.OABW_CALLS, '', 'utf8');
      const result = await runBrowserWorkload({
        paths, policy: { source: 'user-settings', settingsPath: join(dir, 'user-settings.md'), values },
        extraWatchdogArgs: ['-CheckerPath', checker, '-EnsurePath', ensure],
      });
      const calls = await readFile(process.env.OABW_CALLS, 'utf8');
      assert.equal(result.dispatched, true);
      assert.equal(/ensure:/.test(calls), expectLaunch,
        `${JSON.stringify(values)} launch=${expectLaunch}; calls: ${calls}`);
      assert.equal(result.outcome.slots[0].action, expectLaunch ? 'launched' : 'would-launch');
    }
  });
