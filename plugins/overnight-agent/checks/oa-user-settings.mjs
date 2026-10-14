import { settingsValue } from './settings-value.mjs';

/*
 * oa-user-settings.mjs -- the ONE reader for tray-workload policy in the
 * EXTERNAL `user-settings.md` (GH #696).
 *
 * WHY THIS EXISTS
 * ---------------
 * The tray host (oa-supervisor-tray.ps1) runs independent workloads. Each one
 * has its own policy, and a user must be able to read and change that policy in
 * ONE user-facing place -- the external `user-settings.md` that already carries
 * every other Overnight Agent setting, and that plugin updates never overwrite.
 *
 * Before this file, the reliability workload's M/N/quiet/cooldown/enabled policy
 * lived only in `%LOCALAPPDATA%\overnight-agent\reliability-supervisor.json`, a
 * machine-managed file the user was never told about. That file is now DERIVED:
 * it is rewritten from this reader on every reconcile, so editing it by hand has
 * no lasting effect. `user-settings.md` is canonical.
 *
 * ONE HOST, MANY WORKLOADS, SIBLING SECTIONS
 * ------------------------------------------
 * Each workload owns its own H2 section with a two-column `| Setting | Value |`
 * table. The reliability workload's section is `## Tray reliability supervision`;
 * the browser-check workload's is `## Tray browser checks` (GH #698); the plugin
 * update-check workload's is `## Tray update checks` (GH #701). Each is a
 * SIBLING section with its own value map -- none extends another, because
 * separate workloads must have separate, independently-missing policies.
 *
 * MISSING IS NOT BROKEN; WRONG IS BROKEN
 * --------------------------------------
 * A missing file or a missing section means the user has expressed no opinion,
 * so the shipped product defaults apply (M=3h, N=4h, quiet=15m, cooldown=60m,
 * enabled). A section that IS present but carries a value that cannot be read --
 * a typo'd row name, `soon`, `-1`, `off-ish` -- is an expressed opinion that
 * cannot be honoured, so it THROWS, naming the row, the file and the accepted
 * values. Supervision then refuses to act rather than acting on a guess.
 *
 * The bundled `skills/overnight-agent/user-settings.md` is a TEMPLATE, not user
 * data: a candidate sitting next to a `SKILL.md` is skipped, exactly as
 * browser-slot-table.ps1 skips it.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const RELIABILITY_SECTION_HEADING = 'Tray reliability supervision';

// The shipped product defaults, stated once. These mirror DEFAULT_CONFIG in
// reliability-supervisor.mjs and are what a missing section means.
export const RELIABILITY_DEFAULTS = Object.freeze({
  enabled: true,
  targetIntervalHours: 3,
  hardIntervalHours: 4,
  quietWindowMinutes: 15,
  cooldownMinutes: 60,
});

// Row name (normalized) -> how to read it. Adding a workload means adding a new
// map like this one plus its own heading, never a new row here.
const RELIABILITY_ROWS = new Map([
  ['enabled', { key: 'enabled', kind: 'switch' }],
  ['quiet opportunity m', { key: 'targetIntervalHours', kind: 'hours', min: 1 / 60, max: 168 }],
  ['hard deadline n', { key: 'hardIntervalHours', kind: 'hours', min: 1, max: 170 }],
  ['quiet window', { key: 'quietWindowMinutes', kind: 'minutes', min: 5, max: 240 }],
  ['restart cooldown', { key: 'cooldownMinutes', kind: 'minutes', min: 1, max: 1440 }],
]);

// The browser-check workload (GH #698, simplified by GH #738) is a SIBLING
// section with its own map. Everything is OFF by default -- including
// observation. Nothing here shares a row, a default or a state file with the
// reliability workload above.
//
// GH #738 removed `Thaw stuck slots` and `Auto-launch closed slots`: each
// Playwright MCP server now launches its own profile directly and closes with
// the session that opened it, so there is no shared slot left for a tray
// workload to launch or thaw on anyone's behalf. `Observe` is the only action,
// and it is strictly read-only (see check-browser-slots.ps1).
export const BROWSER_CHECKS_SECTION_HEADING = 'Tray browser checks';

export const BROWSER_CHECKS_DEFAULTS = Object.freeze({
  enabled: false,
  observe: false,
  intervalMinutes: 60,
});

const BROWSER_CHECKS_ROWS = new Map([
  ['enabled', { key: 'enabled', kind: 'switch' }],
  ['observe', { key: 'observe', kind: 'switch' }],
  ['check interval', { key: 'intervalMinutes', kind: 'minutes', min: 15, max: 1440 }],
]);

// The plugin update-check workload (GH #701) is another SIBLING section. It is ON
// by default and checks DAILY, but it only REPORTS an available update unless the
// user opts in to `Auto apply`. The only source is the Copilot plugin marketplace.
export const UPDATE_CHECKS_SECTION_HEADING = 'Tray update checks';

export const UPDATE_CHECKS_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMinutes: 1440,
  autoApply: false,
  source: 'marketplace',
});

const UPDATE_CHECKS_ROWS = new Map([
  ['enabled', { key: 'enabled', kind: 'switch' }],
  ['check interval', { key: 'intervalMinutes', kind: 'cadence', min: 60, max: 10080 }],
  ['auto apply', { key: 'autoApply', kind: 'switch' }],
  ['source', { key: 'source', kind: 'choice', values: ['marketplace'] }],
]);

const NAMED_CADENCES = new Map([['hourly', 60], ['daily', 1440], ['weekly', 10080]]);

function normalizeName(text) {
  return String(text)
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function plainCell(cell) {
  return String(cell ?? '')
    .replace(/`/g, '')
    .replace(/\*\*|\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

/** Every `| Setting | Value |` row under `## <heading>`, in file order. */
export function readSettingsSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex(line =>
    new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const rows = [];
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) continue;
    if (isSeparatorRow(line)) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    const name = normalizeName(cells[0]);
    if (!name || name === 'setting') continue;
    rows.push({ name, value: settingsValue(cells[1]), rawName: plainCell(cells[0]), rawValue: cells[1] });
  }
  return rows;
}

