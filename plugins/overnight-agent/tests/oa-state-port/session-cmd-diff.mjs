#!/usr/bin/env node
// Whole-command twin-sandbox differential test for `oa-state session` and `whoami`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeNormalizer, cleanStderr, tryParseJson, GUID_RE } from '../characterization/lib/normalize.mjs';
import { main as runOaState, makeOutput } from '../../skills/overnight-agent/oa-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const skill = path.join(repo, 'plugins/overnight-agent/skills/overnight-agent');
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-session-cmd-diff-'));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []));
const N = Number(args.n ?? 60);
const VERBOSE = !!args.verbose;
const CHUNK = Number(args.chunk ?? 10);
let seed = Number(args.seed ?? 716);
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const PS_BATCH = String.raw`
param(
  [Parameter(Mandatory)][string]$ScriptPath,
  [Parameter(Mandatory)][string]$CommandsPath,
  [Parameter(Mandatory)][string]$SkillRoot
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)

function Add-OaLine([Text.StringBuilder]$Builder, $Value) {
  if ($null -eq $Value) { [void]$Builder.AppendLine(''); return }
  if ($Value -is [System.Management.Automation.WarningRecord]) {
    [void]$Builder.AppendLine("WARNING: $($Value.Message)")
    return
  }
  $text = [string]$Value
  if ($text.EndsWith(([string][char]13) + ([string][char]10))) { [void]$Builder.Append($text); return }
  if ($text.EndsWith([string][char]10)) { [void]$Builder.Append($text); return }
  [void]$Builder.AppendLine($text)
}

function Clear-OaStateMutex([string]$StateDir) {
  if (-not $StateDir) { return }
  $lockPath = [IO.Path]::GetFullPath($StateDir).TrimEnd([char[]]'\/')
  if ($env:OS -eq 'Windows_NT') { $lockPath = $lockPath.ToLowerInvariant() }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $lockKey = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lockPath)))).Replace('-', '') }
  finally { $sha.Dispose() }
  $mutex = $null
  $taken = $false
  try {
    $mutex = [Threading.Mutex]::OpenExisting("oa-state-$lockKey")
    try { $taken = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $taken = $true }
    if ($taken) { $mutex.ReleaseMutex() }
  }
  catch {
    # The command already released the mutex and no named handle remains.
  }
  finally {
    if ($mutex) { $mutex.Dispose() }
  }
}

$sourceText = [IO.File]::ReadAllText($ScriptPath)
$cut = $sourceText.IndexOf('if (($CheckDispatch -or $ForDispatch) -and $Command -ne ''session'')')
if ($cut -lt 0) { throw 'session-cmd-diff: dispatch block not found in oa-state.ps1' }
$body = $sourceText.Substring(0, $cut)
$body = $body.Replace('$PSScriptRoot', "'" + $SkillRoot.Replace("'", "''") + "'")
. ([scriptblock]::Create($body))

$resetParams = @{
  Command = 'scan'; Id = ''; Force = $false; SessionDead = $false; SessionRelease = $false
  WorkspaceGone = ''; SessionId = ''; SessionKind = $null; SessionProject = ''; SessionWorkspace = ''
  WorkspaceType = $null; CheckDispatch = $false; ForDispatch = $false; PlanDispatch = $false
  DispatchInput = ''; RequiresTools = @(); LockWaitSeconds = 0
  StateDir = ''; JournalDir = ''; PlannerBoard = ''; PlannerCompleted = ''; SnoozeStore = ''
  UserSettings = ''; GatePath = ''; SessionStateDir = ''; CapabilitiesPath = ''; SessionsStatusFile = ''
  RunWorkspace = ''
}

$results = @()
$commands = Get-Content -LiteralPath $CommandsPath -Raw | ConvertFrom-Json -NoEnumerate
foreach ($req in @($commands)) {
  $stdout = [Text.StringBuilder]::new()
  $stderr = [Text.StringBuilder]::new()
  $exit = 0
  $oldEnv = @{}
  try {
    foreach ($prop in $req.env.PSObject.Properties) {
      $oldEnv[$prop.Name] = [Environment]::GetEnvironmentVariable($prop.Name, 'Process')
      [Environment]::SetEnvironmentVariable($prop.Name, [string]$prop.Value, 'Process')
    }
    $oaParams = @{}
    foreach ($prop in $req.params.PSObject.Properties) { $oaParams[$prop.Name] = $prop.Value }
    foreach ($entry in $resetParams.GetEnumerator()) {
      try { Set-Variable -Name $entry.Key -Value $entry.Value -Scope Script -ErrorAction Stop }
      catch {
        Remove-Variable -Name $entry.Key -Scope Script -Force -ErrorAction SilentlyContinue
        New-Variable -Name $entry.Key -Value $entry.Value -Scope Script -Force
      }
    }
    $bound = @{ Command = [string]$req.command }
    Set-Variable -Name Command -Value ([string]$req.command) -Scope Script
    foreach ($entry in $oaParams.GetEnumerator()) {
      Set-Variable -Name $entry.Key -Value $entry.Value -Scope Script
      $bound[$entry.Key] = $entry.Value
    }
    $script:ExplicitArgs = $bound
    $out = & {
      if (($CheckDispatch -or $ForDispatch) -and $Command -ne 'session') {
        throw 'session_flag_command: dispatch checks belong to the session command'
      }
      Resolve-GateSettings
      Resolve-PacingSettings
      switch ($Command) {
        'session' { Cmd-Session }
        'whoami' { Cmd-Whoami }
        default { throw "session-cmd-diff: unsupported command '$Command'" }
      }
    } 3>&1
    foreach ($item in @($out)) { Add-OaLine $stdout $item }
  }
  catch {
    $exit = 1
    [void]$stderr.AppendLine($_.Exception.Message)
  }
  finally {
    Clear-OaStateMutex ([string]$req.params.StateDir)
    foreach ($name in $oldEnv.Keys) {
      [Environment]::SetEnvironmentVariable($name, $oldEnv[$name], 'Process')
    }
  }
  $results += [pscustomobject][ordered]@{
    exit = $exit
    stdout = $stdout.ToString()
    stderr = $stderr.ToString()
  }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $results -Depth 8 -Compress))
`;

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

