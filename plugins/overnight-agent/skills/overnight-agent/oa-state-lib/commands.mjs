// commands.mjs -- the subcommand table. Each entry takes the resolved context (ctx.p holds every
// parameter; ctx.out / ctx.warn / ctx.emitJson write stdout) and throws to refuse (exit 1).
// A command not ported yet throws, so it can never be mistaken for a pass.
import { cmdGate } from './plan/gate.mjs';
import { cmdCriticalTools } from './report/critical-tools.mjs';

const notPorted = (name) => Object.assign(() => { throw new Error(`oa-state.mjs: '${name}' is not ported yet; use oa-state.ps1`); }, { notPorted: true });

export const COMMAND_TABLE = {
  seed: notPorted('seed'),
  scan: notPorted('scan'),
  get: notPorted('get'),
  mark: notPorted('mark'),
  resnapshot: notPorted('resnapshot'),
  consent: notPorted('consent'),
  gate: cmdGate,
  extract: notPorted('extract'),
  doc: notPorted('doc'),
  session: notPorted('session'),
  whoami: notPorted('whoami'),
  'critical-tools': cmdCriticalTools,
  decisions: notPorted('decisions'),
};

// Which commands are ported: the characterization adapter maps exactly these, so every other
// case stays SKIP rather than failing.
export const PORTED = Object.entries(COMMAND_TABLE).filter(([, f]) => !f.notPorted).map(([k]) => k);