function readSwitch(token, context) {
  const value = String(token).toLowerCase();
  if (['on', 'yes', 'true', 'enabled'].includes(value)) return true;
  if (['off', 'no', 'false', 'disabled'].includes(value)) return false;
  throw new Error(`${context} must be 'on' or 'off' (read: '${token}')`);
}

function readDuration(token, { unit, min, max }, context) {
  const match = String(token).match(/^([0-9]+(?:\.[0-9]+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/i);
  if (!match) {
    throw new Error(
      `${context} must be a duration such as '3h' or '90m' (read: '${token}')`);
  }
  const amount = Number(match[1]);
  const suffix = (match[2] ?? '').toLowerCase();
  const inHours = suffix.startsWith('h') || (suffix === '' && unit === 'hours');
  const hours = inHours ? amount : amount / 60;
  const value = unit === 'hours' ? hours : hours * 60;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `${context} must be from ${min} to ${max} ${unit} (read: '${token}')`);
  }
  return value;
}

// `hourly` / `daily` / `weekly`, or any duration in range ('6h', '90m').
function readCadence(token, { min, max }, context) {
  const named = NAMED_CADENCES.get(String(token).trim().toLowerCase());
  if (named !== undefined) return named;
  try {
    return readDuration(token, { unit: 'minutes', min, max }, context);
  } catch {
    throw new Error(
      `${context} must be 'hourly', 'daily', 'weekly' or a duration from ${min} to ${max} minutes ` +
      `such as '6h' (read: '${token}')`);
  }
}

function readChoice(token, { values }, context) {
  const value = String(token).trim().toLowerCase();
  if (values.includes(value)) return value;
  throw new Error(`${context} must be one of: ${values.join(', ')} (read: '${token}')`);
}

function readValue(spec, token, context) {
  if (spec.kind === 'switch') return readSwitch(token, context);
  if (spec.kind === 'cadence') return readCadence(token, spec, context);
  if (spec.kind === 'choice') return readChoice(token, spec, context);
  return readDuration(token, { unit: spec.kind, min: spec.min, max: spec.max }, context);
}

/**
 * One workload's declared rows under `## <heading>`, read against that workload's
 * own row map. Shared by every workload so there is one parser, never a copy.
 */
export function parseSectionPolicy(text, heading, rowSpecs, { settingsPath = '(memory)' } = {}) {
  const rows = readSettingsSection(text, heading);
  if (rows === null) return { source: 'defaults', settingsPath, values: {} };
  const values = {};
  for (const row of rows) {
    const spec = rowSpecs.get(row.name);
    const context = `'${row.rawName}' in '## ${heading}' (${settingsPath})`;
    if (!spec) {
      throw new Error(
        `${context} is not a supported setting. Supported: ` +
        `${[...rowSpecs.keys()].join(', ')}.`);
    }
    if (Object.hasOwn(values, spec.key)) {
      throw new Error(`${context} is declared twice; keep one row per setting.`);
    }
    values[spec.key] = readValue(spec, row.value, context);
  }
  return { source: Object.keys(values).length ? 'user-settings' : 'user-settings-empty', settingsPath, values };
}

/**
 * Declared reliability policy: only the rows the user actually wrote. An absent
 * row is absent from the result, so the caller can tell "user chose the default"
 * from "user chose nothing" -- which is what lets N derive from a raised M.
 */