function writePsBatchScript() {
  const script = rel(workRoot, 'ps-command-batch.ps1');
  write(script, PS_BATCH);
  return script;
}

function writeUnlockedPsTarget() {
  const source = rel(skill, 'oa-state.ps1');
  const target = rel(workRoot, 'oa-state-unlocked.ps1');
  const text = fs.readFileSync(source, 'utf8');
  const needle = "$needsStateLock = @('critical-tools', 'decisions') -notcontains $Command";
  if (!text.includes(needle)) throw new Error('oa-state.ps1 lock site not found');
  write(target, text.replace(needle, '$needsStateLock = $false # session-cmd-diff: single-writer twin sandbox'));
  return target;
}

function runPsBatch(scriptPath, sequenceDir, requests, targetScript = rel(skill, 'oa-state.ps1')) {
  const commandsPath = rel(sequenceDir, 'ps-commands.json');
  write(commandsPath, JSON.stringify(requests));
  const r = spawnSync(process.env.CHAR_PWSH || 'pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-ScriptPath', targetScript,
    '-CommandsPath', commandsPath,
    '-SkillRoot', skill,
  ], { cwd: repo, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`ps batch exited ${r.status ?? 1}${r.error ? ` (${r.error.code || r.error.message})` : ''}: ${r.stderr || r.stdout}`);
  }
  const parsed = tryParseJson(r.stdout);
  if (!Array.isArray(parsed) || parsed.length !== requests.length) {
    throw new Error(`ps batch returned ${Array.isArray(parsed) ? parsed.length : 'non-array'} result(s), expected ${requests.length}: ${r.stdout.slice(0, 1000)} ${r.stderr.slice(0, 1000)}`);
  }
  return parsed;
}

