#!/usr/bin/env node
/*
  oa-state.mjs -- the Overnight Agent's state engine, ported from oa-state.ps1 to Node.

  Item 4 of the "one product, two deployments" plan (spec decision: "Overnight Agent engine: the
  Node structure (collect -> plan -> act -> report). The consumer PowerShell guards are ported
  into it, and the consumer checks become its tests"; Refs #124). Zero dependencies, Node 20+.

  THE CONTRACT IS THE GOLDENS. `tests/characterization` pins what oa-state.ps1 observably does --
  exit code, stdout/JSON, stderr message, every file effect -- and runs the same cases here:
      node tests/characterization/run.mjs --impl node --tool oa-state
  Same subcommands, same parameter names (PowerShell-style `-Name value`; `--Name value` and
  `--name=value` work too), same JSON, same exit codes, same environment overrides
  (OVERNIGHT_AGENT_HOME, OVERNIGHT_AGENT_PLANNER_DIR, OA_SANDBOX_ROOT). oa-state.ps1 carries the
  long history of every rule; this file and oa-state-lib/ keep its patterns verbatim.

  Layout (oa-state-lib/), along the target engine structure:
    core/     .NET/PowerShell semantics (regex, strings, DateTime, JSON), files, args, context
    collect/  readers: journals, the board, state files, settings, sessions
    plan/     verdicts: gate, consent, eligibility, scan, extract, session verdicts
    act/      mutations: mark, seed, resnapshot, doc, session bindings
    report/   outputs: critical-tools, the decision record

  Usage: node oa-state.mjs <command> [-Name value ...]
    commands: seed scan get mark resnapshot consent gate extract doc session whoami
              critical-tools decisions
  Exit codes: 0 ok - 1 a refusal or error (message on stderr), as `throw` does in the PowerShell.
*/
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindArgs, BindError } from './oa-state-lib/core/args.mjs';
import { buildContext, assertSandboxPath } from './oa-state-lib/core/context.mjs';
import { toJson, pipeToJson, truncationWarning, psNewlines } from './oa-state-lib/core/psjson.mjs';
import { resolveGateSettings, resolvePacingSettings } from './oa-state-lib/collect/settings.mjs';
import { acquireLock, releaseLock } from './oa-state-lib/core/lock.mjs';
import { COMMAND_TABLE } from './oa-state-lib/commands.mjs';

const EOL = os.EOL;
const writeErr = (s) => fs.writeSync(2, s);

export function makeOutput(write = (s) => fs.writeSync(1, s)) {
  return {
    out(text) { write(`${text}${EOL}`); },
    warn(text) { write(`WARNING: ${text}${EOL}`); },
    // `$obj | ConvertTo-Json [-Depth n] [-Compress]` (pipeline: [] writes nothing, [x] writes x).
    emitJson(value, opts = {}) {
      const r = opts.pipeline === false ? toJson(value, opts) : pipeToJson(value, opts);
      if (!r) return;
      if (r.truncated) write(`${truncationWarning(r.depth)}${EOL}`);
      write(`${psNewlines(r.text)}${EOL}`);
    },
  };
}

export function main(argv, io = makeOutput()) {
  let bound;
  try {
    bound = bindArgs(argv);
  } catch (e) {
    if (e instanceof BindError) { writeErr(`${e.message}${EOL}`); return 1; }
    throw e;
  }
  const ctx = buildContext(bound.values, bound.explicit);
  Object.assign(ctx, io);
  const p = ctx.p;
  const command = String(p.Command).toLowerCase();
  let lock = null;
  try {
    if ((p.CheckDispatch || p.ForDispatch) && command !== 'session') {
      throw new Error('session_flag_command: dispatch checks belong to the session command');
    }
    ctx.DefaultLockWaitSeconds = 180;
    ctx.LockStaleSeconds = 300;
    let lockWaitSeconds = ctx.DefaultLockWaitSeconds;
    if (p.LockWaitSeconds > 0) lockWaitSeconds = p.LockWaitSeconds;
    else if (process.env.OA_STATE_LOCK_WAIT_SECONDS) {
      const n = /^\s*[+-]?\d+\s*$/.test(process.env.OA_STATE_LOCK_WAIT_SECONDS) ? Number(process.env.OA_STATE_LOCK_WAIT_SECONDS) : 0;
      if (n > 0) lockWaitSeconds = n;
    }
    ctx.lockWaitSeconds = lockWaitSeconds;
    if (process.env.OA_SANDBOX_ROOT) {
      for (const [name, value] of [
        ['JournalDir', p.JournalDir], ['StateDir', p.StateDir], ['SessionStateDir', p.SessionStateDir],
        ['PlannerBoard', p.PlannerBoard], ['PlannerCompleted', p.PlannerCompleted],
        ['SnoozeStore', p.SnoozeStore], ['GatePath', p.GatePath], ['RunLedger', p.RunLedger],
        ['CapabilitiesPath', p.CapabilitiesPath], ['McpConfig', p.McpConfig],
        ['UserSettings', ctx.userSettingsPath()], ['ScanOutFile', p.ScanOutFile], ['ScanFile', p.ScanFile],
        ['Observe', p.Observe], ['DocComments', p.DocComments], ['SessionsStatusFile', p.SessionsStatusFile],
        ['SessionWorkspace', p.SessionWorkspace], ['WorkspaceGone', p.WorkspaceGone],
        ['RunWorkspace', p.RunWorkspace]]) {
        assertSandboxPath(value, name);
      }
    }
    if (!['critical-tools', 'decisions'].includes(command)) {
      lock = acquireLock(stateLockPath(p.StateDir), lockWaitSeconds * 1000, {
        timeoutMessage: `state_lock_timeout: another state operation held the lock for the whole ${lockWaitSeconds} s wait; it is stuck, not merely busy`,
        reclaimDeadHolder: true,
      });
    } else if (command === 'decisions') {
      lock = acquireLock(`${p.RunLedger}.lock`, lockWaitSeconds * 1000, {
        timeoutMessage: `ledger_lock_timeout: waited ${lockWaitSeconds} s for ${p.RunLedger}.lock`,
        staleMs: ctx.LockStaleSeconds * 1000,
        mkdir: true,
      });
    }
    resolveGateSettings(ctx);
    resolvePacingSettings(ctx);
    const run = COMMAND_TABLE[command];
    run(ctx);
    return ctx.exitCode ?? 0;
  } catch (e) {
    writeErr(`${e && e.message !== undefined ? e.message : String(e)}${EOL}`);
    if (process.env.OA_STATE_DEBUG) writeErr(`${e?.stack}${EOL}`);
    return 1;
  } finally {
    if (lock) releaseLock(lock);
  }
}

// The state lock is keyed like oa-state.ps1's named mutex (`oa-state-<sha256 of the full,
// case-folded StateDir>`), as a lock FILE in %TEMP%: Node cannot take a Windows named mutex.
export function stateLockPath(stateDir) {
  let full = path.resolve(stateDir).replace(/[\\/]+$/, '');
  if (process.env.OS === 'Windows_NT') full = full.toLowerCase();
  const key = crypto.createHash('sha256').update(full, 'utf8').digest('hex').toUpperCase();
  return path.join(os.tmpdir(), `oa-state-${key}.lock`);
}

const invokedDirectly = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