export function parseReliabilityPolicy(text, { settingsPath = '(memory)' } = {}) {
  const parsed = parseSectionPolicy(text, RELIABILITY_SECTION_HEADING, RELIABILITY_ROWS, { settingsPath });
  const { values } = parsed;
  if (values.hardIntervalHours !== undefined && values.targetIntervalHours !== undefined &&
      values.hardIntervalHours <= values.targetIntervalHours) {
    throw new Error(
      `'Hard deadline (N)' must exceed 'Quiet opportunity (M)' in '## ${RELIABILITY_SECTION_HEADING}' ` +
      `(${settingsPath}): read N=${values.hardIntervalHours}h, M=${values.targetIntervalHours}h.`);
  }
  return parsed;
}

/**
 * Declared browser-check policy (GH #698): only the rows the user wrote. Every
 * switch is OFF when absent, and `Auto-launch closed slots` is never implied by
 * any other row -- see resolveBrowserPlan in consumer-browser-watchdog.mjs.
 */
export function parseBrowserChecksPolicy(text, { settingsPath = '(memory)' } = {}) {
  return parseSectionPolicy(text, BROWSER_CHECKS_SECTION_HEADING, BROWSER_CHECKS_ROWS, { settingsPath });
}

/**
 * Declared plugin update-check policy (GH #701): only the rows the user wrote.
 * Absent rows take UPDATE_CHECKS_DEFAULTS (on, daily, report-only, marketplace).
 */
export function parseUpdateChecksPolicy(text, { settingsPath = '(memory)' } = {}) {
  return parseSectionPolicy(text, UPDATE_CHECKS_SECTION_HEADING, UPDATE_CHECKS_ROWS, { settingsPath });
}

/**
 * The candidate order SKILL.md documents, in one place. The user's OneDrive path
 * is composed from %OneDrive% rather than hardcoded, so this works on any machine.
 */
export function userSettingsPathCandidates({
  env = process.env, projectFolder = null, cwd = null,
} = {}) {
  const candidates = [];
  const add = value => { if (value && String(value).trim()) candidates.push(value); };
  add(env.OVERNIGHT_AGENT_SETTINGS);
  const project = projectFolder ?? env.PLANNER_PATH;
  if (project) add(join(project, 'user-settings.md'));
  if (cwd) add(join(cwd, 'user-settings.md'));
  for (const root of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]) {
    if (root) add(join(root, 'Apps', 'Focus Planner', 'user-settings.md'));
  }
  if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'overnight-agent', 'user-settings.md'));
  return candidates;
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function resolveUserSettingsPath(options = {}) {
  const env = options.env ?? process.env;
  const tried = userSettingsPathCandidates(options);
  const skippedTemplate = [];
  for (const candidate of tried) {
    if (!(await isFile(candidate))) continue;
    // A `user-settings.md` next to a `SKILL.md` is the template shipped INSIDE
    // the plugin. It carries placeholders, not user data. An explicit override
    // still wins: naming a path outright is an instruction, not a guess.
    if (candidate !== env.OVERNIGHT_AGENT_SETTINGS &&
        await isFile(join(candidate, '..', 'SKILL.md'))) {
      skippedTemplate.push(candidate);
      continue;
    }
    return { path: candidate, tried, skippedTemplate };
  }
  return { path: null, tried, skippedTemplate };
}

/**
 * Canonical reliability policy for the tray workload. A missing file or missing
 * section yields `{ source: 'defaults', values: {} }` -- never an error.
 */
export async function loadReliabilityPolicy(options = {}) {
  return loadSectionPolicy(parseReliabilityPolicy, options);
}

/**
 * Canonical browser-check policy for the tray workload (GH #698). A missing file
 * or section means every switch is off -- no browser is probed at all.
 */
export async function loadBrowserChecksPolicy(options = {}) {
  return loadSectionPolicy(parseBrowserChecksPolicy, options);
}

/**
 * Canonical update-check policy for the tray workload (GH #701). A missing file
 * or section means the shipped defaults: check daily, report only.
 */
export async function loadUpdateChecksPolicy(options = {}) {
  return loadSectionPolicy(parseUpdateChecksPolicy, options);
}

async function loadSectionPolicy(parse, options = {}) {
  const resolved = options.settingsPath
    ? { path: options.settingsPath, tried: [options.settingsPath], skippedTemplate: [] }
    : await resolveUserSettingsPath(options);
  if (!resolved.path) {
    return { source: 'defaults', settingsPath: null, values: {}, tried: resolved.tried };
  }
  let text;
  try {
    text = await readFile(resolved.path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { source: 'defaults', settingsPath: null, values: {}, tried: resolved.tried };
    }
    throw error;
  }
  return {
    ...parse(text.replace(/^\uFEFF/, ''), { settingsPath: resolved.path }),
    tried: resolved.tried,
  };
}
