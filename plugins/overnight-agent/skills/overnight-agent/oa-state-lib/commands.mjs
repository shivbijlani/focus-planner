// commands.mjs -- the subcommand table. Each entry takes the resolved context (ctx.p holds every
// parameter; ctx.out / ctx.warn / ctx.emitJson write stdout) and throws to refuse (exit 1).
// A command not ported yet throws, so it can never be mistaken for a pass.
import { cmdGate } from './plan/gate.mjs';
import { cmdGet } from './plan/get.mjs';
import { cmdWhoami } from './plan/whoami.mjs';
import { cmdExtract } from './plan/extract.mjs';
import { cmdConsent } from './plan/consent.mjs';
import { cmdScan } from './plan/scan.mjs';
import { cmdCriticalTools } from './report/critical-tools.mjs';
import { cmdDecisions } from './report/decisions.mjs';
import { cmdSeed } from './act/seed.mjs';
import { cmdMark } from './act/mark.mjs';
import { cmdResnapshot } from './act/resnapshot.mjs';
import { cmdDoc } from './act/doc.mjs';

const notPorted = (name) => Object.assign(() => { throw new Error(`oa-state.mjs: '${name}' is not ported yet; use oa-state.ps1`); }, { notPorted: true });

export const COMMAND_TABLE = {
  seed: cmdSeed,
  scan: cmdScan,
  get: cmdGet,
  mark: cmdMark,
  resnapshot: cmdResnapshot,
  consent: cmdConsent,
  gate: cmdGate,
  extract: cmdExtract,
  doc: cmdDoc,
  session: notPorted('session'),
  whoami: cmdWhoami,
  'critical-tools': cmdCriticalTools,
  decisions: cmdDecisions,
};

// Which commands are ported: the characterization adapter maps exactly these, so every other
// case stays SKIP rather than failing.
export const PORTED = Object.entries(COMMAND_TABLE).filter(([, f]) => !f.notPorted).map(([k]) => k);

