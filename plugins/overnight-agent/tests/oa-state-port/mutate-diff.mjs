#!/usr/bin/env node
// Differential fuzzer for the mutating oa-state commands ported in act/*.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeNormalizer, tryParseJson, cleanStderr } from '../characterization/lib/normalize.mjs';
import { stableStringify, firstDifference } from '../characterization/lib/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const PS = path.join(REPO, 'plugins', 'overnight-agent', 'skills', 'overnight-agent', 'oa-state.ps1');
const NODE = path.join(REPO, 'plugins', 'overnight-agent', 'skills', 'overnight-agent', 'oa-state.mjs');
const SCRATCH = path.join(HERE, '.scratch-mutate-diff');

function parseArgs(argv) {
  const o = { n: 20, seed: 12345, steps: 6, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i];
    if (a === '--n') o.n = Number(v());
    else if (a === '--seed') o.seed = Number(v());
    else if (a === '--steps') o.steps = Number(v());
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown arg ${a}`);
  }
  return o;
}

function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (1664525 * x + 1013904223) >>> 0; return x / 0x100000000; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const maybe = (r, p = 0.5) => r() < p;

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeMaybeBom(file, text, bom = false) {
  fs.writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8'));
}
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

function makeBase(root, r) {
  mkdir(path.join(root, 'planner', 'journal'));
  mkdir(path.join(root, 'state'));
  const nl1 = maybe(r) ? '\r\n' : '\n';
  const nl2 = maybe(r) ? '\r\n' : '\n';
  const j1 = [
    '# Task 1: Alpha',
    '<!-- tg-meta chatId=1 threadId=2 -->',
    '',
    'User notes with café and emoji 🟡.',
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '',
    '## 🌙 Overnight Agent',
    '<!-- from: overnight-agent -->',
    '<!-- oa-ask: none -->',
    '',
    '**Status:** In progress',
    '',
    '### Run log',
    '**2020-01-01 (overnight):**',
    '- Result: seeded',
  ].join(nl1) + nl1;
  const j2 = [
    '# Task 2: Bravo',
    '',
    '## 2020-01-02',
    '<!-- from: me -->',
    'approve',
    '',
    '## 🌙 Overnight Agent',
    '<!-- from: overnight-agent -->',
    '<!-- oa-ask: offer -->',
    '',
    '**Status:** Done',
    '',
    '<!-- /overnight-agent turn-end -->',
  ].join(nl2) + nl2;
  writeMaybeBom(path.join(root, 'planner', 'journal', 'task-1.md'), j1, maybe(r));
  writeMaybeBom(path.join(root, 'planner', 'journal', 'task-2.md'), j2, maybe(r));
  fs.writeFileSync(path.join(root, 'planner', 'planner.md'), ['## Today', '| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '| 1 | 🟡 | Alpha | P0 | 2020-01-01 | |', '', '## Deferred', '| 2 | ⚪ | Bravo | P1 | 2020-01-02 | 1 |', ''].join('\n'));
  fs.writeFileSync(path.join(root, 'planner', 'planner-completed.md'), '## Done\n');
}

function obsText(kind, ids) {
  if (kind === 'array') return JSON.stringify(ids.map((id, i) => ({ id, created: `2020-01-0${i + 1}T00:00:00Z` })), null, 2);
  if (kind === 'empty') return '[]';
  if (kind === 'unreadable') return 'Error: MCP request failed: Transport closed\n';
  return `Found ${ids.length} comments in document X\n` + ids.map((id, i) => `Comment ID: ${id}\nCreated: 2020-01-0${i + 1}T00:00:00Z\nText: hi`).join('\n');
}

function stepArgs(step, dirs) {
  const common = ['-JournalDir', dirs.journal, '-StateDir', dirs.state, '-PlannerBoard', dirs.board, '-PlannerCompleted', dirs.completed];
  const a = [step.command, ...common];
  for (const [k, v] of Object.entries(step.args || {})) {
    if (v === true) a.push(`-${k}`);
    else if (Array.isArray(v)) for (const x of v) a.push(`-${k}`, String(x));
    else a.push(`-${k}`, String(v));
  }
  return a;
}

function runImpl(impl, step, dirs, root) {
  const args = stepArgs(step, dirs);
  const env = { ...process.env, OA_SANDBOX_ROOT: root };
  if (impl === 'ps') {
    return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, ...args], { cwd: REPO, env, encoding: 'utf8', windowsHide: true });
  }
  return spawnSync(process.execPath, [NODE, ...args.map((x) => x.startsWith('-') ? '-' + x : x)], { cwd: REPO, env, encoding: 'utf8', windowsHide: true });
}

function normaliseRun(res, normalizer) {
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  const parsed = tryParseJson(stdout);
  return {
    exit: res.status ?? 0,
    stdout: parsed === undefined ? normalizer.text(stdout) : normalizer.value(parsed),
    stderr: cleanStderr(normalizer.text(stderr).split(/\r?\n/)),
  };
}

function listFiles(root) {
  const out = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  }
  walk(root); return out;
}
function decodeUtf8Bom(buf) {
  return new TextDecoder('utf-8').decode(buf.subarray(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0));
}
function tree(root, normalizer) {
  const result = {};
  for (const rel of listFiles(root)) {
    if (rel.includes('/obs-')) continue;
    const buf = fs.readFileSync(path.join(root, rel));
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    if (/^state\/task-\d+\.json$/.test(rel)) {
      result[rel] = { bom, json: normalizer.value(JSON.parse(decodeUtf8Bom(buf))) };
    } else {
      result[rel] = { bom, bytes: buf.toString('base64') };
    }
  }
  return result;
}

function randomStep(r, seq, i, roots) {
  const ids = ['1', '2', '3'];
  const cmd = pick(r, ['seed', 'mark', 'mark', 'mark', 'resnapshot', 'doc', 'doc']);
  if (cmd === 'seed') return { command: 'seed', args: maybe(r, 0.35) ? { Force: true } : {} };
  if (cmd === 'resnapshot') return { command: 'resnapshot', args: {} };
  if (cmd === 'mark') {
    const args = {};
    if (!maybe(r, 0.08)) args.Id = pick(r, ids);
    if (maybe(r, 0.45)) args.Status = pick(r, ['done', 'blocked', 'in-progress', 'proposed', 'skip']);
    if (maybe(r, 0.25)) args.StatusBy = pick(r, ['user', 'agent']);
    if (maybe(r, 0.2)) args.TurnBy = pick(r, ['sess-a', 'sess-b']);
    if (maybe(r, 0.2)) args.Version = Math.floor(r() * 3) + 1;
    if (maybe(r, 0.2)) args.PlanId = `p${Math.floor(r() * 5)}`;
    const timer = pick(r, ['none', 'poll', 'polldone', 'pollclear', 'recheck', 'recheckdone', 'recheckclear', 'recheckkind', 'exhausted', 'badcadence']);
    if (timer === 'poll') args.Poll = pick(r, ['hourly', 'daily', '2h', '15m']);
    if (timer === 'polldone') args.PollDone = true;
    if (timer === 'pollclear') args.PollClear = true;
    if (timer === 'recheck') { args.Recheck = pick(r, ['weekly', '3h', '20m']); if (maybe(r)) args.RecheckKind = pick(r, ['ci', 'oauth']); }
    if (timer === 'recheckdone') args.RecheckDone = true;
    if (timer === 'recheckclear') args.RecheckClear = true;
    if (timer === 'recheckkind') args.RecheckKind = pick(r, ['date', 'browser-slot']);
    if (timer === 'badcadence') args.Poll = 'nonsense';
    if (timer === 'exhausted') { args.Exhausted = maybe(r) ? 'gh:1,gh:2' : ''; if (maybe(r)) args.ExhaustedNote = 'checked queue'; }
    return { command: 'mark', args };
  }
  const args = { Id: pick(r, ids) };
  const form = pick(r, ['read', 'bind', 'bindurl', 'forcebind', 'observe', 'ack', 'unbind']);
  if (form === 'bind') args.DocId = pick(r, ['docA', 'docB']);
  if (form === 'bindurl') { args.DocId = 'docA'; args.DocUrl = 'https://docs.example/docA'; }
  if (form === 'forcebind') { args.DocId = 'docB'; args.Force = true; }
  if (form === 'observe') {
    const kind = pick(r, ['array', 'dump', 'empty', 'unreadable']);
    const rel = `obs-${seq}-${i}.json`;
    for (const root of roots) fs.writeFileSync(path.join(root, rel), obsText(kind, [`C${seq}${i}A`, `C${seq}${i}B`]), 'utf8');
    args.Observe = rel;
  }
  if (form === 'ack') args.Ack = true;
  if (form === 'unbind') args.Unbind = true;
  return { command: 'doc', args };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  rm(SCRATCH); mkdir(SCRATCH);
  const r = rng(o.seed);
  try {
    for (let s = 0; s < o.n; s++) {
      const base = path.join(SCRATCH, `seq-${s}-base`);
      const psRoot = path.join(SCRATCH, `seq-${s}-ps`);
      const nodeRoot = path.join(SCRATCH, `seq-${s}-node`);
      makeBase(base, r); copyDir(base, psRoot); copyDir(base, nodeRoot);
      const dirs = (root) => ({ journal: path.join(root, 'planner', 'journal'), state: path.join(root, 'state'), board: path.join(root, 'planner', 'planner.md'), completed: path.join(root, 'planner', 'planner-completed.md'), root });
      for (let i = 0; i < o.steps; i++) {
        const step = randomStep(r, s, i, [psRoot, nodeRoot]);
        const t0 = Date.now();
        const normalizer = makeNormalizer({ t0, pathTokens: [['<ROOT>', psRoot], ['<ROOT>', nodeRoot], ['<REPO>', REPO]] });
        const pr = runImpl('ps', step, dirs(psRoot), psRoot);
        const nr = runImpl('node', step, dirs(nodeRoot), nodeRoot);
        const po = normaliseRun(pr, normalizer);
        const no = normaliseRun(nr, normalizer);
        let diff = firstDifference(po, no);
        if (!diff) diff = firstDifference(tree(psRoot, normalizer), tree(nodeRoot, normalizer));
        if (diff) {
          console.error(`mutate-diff mismatch seed=${o.seed} seq=${s} step=${i} ${JSON.stringify(step)}: ${diff}`);
          console.error('ps:', stableStringify(po));
          console.error('node:', stableStringify(no));
          process.exitCode = 1; return;
        }
      }
    }
    console.log(`mutate-diff: ${o.n} sequences x ${o.steps} steps (${o.n * o.steps} steps), seed ${o.seed}: 0 differences`);
  } finally {
    if (!o.keep) rm(SCRATCH);
  }
}

main();

