#!/usr/bin/env node
// Whole-command twin-sandbox differential test for `oa-state session` and `whoami`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeNormalizer, cleanStderr, tryParseJson, GUID_RE } from '../characterization/lib/normalize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const skill = path.join(repo, 'plugins/overnight-agent/skills/overnight-agent');
const workRoot = path.join(here, '.session-cmd-diff-work');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []));
const N = Number(args.n ?? 60);
const VERBOSE = !!args.verbose;
let seed = Number(args.seed ?? 716);
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

function write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
const rel = (...p) => path.join(...p);
function guid(seq, n) {
  return `${String(seq).padStart(8, '0')}-${String(n).padStart(4, '0')}-4${String(n).padStart(3, '0')}-8${String(n).padStart(3, '0')}-${String(seq).padStart(12, '0')}`;
}
function isoAgo(minutes) { return new Date(Date.now() - minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function paths(root) {
  return {
    root,
    data: rel(root, 'data'),
    state: rel(root, 'state'),
    journal: rel(root, 'data', 'journal'),
    home: rel(root, 'home'),
    sessState: rel(root, 'home', 'session-state'),
    runWs: rel(root, 'run-workspace'),
    caps: rel(root, 'capabilities.json'),
    status: rel(root, 'sessions-status.json'),
  };
}

function journal(id) {
  return `# Task ${id}: task ${id}

User notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## 🌙 Overnight Agent — 2020-03-01

<!-- from: overnight-agent -->
**Status:** In progress - plan v1
Worked on the task.

**Needs from you:** none
<!-- /overnight-agent turn-end -->
`;
}

function setup(root, seq) {
  const p = paths(root);
  rm(root);
  fs.mkdirSync(p.journal, { recursive: true });
  fs.mkdirSync(p.state, { recursive: true });
  fs.mkdirSync(p.sessState, { recursive: true });
  fs.mkdirSync(p.runWs, { recursive: true });
  fs.mkdirSync(rel(p.home, 'task-chats'), { recursive: true });
  const project = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  write(rel(p.data, 'planner.md'), '## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|---|---|---|---|\n| 701 | 🟡 | task 701 | P0 | 2020-01-01 | |\n| 702 | 🟡 | task 702 | P1 | 2020-01-01 | |\n| 703 | 🟡 | task 703 | P2 | 2020-01-01 | |\n');
  write(rel(p.data, 'planner-completed.md'), '');
  write(rel(p.data, 'snooze.json'), '{}');
  write(rel(p.data, 'agent-gate.md'), '');
  write(rel(p.data, 'user-settings.md'), `| Setting | Value |
|---|---|
| Non-code task project | \`${project}\` |
| Overnight Agent concurrency | \`2\` |
`);
  for (const id of ['701', '702', '703']) write(rel(p.journal, `task-${id}.md`), journal(id));
  const wt701 = rel(p.home, 'worktrees', 'wt-701');
  const wt702 = rel(p.home, 'worktrees', 'wt-702');
  fs.mkdirSync(wt701, { recursive: true });
  fs.mkdirSync(wt702, { recursive: true });
  write(rel(wt701, '.git'), 'gitdir: V:/repo/.git/worktrees/wt-701');
  write(rel(wt702, '.git'), 'gitdir: V:/repo/.git/worktrees/wt-702');
  write(rel(p.state, 'task-701.json'), JSON.stringify({
    id: '701', status: 'in-progress', status_by: 'agent', version: 1, plan_id: 't701-v1',
    processed_file_hash: '', has_agent_block: true, seeded: false, updated: '2020-03-01T12:00:00Z',
    session: {
      session_id: guid(seq, 1), kind: 'code', project: 'focus-planner', workspace: wt701,
      workspace_type: 'worktree', created_at: '2020-03-01T00:00:00Z', last_woken_at: '',
      state: 'live', prior_session_id: '', prior_session_ids: [], replaced_at: '',
    },
  }, null, 2));
  write(rel(p.state, 'task-702.json'), JSON.stringify({
    id: '702', status: 'in-progress', status_by: 'agent', version: 1, plan_id: 't702-v1',
    processed_file_hash: '', has_agent_block: true, seeded: false, updated: '2020-03-01T12:00:00Z',
    session: {
      session_id: guid(seq, 2), kind: 'chat', project, workspace: rel(p.home, 'task-chats'),
      workspace_type: 'folder', created_at: '2020-03-01T00:00:00Z', last_woken_at: '',
      state: 'dead', prior_session_id: '', prior_session_ids: [], replaced_at: '',
    },
  }, null, 2));
  write(rel(p.state, 'task-703.json'), JSON.stringify({
    id: '703', status: 'proposed', status_by: 'agent', version: 1, plan_id: 't703-v1',
    processed_file_hash: '', has_agent_block: true, seeded: false, updated: '2020-03-01T12:00:00Z',
  }, null, 2));
  write(p.caps, JSON.stringify({ schema: 'oa-capabilities/1', checkedAt: new Date().toISOString(), tools: { email: { status: 'ok' }, downer: { status: 'down' } } }, null, 2));
  write(p.status, JSON.stringify({ sessions: [{ id: guid(seq, 1), activity: { status: 'idle' } }, { id: guid(seq, 2), activity: { status: 'idle' } }] }, null, 2));
  return p;
}

function commonArgs(p) {
  return {
    StateDir: p.state, JournalDir: p.journal, PlannerBoard: rel(p.data, 'planner.md'),
    PlannerCompleted: rel(p.data, 'planner-completed.md'), SnoozeStore: rel(p.data, 'snooze.json'),
    UserSettings: rel(p.data, 'user-settings.md'), GatePath: rel(p.data, 'agent-gate.md'),
    SessionStateDir: p.sessState, CapabilitiesPath: p.caps, SessionsStatusFile: p.status,
    RunWorkspace: p.runWs,
  };
}

function argvFrom(command, args) {
  const argv = [command];
  for (const [k, v] of Object.entries(args)) {
    if (v === true) argv.push(`-${k}`);
    else if (v === false || v === null || v === undefined) continue;
    else if (Array.isArray(v)) for (const x of v) argv.push(`-${k}`, String(x));
    else argv.push(`-${k}`, String(v));
  }
  return argv;
}

function run(kind, p, command, args, envExtra = {}) {
  const merged = { ...commonArgs(p), ...args };
  const env = {
    ...process.env,
    OVERNIGHT_AGENT_HOME: p.home,
    OVERNIGHT_AGENT_PLANNER_DIR: p.data,
    COPILOT_HOME: p.home,
    ...envExtra,
  };
  if (kind === 'ps') {
    const r = spawnSync(process.env.CHAR_PWSH || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', rel(skill, 'oa-state.ps1'), ...argvFrom(command, merged)], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
    return { exit: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }
  const r = spawnSync(process.execPath, [rel(skill, 'oa-state.mjs'), ...argvFrom(command, merged).map((x) => x.startsWith('-') ? `-${x}` : x)], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return { exit: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function nodeArgv(command, args) {
  const argv = [command];
  for (const [k, v] of Object.entries(args)) {
    if (v === true) argv.push(`--${k}`);
    else if (v === false || v === null || v === undefined) continue;
    else if (Array.isArray(v)) for (const x of v) argv.push(`--${k}`, String(x));
    else argv.push(`--${k}`, String(v));
  }
  return argv;
}

// Override run's node path formatting without changing the simpler PowerShell formatter.
function runNode(p, command, args, envExtra = {}) {
  const merged = { ...commonArgs(p), ...args };
  const env = { ...process.env, OVERNIGHT_AGENT_HOME: p.home, OVERNIGHT_AGENT_PLANNER_DIR: p.data, COPILOT_HOME: p.home, ...envExtra };
  const r = spawnSync(process.execPath, [rel(skill, 'oa-state.mjs'), ...nodeArgv(command, merged)], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return { exit: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function getDispatchInput(p, id) {
  const r = runNode(p, 'scan', { Compact: true });
  if (r.exit !== 0) return 'stale';
  const j = tryParseJson(r.stdout);
  return j?.rows?.find((x) => String(x.id) === String(id))?.dispatch_input ?? 'stale';
}

function normalizeResult(norm, r) {
  const parsed = tryParseJson(r.stdout);
  const stderr = cleanStderr(r.stderr.split(/\r?\n/)).map((m) => {
    const tokenAt = Math.max(m.lastIndexOf('session_'), m.lastIndexOf('blocked:'), m.lastIndexOf('task_'));
    if (tokenAt >= 0) return m.slice(tokenAt).trim();
    const tail = /\|\s*([A-Za-z_][^|]*:[^|]*)\s*$/.exec(m);
    return tail ? tail[1].trim() : m;
  });
  return {
    exit: r.exit,
    stdout: parsed === undefined ? norm.text(r.stdout.trim()) : norm.value(parsed),
    stderr: stderr.map((x) => norm.text(x)),
  };
}

function tree(root, norm) {
  const out = {};
  function walk(d) {
    for (const name of fs.readdirSync(d).sort()) {
      const p = rel(d, name);
      const r = path.relative(root, p).replace(/\\/g, '/');
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/^(state|data|home\/worktrees|home\/task-chats)/.test(r)) continue;
      const raw = fs.readFileSync(p);
      const text = raw.toString('utf8').replace(/^\uFEFF/, '');
      const parsed = tryParseJson(text);
      out[r] = parsed === undefined ? norm.text(text) : norm.value(parsed);
    }
  }
  walk(root);
  return out;
}

function collectGuids(obj, set = new Set()) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const m of s.matchAll(GUID_RE)) set.add(m[0].toLowerCase());
  return set;
}

function makeCommand(seq, step, psPath, nodePath) {
  const id = pick(['701', '702', '703']);
  const g = guid(seq, 10 + step);
  const wt = rel(psPath.home, 'worktrees', `wt-${id}-${step}`);
  const nwt = rel(nodePath.home, 'worktrees', `wt-${id}-${step}`);
  fs.mkdirSync(wt, { recursive: true }); write(rel(wt, '.git'), 'gitdir: x');
  fs.mkdirSync(nwt, { recursive: true }); write(rel(nwt, '.git'), 'gitdir: x');
  const kind = (seq + step) % 10;
  if (kind === 0) return ['session', { Id: id }];
  if (kind === 1) return ['session', { Id: id, SessionDead: true }];
  if (kind === 2) return ['session', { Id: id, SessionRelease: true }];
  if (kind === 3) return ['session', { WorkspaceGone: pick([psPath.root.includes('\\node') ? nwt : wt, rel(psPath.home, 'worktrees', 'missing')]) }];
  if (kind === 4) return ['session', { Id: id, SessionId: g, SessionKind: 'code', SessionProject: 'focus-planner', SessionWorkspace: wt, WorkspaceType: 'worktree', Force: pick([true, false]) }];
  if (kind === 5) return ['session', { Id: id, SessionId: g, SessionKind: 'code', SessionProject: 'focus-planner', SessionWorkspace: wt, WorkspaceType: 'branch', Force: true }];
  if (kind === 6) return ['session', { Id: id, CheckDispatch: true, RequiresTools: pick([['email'], ['downer'], []]) }];
  if (kind === 7) return ['session', { Id: id, ForDispatch: true, DispatchInput: seq % 4 === 0 ? getDispatchInput(psPath, id) : 'stale-input', RequiresTools: seq % 3 === 0 ? ['email'] : [] }];
  if (kind === 8) return ['session', { Id: id, ForDispatch: true, PlanDispatch: true, DispatchInput: seq % 4 === 0 ? getDispatchInput(psPath, id) : 'stale-input' }];
  return ['whoami', { SessionId: pick([guid(seq, 1), guid(seq, 2), g, '99999999-9999-4999-8999-999999999999']) }];
}

function remapArgs(args, from, to) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const repl = (s) => String(s).split(from.root).join(to.root).split(from.home).join(to.home).split(from.data).join(to.data);
    out[k] = Array.isArray(v) ? v.map(repl) : typeof v === 'string' ? repl(v) : v;
  }
  return out;
}

function assertEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\nPS  : ${JSON.stringify(a).slice(0, 2000)}\nNode: ${JSON.stringify(b).slice(0, 2000)}`);
}

function main() {
  rm(workRoot);
  fs.mkdirSync(workRoot, { recursive: true });
  for (let seq = 0; seq < N; seq++) {
    const psRoot = rel(workRoot, `seq-${seq}`, 'ps');
    const nodeRoot = rel(workRoot, `seq-${seq}`, 'node');
    const psP = setup(psRoot, seq + 1);
    const nodeP = setup(nodeRoot, seq + 1);
    const keepGuids = collectGuids(JSON.stringify(fs.readFileSync(rel(psP.state, 'task-701.json'), 'utf8')));
    const normPs = makeNormalizer({ t0: Date.now(), pathTokens: [['<ROOT>', psRoot], ['<SKILL>', skill], ['<REPO>', repo]], keepGuids });
    const normNode = makeNormalizer({ t0: Date.now(), pathTokens: [['<ROOT>', nodeRoot], ['<SKILL>', skill], ['<REPO>', repo]], keepGuids });
    const steps = 2;
    for (let step = 0; step < steps; step++) {
      const [cmd, psArgs] = makeCommand(seq + 1, step, psP, nodeP);
      if (VERBOSE) console.error(`seq ${seq} step ${step} ${cmd} ${JSON.stringify(psArgs)}`);
      collectGuids(psArgs, keepGuids);
      const nodeArgs = remapArgs(psArgs, psP, nodeP);
      const psR = run('ps', psP, cmd, psArgs);
      if (VERBOSE) console.error(`  ps exit ${psR.exit}`);
      const nodeR = runNode(nodeP, cmd, nodeArgs);
      if (VERBOSE) console.error(`  node exit ${nodeR.exit}`);
      assertEqual(normalizeResult(normPs, psR), normalizeResult(normNode, nodeR), `seq ${seq} step ${step} ${cmd}`);
    }
    assertEqual(tree(psRoot, normPs), tree(nodeRoot, normNode), `seq ${seq} file tree`);
  }
  rm(workRoot);
  console.log(`session-cmd-diff: ${N} sequences, 0 differences`);
}

try { main(); } catch (e) { console.error(e.stack || e.message); process.exitCode = 1; }
