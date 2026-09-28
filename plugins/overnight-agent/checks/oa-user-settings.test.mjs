import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadReliabilityPolicy, parseReliabilityPolicy, readSettingsSection,
  RELIABILITY_DEFAULTS, RELIABILITY_SECTION_HEADING, resolveUserSettingsPath,
  userSettingsPathCandidates,
} from './oa-user-settings.mjs';
import {
  applyReliabilityPolicy, readSupervisorStatus, reconcileConsumerConfig, supervisorPaths,
} from './consumer-reliability-supervisor.mjs';
import { DEFAULT_CONFIG } from './reliability-supervisor.mjs';

const section = rows => [
  '# Overnight Agent — user settings',
  '',
  '## Telegram (optional)',
  '',
  '| Setting | Value |',
  '| --- | --- |',
  '| Enabled | `off` |',
  '',
  `## ${RELIABILITY_SECTION_HEADING}`,
  '',
  '| Setting | Value |',
  '| --- | --- |',
  ...rows,
  '',
  '## Browser slots',
  '',
  '| Slot | Port |',
  '| --- | --- |',
  '| `edge-cdp-1` | 9225 |',
].join('\n');

async function settingsFile(t, text, name = 'user-settings.md') {
  const dir = await mkdtemp(join(tmpdir(), 'oa-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return { dir, path };
}

test('a missing file and a missing section both mean the shipped product defaults', async t => {
  const { dir, path } = await settingsFile(t, '# Overnight Agent\n\n## Preferences\n\n- Inbox check: `on`\n');
  const present = await loadReliabilityPolicy({ settingsPath: path });
  assert.equal(present.source, 'defaults');
  assert.deepEqual(present.values, {});

  const absent = await loadReliabilityPolicy({ settingsPath: join(dir, 'nope.md') });
  assert.equal(absent.source, 'defaults');
  assert.deepEqual(absent.values, {});

  const nothingResolves = await loadReliabilityPolicy({ env: {} });
  assert.equal(nothingResolves.settingsPath, null);
  assert.deepEqual(nothingResolves.values, {});

  // And the defaults the product ships are the ones the engine ships.
  assert.equal(RELIABILITY_DEFAULTS.targetIntervalHours, DEFAULT_CONFIG.preventiveRestart.targetIntervalHours);
  assert.equal(RELIABILITY_DEFAULTS.hardIntervalHours, DEFAULT_CONFIG.preventiveRestart.hardIntervalHours);
  assert.equal(RELIABILITY_DEFAULTS.quietWindowMinutes, DEFAULT_CONFIG.preventiveRestart.quietWindowMinutes);
  assert.equal(RELIABILITY_DEFAULTS.cooldownMinutes, DEFAULT_CONFIG.appRestart.minIntervalMinutes);
  assert.equal(RELIABILITY_DEFAULTS.enabled, DEFAULT_CONFIG.supervisor.enabled);
});

test('every declared row is read, in whatever unit and prose the user wrote it in', async t => {
  const { path } = await settingsFile(t, section([
    '| Enabled | `on` — supervise the desktop app |',
    '| Quiet opportunity (M) | `5h` — earliest preventive restart |',
    '| Hard deadline (N) | `480m` — restart regardless of evidence |',
    '| **Quiet window** | `20` — minutes of continuous quiet |',
    '| Restart cooldown | `90m` |',
  ]));
  const policy = await loadReliabilityPolicy({ settingsPath: path });
  assert.equal(policy.source, 'user-settings');
  assert.deepEqual(policy.values, {
    enabled: true, targetIntervalHours: 5, hardIntervalHours: 8,
    quietWindowMinutes: 20, cooldownMinutes: 90,
  });
  assert.equal(policy.settingsPath, path);
});

test('only the declared rows are reported, so an absent row stays absent', async t => {
  const { path } = await settingsFile(t, section(['| Quiet opportunity (M) | `6h` |']));
  const policy = await loadReliabilityPolicy({ settingsPath: path });
  assert.deepEqual(policy.values, { targetIntervalHours: 6 });

  const off = parseReliabilityPolicy(section(['| Enabled | `off` |']));
  assert.deepEqual(off.values, { enabled: false });

  const empty = parseReliabilityPolicy(section([]));
  assert.equal(empty.source, 'user-settings-empty');
  assert.deepEqual(empty.values, {});
});

test('a value that cannot be read is refused by name, never guessed at', () => {
  const cases = [
    [['| Enabled | `sometimes` |'], /must be 'on' or 'off'/],
    [['| Quiet opportunity (M) | `soon` |'], /must be a duration/],
    [['| Quiet opportunity (M) | `0m` |'], /must be from/],
    [['| Restart cooldown | `3000m` |'], /must be from/],
    [['| Quiet window | `1m` |'], /must be from 5 to 240 minutes/],
    [['| Quiet opportunity (M) | `4h` |', '| Hard deadline (N) | `3h` |'], /must exceed/],
    [['| Quiet window | `20m` |', '| Quiet window | `30m` |'], /declared twice/],
    [['| Quiet opportunty | `20m` |'], /not a supported setting/],
  ];
  for (const [rows, expected] of cases) {
    assert.throws(() => parseReliabilityPolicy(section(rows), { settingsPath: 'X.md' }), expected,
      `expected ${expected} for ${rows.join(' ')}`);
  }
  // The refusal names the file, so a user can find the row they mistyped.
  assert.throws(() => parseReliabilityPolicy(section(['| Enabled | `maybe` |']), { settingsPath: 'X.md' }),
    /X\.md/);
});

test('the section reader ignores the other workloads sharing the file', () => {
  const rows = readSettingsSection(section(['| Enabled | `off` |']), RELIABILITY_SECTION_HEADING);
  assert.deepEqual(rows.map(row => row.name), ['enabled']);
  assert.equal(readSettingsSection(section([]), 'Update check'), null);
  // A later workload reads its own sibling section with the same reader.
  const sibling = '## Tray update check\n\n| Setting | Value |\n| --- | --- |\n| Enabled | `off` |\n';
  assert.deepEqual(readSettingsSection(sibling, 'Tray update check').map(row => row.value), ['off']);
});

test('resolution prefers the external copy and skips the template shipped in the plugin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'oa-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = join(root, 'skill');
  const oneDrive = join(root, 'OneDrive');
  await mkdir(skill, { recursive: true });
  await mkdir(join(oneDrive, 'Apps', 'Focus Planner'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# skill', 'utf8');
  await writeFile(join(skill, 'user-settings.md'), section(['| Enabled | `off` |']), 'utf8');
  await writeFile(join(oneDrive, 'Apps', 'Focus Planner', 'user-settings.md'),
    section(['| Enabled | `on` |']), 'utf8');

  const env = { OneDrive: oneDrive };
  const resolved = await resolveUserSettingsPath({ env, cwd: skill });
  assert.equal(resolved.path, join(oneDrive, 'Apps', 'Focus Planner', 'user-settings.md'));
  assert.deepEqual(resolved.skippedTemplate, [join(skill, 'user-settings.md')]);
  assert.deepEqual((await loadReliabilityPolicy({ env, cwd: skill })).values, { enabled: true });

  // An explicit override is an instruction, not a guess: it wins even there.
  const override = { OVERNIGHT_AGENT_SETTINGS: join(skill, 'user-settings.md'), OneDrive: oneDrive };
  assert.equal((await resolveUserSettingsPath({ env: override })).path, override.OVERNIGHT_AGENT_SETTINGS);

  assert.deepEqual(userSettingsPathCandidates({
    env: { OVERNIGHT_AGENT_SETTINGS: 'X.md', PLANNER_PATH: 'P', OneDrive: 'O', LOCALAPPDATA: 'L' },
  }), ['X.md', join('P', 'user-settings.md'), join('O', 'Apps', 'Focus Planner', 'user-settings.md'),
    join('L', 'overnight-agent', 'user-settings.md')]);
});

test('the policy overlays only the user-facing knobs and re-derives an undeclared N', () => {
  const machine = { ...DEFAULT_CONFIG, supervisor: { ...DEFAULT_CONFIG.supervisor, inputPath: 'S.json' } };
  const raised = applyReliabilityPolicy(machine, { targetIntervalHours: 5 });
  assert.equal(raised.preventiveRestart.targetIntervalHours, 5);
  assert.equal(raised.preventiveRestart.hardIntervalHours, 7, 'N derives from the M the user raised');
  assert.equal(raised.supervisor.inputPath, 'S.json', 'machine-owned keys survive');

  const declared = applyReliabilityPolicy(machine,
    { enabled: false, targetIntervalHours: 2, hardIntervalHours: 3, quietWindowMinutes: 30, cooldownMinutes: 45 });
  assert.equal(declared.supervisor.enabled, false);
  assert.equal(declared.preventiveRestart.hardIntervalHours, 3);
  assert.equal(declared.preventiveRestart.quietWindowMinutes, 30);
  assert.equal(declared.appRestart.minIntervalMinutes, 45);

  // A knob withdrawn from user-settings returns to the product default rather
  // than keeping whatever the derived JSON still held.
  const withdrawn = applyReliabilityPolicy(declared, {});
  assert.deepEqual(
    [withdrawn.supervisor.enabled, withdrawn.preventiveRestart.targetIntervalHours,
      withdrawn.preventiveRestart.hardIntervalHours, withdrawn.preventiveRestart.quietWindowMinutes,
      withdrawn.appRestart.minIntervalMinutes],
    [RELIABILITY_DEFAULTS.enabled, RELIABILITY_DEFAULTS.targetIntervalHours,
      RELIABILITY_DEFAULTS.hardIntervalHours, RELIABILITY_DEFAULTS.quietWindowMinutes,
      RELIABILITY_DEFAULTS.cooldownMinutes]);
});

test('the machine config is derived from user-settings on every reconcile', async t => {
  const home = await mkdtemp(join(tmpdir(), 'oa-reconcile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = supervisorPaths(home);
  const policy = { source: 'user-settings', settingsPath: 'U.md',
    values: { enabled: false, targetIntervalHours: 2, quietWindowMinutes: 25, cooldownMinutes: 30 } };

  const config = await reconcileConsumerConfig(paths, { policy });
  assert.equal(config.supervisor.enabled, false);
  assert.equal(config.preventiveRestart.targetIntervalHours, 2);
  assert.equal(config.preventiveRestart.quietWindowMinutes, 25);
  assert.equal(config.appRestart.minIntervalMinutes, 30);
  assert.ok(config.commands.snapshot.args.includes('--session-store'), 'machine wiring still applied');

  // Editing the derived JSON does not survive: user-settings is canonical.
  const reverted = await reconcileConsumerConfig(paths, {
    policy: { source: 'defaults', settingsPath: null, values: {} },
  });
  assert.equal(reverted.supervisor.enabled, RELIABILITY_DEFAULTS.enabled);
  assert.equal(reverted.preventiveRestart.targetIntervalHours, RELIABILITY_DEFAULTS.targetIntervalHours);
  assert.equal(reverted.appRestart.minIntervalMinutes, RELIABILITY_DEFAULTS.cooldownMinutes);
});

test('tray status reports the canonical policy, its source, and a refusal it cannot read', async t => {
  const home = await mkdtemp(join(tmpdir(), 'oa-status-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = supervisorPaths(home);
  const clock = { now: () => Date.parse('2026-09-27T00:00:00.000Z') };

  const declared = await settingsFile(t, section([
    '| Enabled | `on` |', '| Quiet opportunity (M) | `2h` |', '| Restart cooldown | `30m` |',
  ]));
  const status = await readSupervisorStatus({ paths, clock,
    policy: await loadReliabilityPolicy({ settingsPath: declared.path }) });
  assert.equal(status.policy.valid, true);
  assert.equal(status.policy.source, 'user-settings');
  assert.equal(status.policy.settingsPath, declared.path);
  assert.equal(status.policy.quietOpportunityHours, 2);
  assert.equal(status.policy.cooldownMinutes, 30);
  assert.equal(status.policy.hardDeadlineHours, RELIABILITY_DEFAULTS.hardIntervalHours);

  const missing = await readSupervisorStatus({ paths, clock,
    policy: { source: 'defaults', settingsPath: null, values: {} } });
  assert.equal(missing.policy.source, 'defaults');
  assert.equal(missing.policy.quietOpportunityHours, RELIABILITY_DEFAULTS.targetIntervalHours);

  const broken = await readSupervisorStatus({ paths, clock,
    policy: { source: 'user-settings', settingsPath: 'U.md', values: { quietWindowMinutes: 2 } } });
  assert.equal(broken.policy.valid, false);
  assert.equal(broken.policy.enabled, false, 'an unreadable policy never reads as enabled');
  assert.match(broken.policy.error, /quietWindowMinutes/);
});
