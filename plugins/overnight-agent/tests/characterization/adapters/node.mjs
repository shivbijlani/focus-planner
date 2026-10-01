// The Node adapter: where items 3 (write tool) and 4 (oa-state port) plug in.
//
// Each entry maps a (tool, command) pair to an implementation. Until an entry is filled in the
// adapter answers SKIP -- never pass -- so `--impl node` reports exactly how much of the contract
// the port covers. See ../README.md, "Plugging in the Node implementation".
//
// An implementation is either
//   { bin: '<path to .mjs, relative to the repo root>', argv?: (step) => string[] }
//     -> run as `node <bin> [argv]`; the default argv is `<command> --Name value ...` (switches as
//        `--Name`), i.e. the PowerShell parameter names verbatim, so a port can keep the contract;
//   or a function `async (step, ctx) => ({ status: 'ran', exit, stdout, stderr })` for anything
//     bespoke (in-process calls, argument renaming, ...).
import { spawn } from 'node:child_process';
import path from 'node:path';

// Item 4: oa-state.mjs, the Node port of the state engine, mapped command by command as it lands.
const OA_STATE = { bin: 'plugins/overnight-agent/skills/overnight-agent/oa-state.mjs' };

export const IMPLEMENTATIONS = {
  'oa-state': {
    seed: null,
    scan: null,
    get: null,
    mark: null,
    resnapshot: null,
    consent: null,
    gate: OA_STATE,
    extract: null,
    doc: null,
    session: null,
    whoami: null,
    'critical-tools': OA_STATE,
    decisions: null,
  },
  // write-turn has no subcommand; the key is '' (every mode -- validate, append, json -- goes here).
  // Item 3: the Node port, driven with the PowerShell parameter names verbatim.
  'write-turn': {
    '': { bin: 'plugins/overnight-agent/skills/overnight-agent/write-turn.mjs' },
  },
};

function defaultArgv(step) {
  const argv = step.command ? [step.command] : [];
  for (const [k, v] of Object.entries(step.args)) {
    if (v === true) argv.push(`--${k}`);
    else if (Array.isArray(v)) for (const x of v) argv.push(`--${k}`, String(x));
    else argv.push(`--${k}`, String(v));
  }
  return argv;
}

export default {
  name: 'node',
  describe() { return 'node ports (items 3/4) -- unmapped commands are SKIP'; },
  async run(step, ctx) {
    const impl = IMPLEMENTATIONS[step.tool]?.[step.command || ''];
    if (!impl) return { status: 'skip', reason: `node: ${step.tool}${step.command ? ' ' + step.command : ''} not implemented` };
    if (typeof impl === 'function') return impl(step, ctx);
    const argv = [path.join(ctx.repoDir, impl.bin), ...(impl.argv ? impl.argv(step) : defaultArgv(step))];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argv, { cwd: ctx.cwd, env: ctx.env, windowsHide: true });
      const out = []; const err = [];
      child.stdout.on('data', (b) => out.push(b));
      child.stderr.on('data', (b) => err.push(b));
      if (step.stdin != null) child.stdin.end(step.stdin); else child.stdin.end();
      child.on('error', reject);
      child.on('close', (code) => resolve({ status: 'ran', exit: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    });
  },
};
