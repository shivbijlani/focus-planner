#!/usr/bin/env node
// Command-level differential test for `oa-state extract`: PowerShell vs Node, both read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const skill = path.join(repo, 'plugins', 'overnight-agent', 'skills', 'overnight-agent');
const ps1 = path.join(skill, 'oa-state.ps1');
const mjs = path.join(skill, 'oa-state.mjs');
const pwsh = process.env.CHAR_PWSH || 'pwsh';

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const N = Number(arg('--n', '200'));
const SEED = Number(arg('--seed', '8675309')) >>> 0;
const JOBS = Math.max(1, Number(arg('--jobs', '8')));

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x9E3779B9) >>> 0;
    let t = x;
    t ^= t >>> 16; t = Math.imul(t, 0x7feb352d); t ^= t >>> 15; t = Math.imul(t, 0x846ca68b); t ^= t >>> 16;
    return (t >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const maybe = (r, p) => r() < p;

const fixturesDir = path.join(repo, 'plugins', 'overnight-agent', 'tests', 'characterization', 'fixtures', 'base', 'data', 'journal');
const fixtureTexts = fs.existsSync(fixturesDir)
  ? fs.readdirSync(fixturesDir).filter((f) => /^task-.*\.md$/i.test(f)).slice(0, 16).map((f) => fs.readFileSync(path.join(fixturesDir, f), 'utf8'))
  : [];

const prose = [
  'approve', 'merge 12', 'merge it later', 'go ahead', 'hold off',
  'non-ASCII café - emoji 🐸 🌙 and quotes yes',
  '**Needs from you:** ASK-SENTINEL please confirm.',
  'TODO: one item',
  'DONE: completed item',
  '<!-- from: me --> inline marker only',
];

function fence(r) {
  const q = pick(r, ['```', '~~~~']);
  return [q, '<!-- from: overnight-agent -->', '## Overnight Agent quoted', '**Needs from you:** approve', pick(r, prose), q[0] === '`' ? '```' : '~~~~'].join('\n');
}

function turn(r, author, newest = false) {
  const lines = [pick(r, ['## 2026-09-01', '## 2026-10-01', '## 🌙 Overnight Agent', '## Overnight Agent -- run']), `<!-- from: ${author} -->`];
  if (author === 'overnight-agent' && maybe(r, 0.45)) lines.push(pick(r, ['<!-- oa-ask: blocking -->', '<!-- oa-ask: offer -->', '<!-- oa-ask: none -->']));
  if (author === 'overnight-agent' && maybe(r, 0.6)) lines.push(`**Status:** ${pick(r, ['In-progress', 'Proposed · plan v1', 'Done'])}`);
  for (let i = 0, c = 1 + Math.floor(r() * (newest ? 16 : 5)); i < c; i++) lines.push(`${newest ? 'NEWEST-' : ''}${pick(r, prose)} ${'filler '.repeat(Math.floor(r() * 40))}`);
  if (maybe(r, 0.3)) lines.push(fence(r));
  if (author === 'overnight-agent' && maybe(r, 0.55)) lines.push('<!-- /overnight-agent turn-end -->');
  return lines.join('\n');
}

function journal(r, id) {
  if (fixtureTexts.length && maybe(r, 0.15)) return pick(r, fixtureTexts);
  const nl = maybe(r, 0.35) ? '\r\n' : '\n';
  const lines = [`# Task ${id}: extract fuzz`, maybe(r, 0.3) ? '<!-- tg-meta chatId=-1 threadId=2 -->' : '', '', `HEAD-SENTINEL for ${id}`, maybe(r, 0.7) ? `**Linked:** #${pick(r, ['101', '102', id])}, #${1000 + Number(id)}` : ''];
  for (let i = 0; i < 1 + Math.floor(r() * 10); i++) lines.push(`head paragraph ${i} ${'filler prose '.repeat(20 + Math.floor(r() * 40))}`);
  if (maybe(r, 0.25)) lines.push(fence(r));
  if (maybe(r, 0.2)) lines.push('<!-- oa-state', '{"status":"approved","version":2}', '-->');
  if (maybe(r, 0.8)) {
    lines.push('', '---', '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->');
    for (let k = 0, c = 1 + Math.floor(r() * 5); k < c; k++) lines.push('', turn(r, pick(r, ['me', 'overnight-agent', 'dance-church'])));
    lines.push('', turn(r, 'overnight-agent', true));
  }
  if (maybe(r, 0.65)) lines.push('', turn(r, 'me'));
  return lines.filter((x) => x !== '').join(nl) + nl;
}

function planner(r, id) {
  const linked = maybe(r, 0.65) ? pick(r, ['101', '102', `${id}`, `#${1000 + Number(id)}`]) : '';
  const deferredLinked = maybe(r, 0.45) ? `${linked}; #333` : '';
  return [
    '# Planner',
    '',
    '## Today',
    '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
    '|---|---|---|---|---|---|',
    `| ${id}${maybe(r, 0.25) ? ',[77](https://example.test/77)' : ''} | 🟡 | Task ${id} | ${pick(r, ['P0', 'P1', 'P2', ''])} | 2026-01-01 | ${linked} |`,
    `| ${Number(id) + 1} | 🔴 | Sibling | P1 | 2026-01-02 | ${id} | <!-- snooze:2999-01-01 -->`,
    '',
    '## Deferred',
    '| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |',
    '|---|---|---|---|---|---|---|',
    `| ${Number(id) + 2} | ⚪ | Deferred | P2 | 2026-01-03 | 2026-02-01 | ${deferredLinked} |`,
    '',
    '## Priorities',
    `1. ${id}`,
    '',
  ].join(maybe(r, 0.35) ? '\r\n' : '\n');
}

function writeFixture(root, i) {
  const r = rng(SEED + i * 1103515245);
  const data = path.join(root, 'data');
  const journalDir = path.join(data, 'journal');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const id = String(700 + i);
  fs.writeFileSync(path.join(journalDir, `task-${id}.md`), journal(r, id), 'utf8');
  fs.writeFileSync(path.join(data, 'planner.md'), planner(r, id), 'utf8');
  fs.writeFileSync(path.join(data, 'planner-completed.md'), '', 'utf8');
  fs.writeFileSync(path.join(data, 'agent-gate.md'), '# Agent gate\n', 'utf8');
  if (maybe(r, 0.7)) {
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++) fs.writeFileSync(path.join(journalDir, `task-${id}-deliverable-${k}.md`), `# Deliverable ${k}\n`, 'utf8');
  }
  const budget = pick(r, [1, 2, 4, 8, 24, 40]);
  const mode = pick(r, ['markdown', 'json', 'verify']);
  return { id, budget, mode, journalDir, stateDir, board: path.join(data, 'planner.md'), gatePath: path.join(data, 'agent-gate.md') };
}

