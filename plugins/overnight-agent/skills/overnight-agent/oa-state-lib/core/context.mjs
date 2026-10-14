// context.mjs -- the resolved invocation: every parameter, its default exactly as oa-state.ps1
// binds it, the sandbox overrides, and the helpers that depend on them.
//
// Sandbox mode (tests/e2e) is INERT unless an environment variable is set, as in the PowerShell:
//   OVERNIGHT_AGENT_HOME        replaces %LOCALAPPDATA%\overnight-agent in unbound defaults
//   OVERNIGHT_AGENT_PLANNER_DIR replaces %USERPROFILE%\OneDrive\Apps\Focus Planner likewise
//   OA_SANDBOX_ROOT             tripwire: any resolved path outside it is a hard error
//   COPILOT_HOME (with OA_SANDBOX_ROOT) replaces ~/.copilot for SessionStateDir / McpConfig
// An explicitly passed parameter always wins over an override, and is still tripwired.
import os from 'node:os';
import path from 'node:path';
import { testPath } from './fsx.mjs';
import { lowerInvariant } from './net.mjs';

export const IS_WIN = process.platform === 'win32';
export const SEP = IS_WIN ? '\\' : '/';

// Join-Path on the FileSystem provider: separators normalised, exactly one between the parts.
export function joinPath(a, b) {
  const norm = (s) => (IS_WIN ? String(s).replace(/\//g, '\\') : String(s));
  const left = norm(a);
  const right = norm(b);
  if (!left) return right;
  return left.replace(/[\\/]+$/, '') + SEP + right.replace(/^[\\/]+/, '');
}

// Split-Path -Parent
export function splitParent(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return '';
  const parent = s.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return parent + '\\';
  return parent;
}

// [Environment]::ExpandEnvironmentVariables
export function expandEnv(s) {
  return String(s).replace(/%([^%]+)%/g, (all, name) => {
    const k = Object.keys(process.env).find((x) => x.toLowerCase() === name.toLowerCase());
    return k !== undefined ? process.env[k] : all;
  });
}

// GetUnresolvedProviderPathFromPSPath: absolute against the current location, `..` collapsed.
export function fullPath(p) {
  return path.resolve(expandEnv(p));
}

// PowerShell's $HOME: the account's profile folder from the OS, not $env:USERPROFILE.
function psHome() {
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

const env = (k) => process.env[k] ?? '';

export function buildContext(values, explicit) {
  const v = { ...values };
  const bound = (k) => explicit.has(k);
  const LAD = env('LOCALAPPDATA');
  const UP = env('USERPROFILE');
  const HOME = psHome();
  const fp = `${UP}\\OneDrive\\Apps\\Focus Planner`;
  const defaults = {
    RunLedger: `${LAD}\\overnight-agent\\run-ledger.jsonl`,
    CapabilitiesPath: `${LAD}\\overnight-agent\\capabilities.json`,
    JournalDir: `${fp}\\journal`,
    StateDir: `${LAD}\\overnight-agent\\state`,
    SessionStateDir: `${HOME}/.copilot/session-state`,
    PlannerBoard: `${fp}\\planner.md`,
    PlannerCompleted: `${fp}\\planner-completed.md`,
    SnoozeStore: `${fp}\\snooze.json`,
    GatePath: `${fp}\\agent-gate.md`,
    McpConfig: joinPath(HOME, '.copilot/mcp-config.json'),
  };
  for (const [k, d] of Object.entries(defaults)) if (!bound(k)) v[k] = d;
  if (env('OVERNIGHT_AGENT_HOME')) {
    const h = env('OVERNIGHT_AGENT_HOME');
    if (!bound('StateDir')) v.StateDir = joinPath(h, 'state');
    if (!bound('RunLedger')) v.RunLedger = joinPath(h, 'run-ledger.jsonl');
    if (!bound('CapabilitiesPath')) v.CapabilitiesPath = joinPath(h, 'capabilities.json');
  }
  if (env('OVERNIGHT_AGENT_PLANNER_DIR')) {
    const pd = env('OVERNIGHT_AGENT_PLANNER_DIR');
    if (!bound('JournalDir')) v.JournalDir = joinPath(pd, 'journal');
    if (!bound('PlannerBoard')) v.PlannerBoard = joinPath(pd, 'planner.md');
    if (!bound('PlannerCompleted')) v.PlannerCompleted = joinPath(pd, 'planner-completed.md');
    if (!bound('SnoozeStore')) v.SnoozeStore = joinPath(pd, 'snooze.json');
    if (!bound('GatePath')) v.GatePath = joinPath(pd, 'agent-gate.md');
  }
  if (env('OA_SANDBOX_ROOT') && env('COPILOT_HOME')) {
    if (!bound('SessionStateDir')) v.SessionStateDir = joinPath(env('COPILOT_HOME'), 'session-state');
    if (!bound('McpConfig')) v.McpConfig = joinPath(env('COPILOT_HOME'), 'mcp-config.json');
  }
  const ctx = { p: v, explicit, cwd: process.cwd() };

  // The resolution order SKILL.md documents, first hit wins (Get-UserSettingsPath).
  ctx.userSettingsPath = () => {
    if (v.UserSettings) return v.UserSettings;
    const candidates = [
      env('OVERNIGHT_AGENT_SETTINGS'),
      joinPath(process.cwd(), 'user-settings.md'),
      joinPath(splitParent(v.PlannerBoard), 'user-settings.md'),
      env('OVERNIGHT_AGENT_PLANNER_DIR') ? joinPath(env('OVERNIGHT_AGENT_PLANNER_DIR'), 'user-settings.md') : `${UP}\\OneDrive\\Apps\\Focus Planner\\user-settings.md`,
      env('OVERNIGHT_AGENT_HOME') ? joinPath(env('OVERNIGHT_AGENT_HOME'), 'user-settings.md') : `${LAD}\\overnight-agent\\user-settings.md`,
    ];
    for (const c of candidates) if (c && testPath(c)) return c;
    return null;
  };
  return ctx;
}

export class SandboxViolation extends Error {}

export function assertSandboxPath(p, what) {
  const rootRaw = env('OA_SANDBOX_ROOT');
  if (!rootRaw || !p) return;
  const root = fullPath(rootRaw).replace(/[\\/]+$/, '');
  const full = fullPath(p).replace(/[\\/]+$/, '');
  const inside = lowerInvariant(full) === lowerInvariant(root) || lowerInvariant(full).startsWith(lowerInvariant(root) + path.sep);
  if (!inside) throw new SandboxViolation(`oa_sandbox_violation: ${what} '${full}' is outside OA_SANDBOX_ROOT '${root}'`);
}
