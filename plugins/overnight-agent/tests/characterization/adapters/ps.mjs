// The PowerShell adapter: today's implementation, driven exactly the way production drives it
// (`pwsh -NoProfile -File <script> <command> -Name value ...`).
import { spawn } from 'node:child_process';
import path from 'node:path';

const SCRIPTS = { 'oa-state': 'oa-state.ps1', 'write-turn': 'write-turn.ps1' };

function toArgv(args) {
  const argv = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === true) { argv.push(`-${k}`); continue; }
    if (Array.isArray(v)) {
      // `-File` cannot carry a multi-element array; a one-element string[] binds from one string.
      if (v.length !== 1) throw new Error(`ps adapter: -${k} needs exactly one value under -File (got ${v.length})`);
      argv.push(`-${k}`, String(v[0]));
      continue;
    }
    argv.push(`-${k}`, String(v));
  }
  return argv;
}

export default {
  name: 'ps',
  describe() { return `pwsh (${process.env.CHAR_PWSH || 'pwsh'}) running the scripts in the skill folder`; },
  async run(step, ctx) {
    const script = SCRIPTS[step.tool];
    if (!script) return { status: 'skip', reason: `ps adapter has no tool '${step.tool}'` };
    const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.skillDir, script)];
    if (step.tool === 'oa-state' && step.command) argv.push(step.command);
    argv.push(...toArgv(step.args));
    return new Promise((resolve, reject) => {
      const child = spawn(process.env.CHAR_PWSH || 'pwsh', argv, { cwd: ctx.cwd, env: ctx.env, windowsHide: true });
      const out = []; const err = [];
      child.stdout.on('data', (b) => out.push(b));
      child.stderr.on('data', (b) => err.push(b));
      if (step.stdin != null) child.stdin.end(step.stdin); else child.stdin.end();
      const timer = setTimeout(() => child.kill(), (ctx.timeoutSeconds || 240) * 1000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: 'ran', exit: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
    });
  },
};