function psRequest(p, command, args, envExtra = {}) {
  return {
    command,
    params: { ...commonArgs(p), ...args },
    env: {
      OVERNIGHT_AGENT_HOME: p.home,
      OVERNIGHT_AGENT_PLANNER_DIR: p.data,
      COPILOT_HOME: p.home,
      ...envExtra,
    },
  };
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
  const env = { OVERNIGHT_AGENT_HOME: p.home, OVERNIGHT_AGENT_PLANNER_DIR: p.data, COPILOT_HOME: p.home, ...envExtra };
  const oldEnv = new Map();
  for (const [k, v] of Object.entries(env)) {
    oldEnv.set(k, process.env[k]);
    process.env[k] = v;
  }
  let stdout = '';
  let stderr = '';
  const origWriteSync = fs.writeSync;
  fs.writeSync = function patchedWriteSync(fd, data, ...rest) {
    if (fd === 2) {
      stderr += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      return Buffer.byteLength(Buffer.isBuffer(data) ? data : String(data));
    }
    return origWriteSync.call(this, fd, data, ...rest);
  };
  try {
    const exit = runOaState(nodeArgv(command, merged), makeOutput((s) => { stdout += s; }));
    return { exit: exit ?? 0, stdout, stderr };
  } finally {
    fs.writeSync = origWriteSync;
    for (const [k, v] of oldEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
    stdout: stableClock(parsed === undefined ? norm.text(r.stdout.trim()) : norm.value(parsed)),
    stderr: stderr.map((x) => stableClock(norm.text(x))),
  };
}

function stableClock(v) {
  if (typeof v === 'string') return v.replace(/<(NOW|STAMP|INVTIME)[+-]\d+m>/g, '<$1>');
  if (Array.isArray(v)) return v.map(stableClock);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stableClock(x)]));
  return v;
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
      out[r] = stableClock(parsed === undefined ? norm.text(text) : norm.value(parsed));
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
  const psBatchScript = writePsBatchScript();
  const psTarget = writeUnlockedPsTarget();
  const seqs = [];
  for (let seq = 0; seq < N; seq++) {
    const seqRoot = rel(workRoot, `seq-${seq}`);
    const psRoot = rel(workRoot, `seq-${seq}`, 'ps');
    const nodeRoot = rel(workRoot, `seq-${seq}`, 'node');
    const psP = setup(psRoot, seq + 1);
    const nodeP = setup(nodeRoot, seq + 1);
    const keepGuids = collectGuids(JSON.stringify(fs.readFileSync(rel(psP.state, 'task-701.json'), 'utf8')));
    const steps = 2;
    const commands = [];
    const psRequests = [];
    for (let step = 0; step < steps; step++) {
      const [cmd, psArgs] = makeCommand(seq + 1, step, psP, nodeP);
      if (VERBOSE) console.error(`seq ${seq} step ${step} ${cmd} ${JSON.stringify(psArgs)}`);
      collectGuids(psArgs, keepGuids);
      commands.push({ step, cmd, nodeArgs: remapArgs(psArgs, psP, nodeP) });
      psRequests.push(psRequest(psP, cmd, psArgs));
    }
    seqs.push({ seq, seqRoot, psRoot, nodeRoot, psP, nodeP, keepGuids, commands, psRequests });
  }
  for (let chunkStart = 0; chunkStart < seqs.length; chunkStart += CHUNK) {
    const chunk = seqs.slice(chunkStart, chunkStart + CHUNK);
    const psResults = runPsBatch(psBatchScript, rel(workRoot, `chunk-${chunkStart}`), chunk.flatMap((rec) => rec.psRequests), psTarget);
    let psOffset = 0;
    for (const rec of chunk) {
      const recResults = psResults.slice(psOffset, psOffset + rec.psRequests.length);
      psOffset += rec.psRequests.length;
      recResults.forEach((psR, i) => { if (VERBOSE) console.error(`  ps exit ${psR.exit}`); rec.commands[i].psR = psR; });
      const t0 = Date.now();
      const normPs = makeNormalizer({ t0, pathTokens: [['<ROOT>', rec.psRoot], ['<SKILL>', skill], ['<REPO>', repo]], keepGuids: rec.keepGuids });
      const normNode = makeNormalizer({ t0, pathTokens: [['<ROOT>', rec.nodeRoot], ['<SKILL>', skill], ['<REPO>', repo]], keepGuids: rec.keepGuids });
      for (const { step, cmd, psR, nodeArgs } of rec.commands) {
        const nodeR = runNode(rec.nodeP, cmd, nodeArgs);
        if (VERBOSE) console.error(`  node exit ${nodeR.exit}`);
        assertEqual(normalizeResult(normPs, psR), normalizeResult(normNode, nodeR), `seq ${rec.seq} step ${step} ${cmd}`);
      }
      assertEqual(tree(rec.psRoot, normPs), tree(rec.nodeRoot, normNode), `seq ${rec.seq} file tree`);
    }
  }
  rm(workRoot);
  console.log(`session-cmd-diff: ${N} sequences, 0 differences`);
}

try { main(); } catch (e) { try { rm(workRoot); } catch {} console.error(e.stack || e.message); process.exitCode = 1; }