function treeHash(root) {
  const rows = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p).replace(/\\/g, '/');
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else rows.push(`${rel}\0${fs.readFileSync(p).toString('base64')}`);
    }
  };
  walk(root);
  return rows.join('\n');
}

function runOne(kind, f) {
  const args = ['extract', '-Id', f.id, '-BudgetKB', String(f.budget), '-JournalDir', f.journalDir, '-StateDir', f.stateDir, '-PlannerBoard', f.board, '-GatePath', f.gatePath];
  if (f.mode === 'json') args.push('-Json');
  if (f.mode === 'verify') args.push('-Verify');
  const argv = kind === 'ps' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args] : [mjs, ...args];
  return spawnSync(kind === 'ps' ? pwsh : process.execPath, argv, { cwd: repo, encoding: 'utf8', windowsHide: true });
}

function runOneAsync(kind, f) {
  const args = ['extract', '-Id', f.id, '-BudgetKB', String(f.budget), '-JournalDir', f.journalDir, '-StateDir', f.stateDir, '-PlannerBoard', f.board, '-GatePath', f.gatePath];
  if (f.mode === 'json') args.push('-Json');
  if (f.mode === 'verify') args.push('-Verify');
  const argv = kind === 'ps' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args] : [mjs, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(kind === 'ps' ? pwsh : process.execPath, argv, { cwd: repo, windowsHide: true });
    const out = []; const err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

function normString(s, roots) {
  let out = String(s ?? '');
  for (const v of Object.values(roots)) out = out.split(v).join('{ROOT}').split(v.replace(/\//g, '\\')).join('{ROOT}');
  out = out.replace(/[\u2013\u2014]/g, '-');
  out = Array.from(out, (ch) => ch.codePointAt(0) > 0xffff ? '??' : ch.codePointAt(0) > 0x7f ? '?' : ch).join('');
  return out.replace(/\r\n/g, '\n');
}

function normJson(s, roots) {
  const v = JSON.parse(s);
  const walk = (x) => Array.isArray(x) ? x.map(walk) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]))
    : typeof x === 'string' ? normString(x, roots) : x;
  return walk(v);
}

