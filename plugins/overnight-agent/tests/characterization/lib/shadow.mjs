// Local-only SHADOW mode (never in CI, never commits data).
//
// Copies the owner's live planner folder and host state dir into a throwaway sandbox, runs the
// READ-ONLY commands with both implementations, and writes a diff report to
// %LOCALAPPDATA%\overnight-agent\shadow\. The live folders are only ever READ (fs.cpSync from
// them into the sandbox); every command runs against the sandbox copy with sandbox paths, so even
// a command that unexpectedly writes cannot touch live data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot } from './fixture.mjs';
import { sandboxDirs, resolveArgs, baseEnv } from './contract.mjs';
import { makeNormalizer, cleanStderr, tryParseJson } from './normalize.mjs';
import { stableStringify, firstDifference } from './engine.mjs';

function settingsRow(text, name) {
  const m = new RegExp('^\\s*\\|\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|\\s*([^|\\r\\n]*?)\\s*\\|', 'im').exec(text || '');
  if (!m) return null;
  const tick = /`([^`]*)`/.exec(m[1]);
  return (tick ? tick[1] : m[1]).trim();
}

// Where the owner's planner folder lives, resolved the way the plugin itself resolves it:
// explicit --data, then PLANNER_PATH (SKILL.md's variable), then the `Planner board` row of the
// user-settings.md the plugin reads (OVERNIGHT_AGENT_SETTINGS, the OA home copy), then the
// documented default under OneDrive.
export function locateLiveData(explicit) {
  const tried = [];
  const ok = (p) => p && fs.existsSync(path.join(p, 'planner.md'));
  if (explicit) { if (ok(explicit)) return { dir: explicit, via: '--data' }; throw new Error(`--data ${explicit} has no planner.md`); }
  if (process.env.PLANNER_PATH) { tried.push(process.env.PLANNER_PATH); if (ok(process.env.PLANNER_PATH)) return { dir: process.env.PLANNER_PATH, via: 'PLANNER_PATH' }; }
  const settingsCandidates = [process.env.OVERNIGHT_AGENT_SETTINGS,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'user-settings.md'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'OneDrive', 'Apps', 'Focus Planner', 'user-settings.md')].filter(Boolean);
  for (const s of settingsCandidates) {
    if (!fs.existsSync(s)) continue;
    const board = settingsRow(fs.readFileSync(s, 'utf8'), 'Planner board');
    if (board && !board.includes('<')) {
      const dir = path.dirname(board.replace(/[\\/]+$/, ''));
      tried.push(dir);
      if (ok(dir)) return { dir, via: `Planner board row in ${s}` };
    }
    const dir = path.dirname(s);
    if (ok(dir)) return { dir, via: `folder of ${s}` };
  }
  const def = process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'OneDrive', 'Apps', 'Focus Planner');
  tried.push(def);
  if (ok(def)) return { dir: def, via: 'default OneDrive location' };
  throw new Error(`could not locate the live planner folder (tried: ${tried.filter(Boolean).join('; ')}); pass --data`);
}

const COPY_FILES = ['planner.md', 'planner-completed.md', 'snooze.json', 'agent-gate.md', 'user-settings.md'];

function readOnlyPlan(ids, sample) {
  const plan = [
    { tool: 'oa-state', command: 'scan' },
    { tool: 'oa-state', command: 'scan', args: { Compact: true } },
    { tool: 'oa-state', command: 'gate' },
    { tool: 'oa-state', command: 'whoami', args: { SessionId: '00000000-0000-4000-8000-000000000000' } },
  ];
  for (const id of ids.slice(0, sample)) {
    plan.push({ tool: 'oa-state', command: 'get', args: { Id: id } });
    plan.push({ tool: 'oa-state', command: 'consent', args: { Id: id } });
    plan.push({ tool: 'oa-state', command: 'extract', args: { Id: id, Json: true } });
    plan.push({ tool: 'oa-state', command: 'extract', args: { Id: id } });
    plan.push({ tool: 'oa-state', command: 'consent', args: { Id: id, Action: 'merge_pr', Repo: 'focus-planner' } });
    plan.push({ tool: 'oa-state', command: 'consent', args: { Id: id, Action: 'delete_data' } });
    plan.push({ tool: 'oa-state', command: 'session', args: { Id: id } });
  }
  return plan;
}

export async function runShadow(o) {
  if (process.env.CI) throw new Error('shadow mode is local-only and refuses to run under CI');
  const live = locateLiveData(o.data);
  const liveState = o.state || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state'));
  if (!liveState || !fs.existsSync(liveState)) throw new Error(`state dir not found: ${liveState} (pass --state)`);
  const outDir = o.out || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'overnight-agent', 'shadow');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-shadow-')));
  const dirs = sandboxDirs(root);
  console.log(`shadow: data=${live.dir} (${live.via})\n        state=${liveState}\n        sandbox=${root}`);
  try {
    fs.mkdirSync(dirs.journal, { recursive: true });
    for (const f of COPY_FILES) if (fs.existsSync(path.join(live.dir, f))) fs.copyFileSync(path.join(live.dir, f), path.join(dirs.data, f));
    if (fs.existsSync(path.join(live.dir, 'journal'))) fs.cpSync(path.join(live.dir, 'journal'), dirs.journal, { recursive: true, preserveTimestamps: true });
    fs.cpSync(liveState, dirs.state, { recursive: true, preserveTimestamps: true });
    for (const d of [dirs.cwd, dirs.input, dirs.tmp]) fs.mkdirSync(d, { recursive: true });
    const ids = fs.readdirSync(dirs.journal).map((f) => /^task-(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).sort((a, b) => Number(b) - Number(a));
    const plan = readOnlyPlan(ids, o.sample);
    const env = baseEnv(dirs, o.stubsDir);
    const n = makeNormalizer({ t0: Date.now(), pathTokens: [['<ROOT>', root], ['<SKILL>', o.skillDir], ['<REPO>', o.repoDir]] });
    const impls = { ps: await o.loadAdapter('ps'), node: await o.loadAdapter('node') };
    const before = snapshot(root);
    const report = { generated: new Date().toISOString(), data: live.dir, state: liveState, commands: [] };
    const tally = { same: 0, differ: 0, node_skip: 0, ps_error: 0 };
    for (const step of plan) {
      const args = resolveArgs(step.tool, step.args, dirs);
      const obs = {};
      for (const [name, impl] of Object.entries(impls)) {
        const res = await impl.run({ tool: step.tool, command: step.command, args }, { root, dirs, cwd: dirs.cwd, env, skillDir: o.skillDir, repoDir: o.repoDir, timeoutSeconds: 900 });
        if (res.status === 'skip') { obs[name] = { skip: res.reason }; continue; }
        const parsed = tryParseJson(res.stdout);
        obs[name] = { exit: res.exit, out: parsed !== undefined ? n.value(parsed) : n.text(res.stdout), stderr: cleanStderr(n.text(res.stderr).split(/\r?\n/)) };
      }
      const entry = { command: `${step.tool} ${step.command} ${JSON.stringify(step.args || {})}` };
      if (obs.ps.exit !== 0) tally.ps_error++;
      if (obs.node.skip) { tally.node_skip++; entry.verdict = 'node-skip'; }
      else if (stableStringify(obs.ps) === stableStringify(obs.node)) { tally.same++; entry.verdict = 'same'; }
      else { tally.differ++; entry.verdict = 'differ'; entry.first_difference = firstDifference(obs.ps, obs.node); entry.ps = obs.ps; entry.node = obs.node; }
      report.commands.push(entry);
      process.stdout.write(`${entry.verdict.padEnd(9)} ${entry.command}\n`);
    }
    const after = snapshot(root);
    report.sandbox_writes = [...new Set([...before.keys(), ...after.keys()])].filter((k) => !before.get(k) || !after.get(k) || !before.get(k).equals(after.get(k))).filter((k) => !k.startsWith('tmp/') && !k.startsWith('lad/Microsoft'));
    report.tally = tally;
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `shadow-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nsame ${tally.same}  differ ${tally.differ}  node-skip ${tally.node_skip}  ps-nonzero-exit ${tally.ps_error}`);
    if (report.sandbox_writes.length) console.log(`note: read-only commands wrote ${report.sandbox_writes.length} sandbox file(s): ${report.sandbox_writes.slice(0, 5).join(', ')}`);
    console.log(`report: ${file}`);
    return tally.differ ? 1 : 0;
  } finally {
    if (!o.keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
