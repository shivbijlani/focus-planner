// fn-diff.mjs -- function-level differential testing of the oa-state Node port against
// oa-state.ps1 itself.
//
// `createPsHost()` starts ps-fn-host.ps1, which loads oa-state.ps1's functions without running a
// command, and `call(fn, args)` invokes one of them, returning what PowerShell returned (as JSON:
// DateTime -> ISO string, pipeline output -> null / the object / an array). The Node side calls
// the ported function and passes its result through `asJson`, so the two compare structurally
// with `diff` (object key order ignored, since PowerShell hashtables have none).
//
//   import { createPsHost, asJson, diff } from './fn-diff.mjs';
//   const ps = await createPsHost({ params: { StateDir: dir } });
//   const a = await ps.call('Get-AgentEndIndex', [text]);
//   const b = asJson(getAgentEndIndex(text));
//   const d = diff(a, b); if (d) throw new Error(d);
//   await ps.close();
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(here, '../../skills/overnight-agent');
export const OA_STATE_PS1 = path.join(SKILL_DIR, 'oa-state.ps1');

export async function createPsHost({ params = {}, script = OA_STATE_PS1, pwsh = process.env.CHAR_PWSH || 'pwsh', env = process.env, cwd } = {}) {
  const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(here, 'ps-fn-host.ps1'), '-ScriptPath', script, '-ParamsJson', JSON.stringify(params)],
  { stdio: ['pipe', 'pipe', 'pipe'], env, cwd, windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = [];
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  rl.on('line', (line) => {
    const w = waiting.shift();
    if (!w) return;
    try { w.resolve(JSON.parse(line)); } catch (e) { w.reject(new Error(`bad host line: ${line.slice(0, 300)}`)); }
  });
  child.on('close', (code) => {
    for (const w of waiting.splice(0)) w.reject(new Error(`ps-fn-host exited ${code}: ${stderr.slice(0, 2000)}`));
  });
  const send = (req) => new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify(req)}\n`);
  });
  return {
    // Resolves to the function's value; rejects with PowerShell's message when it threw.
    async call(fn, args = []) {
      const r = await send({ fn, args });
      if (!r.ok) { const e = new Error(r.error); e.psError = true; throw e; }
      return r.value;
    },
    async callRaw(fn, args = []) { return send({ fn, args }); },
    async eval(script) {
      const r = await send({ eval: script });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    },
    close() { child.stdin.end(); return new Promise((res) => child.on('close', res)); },
  };
}

// A Node value as the PowerShell side would serialise it.
export const asJson = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v ?? null)));

const canon = (x) => (Array.isArray(x) ? x.map(canon)
  : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

// null when equal; otherwise the first differing path with both values.
export function diff(a, b, where = '$') {
  a = canon(a); b = canon(b);
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return `${where}: ps ${JSON.stringify(a)?.slice(0, 300)} | node ${JSON.stringify(b)?.slice(0, 300)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = diff(a[k], b[k], Array.isArray(a) ? `${where}[${k}]` : `${where}.${k}`);
    if (d) return d;
  }
  return null;
}