function compare(ps, node, roots, mode) {
  if ((ps.status ?? 0) !== (node.status ?? 0)) return `exit ps=${ps.status} node=${node.status}`;
  const pse = normString(ps.stderr, roots).trim();
  const noe = normString(node.stderr, roots).trim();
  if (pse !== noe) return `stderr\nPS: ${pse}\nNO: ${noe}`;
  if (mode === 'json' || mode === 'verify') {
    const pj = normJson(ps.stdout, roots);
    const nj = normJson(node.stdout, roots);
    if (JSON.stringify(pj) !== JSON.stringify(nj)) return `stdout json\nPS: ${JSON.stringify(pj).slice(0, 1200)}\nNO: ${JSON.stringify(nj).slice(0, 1200)}`;
  } else {
    const po = normString(ps.stdout, roots);
    const no = normString(node.stdout, roots);
    if (po !== no) return `stdout text\nPS: ${po.slice(0, 1200)}\nNO: ${no.slice(0, 1200)}`;
  }
  return null;
}

async function runCase(work, i) {
  const psRoot = path.join(work, `case-${i}`, 'ps');
  const nodeRoot = path.join(work, `case-${i}`, 'node');
  fs.mkdirSync(psRoot, { recursive: true });
  fs.mkdirSync(nodeRoot, { recursive: true });
  const fps = writeFixture(psRoot, i);
  const fno = writeFixture(nodeRoot, i);
  const beforePs = treeHash(psRoot);
  const beforeNode = treeHash(nodeRoot);
  const [ps, node] = await Promise.all([runOneAsync('ps', fps), runOneAsync('node', fno)]);
  const roots = { PSROOT: psRoot, NODEROOT: nodeRoot };
  const d = compare(ps, node, roots, fps.mode);
  if (d) throw new Error(`case ${i} (${fps.mode}/${fps.budget}KB): ${d}`);
  if (treeHash(psRoot) !== beforePs) throw new Error(`case ${i}: PowerShell wrote to fixture tree`);
  if (treeHash(nodeRoot) !== beforeNode) throw new Error(`case ${i}: Node wrote to fixture tree`);
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-extract-diff-'));
  let ok = false;
  try {
    let next = 0;
    const workers = Array.from({ length: Math.min(JOBS, N) }, async () => {
      while (next < N) await runCase(work, next++);
    });
    await Promise.all(workers);
    console.log(`extract-diff: ${N} inputs, 0 differences (seed ${SEED})`);
    ok = true;
  } finally {
    if (ok) fs.rmSync(work, { recursive: true, force: true });
    else console.error(`extract-diff scratch kept at ${work}`);
  }
}

main().catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
