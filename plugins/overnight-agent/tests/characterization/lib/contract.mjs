// The command contract every implementation is driven through.
//
// A case names a TOOL (`oa-state` | `write-turn`), a COMMAND (the oa-state subcommand; unused for
// write-turn) and NAMED ARGUMENTS using the PowerShell parameter names, which are the public CLI
// contract of today's scripts. The harness supplies the sandbox paths below so that no case can
// reach the owner's live data by accident: every path-typed parameter defaults to the sandbox.
//
// Argument values:  string (placeholders expanded) | number | true (switch) | false/null (omit)
//                   | [single string]  (a one-element string[])
// Placeholders:     {root} {data} {journal} {home} {state} {cwd} {input}
import path from 'node:path';
import { LAYOUT } from './fixture.mjs';

export function sandboxDirs(root) {
  return {
    root,
    data: path.join(root, LAYOUT.data),
    journal: path.join(root, LAYOUT.data, 'journal'),
    home: path.join(root, LAYOUT.home),
    state: path.join(root, LAYOUT.state),
    cwd: path.join(root, 'cwd'),
    input: path.join(root, 'input'),
    tmp: path.join(root, 'tmp'),
  };
}

export function defaultArgs(tool, dirs) {
  const j = (...p) => path.join(...p);
  if (tool === 'oa-state') {
    return {
      JournalDir: dirs.journal,
      StateDir: dirs.state,
      PlannerBoard: j(dirs.data, 'planner.md'),
      PlannerCompleted: j(dirs.data, 'planner-completed.md'),
      SnoozeStore: j(dirs.data, 'snooze.json'),
      GatePath: j(dirs.data, 'agent-gate.md'),
      UserSettings: j(dirs.data, 'user-settings.md'),
      SessionStateDir: j(dirs.home, 'session-state'),
      CapabilitiesPath: j(dirs.home, 'capabilities.json'),
      RunLedger: j(dirs.home, 'run-ledger.jsonl'),
      McpConfig: j(dirs.home, 'mcp-config.json'),
    };
  }
  if (tool === 'write-turn') return { JournalDir: dirs.journal };
  throw new Error(`unknown tool '${tool}'`);
}

export function expandPlaceholders(s, dirs) {
  return String(s).replace(/\{(root|data|journal|home|state|cwd|input)\}/g, (_, k) => dirs[k]);
}

export function resolveArgs(tool, caseArgs, dirs, { noDefaults = false } = {}) {
  const merged = { ...(noDefaults ? {} : defaultArgs(tool, dirs)), ...(caseArgs || {}) };
  const out = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v === null || v === false || v === undefined) continue;
    if (Array.isArray(v)) out[k] = v.map((x) => expandPlaceholders(x, dirs));
    else if (typeof v === 'string') out[k] = expandPlaceholders(v, dirs);
    else out[k] = v;
  }
  return out;
}

// The environment every implementation runs under. Built from an allow-list rather than
// inherited, so a developer's own session (COPILOT_AGENT_SESSION_ID, OVERNIGHT_AGENT_SETTINGS,
// OneDrive paths, ...) can never leak into a golden.
const PASS_THROUGH = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'SystemDrive',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'ProgramData', 'LANG', 'TZ', 'DOTNET_ROOT'];

export function baseEnv(dirs, stubsDir) {
  const env = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    LOCALAPPDATA: path.dirname(dirs.home),
    APPDATA: path.join(dirs.root, 'profile', 'AppData', 'Roaming'),
    USERPROFILE: path.join(dirs.root, 'profile'),
    HOME: path.join(dirs.root, 'profile'),
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    TMPDIR: dirs.tmp,
    NO_COLOR: '1',
    TERM: 'dumb',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    // write-turn's two hermetic hooks: its backup/state home, and the G15 shipped-issue classifier
    // (stubbed so the verdict never depends on git or the network).
    WRITE_TURN_OA_HOME: dirs.home,
    WRITE_TURN_ISSUE_RESOLVER: path.join(stubsDir, 'issue-shipped.stub.mjs'),
    // The identity stamp names the writing host; pinned so goldens do not depend on the machine.
    WRITE_TURN_HOST: 'char-host',
  });
  return env;
}
