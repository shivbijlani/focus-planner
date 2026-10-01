#!/usr/bin/env node
// Command-level differential test for `oa-state consent`: PowerShell vs Node, both read-only.
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

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const N = Number(arg('--n', '200'));
const SEED = Number(arg('--seed', '424242')) >>> 0;
const JOBS = Math.max(1, Number(arg('--jobs', '8')));

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6D2B79F5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const maybe = (r, p) => r() < p;

const actions = ['', 'merge_pr', 'open_pr', 'send_email_self', 'send_email_many', 'delete_data', 'spend_money', 'deploy'];
const repos = ['', 'sample-repo', 'sample', 'docs-site', 'owner/sample-repo'];
const affirm = ['approve', 'approved', 'yes', 'go ahead', 'go', 'lgtm', 'ship it', 'do it', 'vibe it', 'send it', 'make it so', 'proceed', 'merge 12'];
const nonAffirm = ['merge it later', 'not now', 'can you explain?', 'hold off', 'done already', 'maybe tomorrow'];
const authors = ['me', 'overnight-agent', 'dance-church', 'unknown-helper'];

function fenced(r) {
  return ['```', '<!-- from: me -->', 'approve', '## Overnight Agent quoted', '```'].join(maybe(r, 0.5) ? '\r\n' : '\n');
}

function journal(r, id, docId) {
  const nl = maybe(r, 0.35) ? '\r\n' : '\n';
  const lines = [`# Task ${id}: consent fuzz`];
  if (maybe(r, 0.45)) lines.push(`<!-- doc-meta docId=${docId} docUrl=https://docs.example/${docId} -->`);
  if (maybe(r, 0.3)) lines.push(fenced(r));
  lines.push('', '## 2026-09-01', '<!-- from: me -->', pick(r, nonAffirm));
  lines.push('', '---', '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->', '', '## 🌙 Overnight Agent', '<!-- from: overnight-agent -->', '<!-- oa-ask: blocking -->', '**Needs from you:** approve this exact action.', '<!-- /overnight-agent turn-end -->');
  const trailingCount = 1 + Math.floor(r() * 3);
  for (let i = 0; i < trailingCount; i++) {
    const author = pick(r, authors);
    lines.push('', `## 2026-09-${String(2 + i).padStart(2, '0')}`, `<!-- from: ${author} -->`);
    lines.push(maybe(r, 0.55) ? pick(r, affirm) : pick(r, nonAffirm));
    if (author === 'me' && maybe(r, 0.35)) {
      lines.push('', '## 🌙 Overnight Agent follow-up', '<!-- from: overnight-agent -->', 'I answered below that approval.');
    }
  }
  if (maybe(r, 0.25)) lines.push('', 'unstamped trailing prose says approve');
  return lines.join(nl) + nl;
}

function gate(r) {
  const allow = [
    maybe(r, 0.45) ? '- sample-repo is in YOLO mode, dont ask just do' : '',
    maybe(r, 0.45) ? '- Creating and publishing a pull request in any repository is fine' : '',
    maybe(r, 0.3) ? '- Emailing myself is ok' : '',
  ].filter(Boolean);
  const ask = [
    maybe(r, 0.45) ? '- Send-to-many (group/channel, mass email)' : '',
    maybe(r, 0.35) ? '- Never risk data loss or destructive irreversible deletes' : '',
    maybe(r, 0.25) ? '- Spending money should always ask' : '',
  ].filter(Boolean);
  return ['# Agent gate', '<!-- planner-agent-gate v1 -->', '', '## Do not gate these (reversible)', ...allow, '', '## Always ask (safety floor)', ...ask, ''].join('\n');
}

function docDump(r, docId) {
  if (maybe(r, 0.2)) return null;
  if (maybe(r, 0.3)) return `Found 1 comments in document ${docId}:\n\nComment ID: C1\nAuthor: Shiv Bijlani\nCreated: 2026-09-09T15:33:45.386Z\nContent: ${pick(r, affirm)}\n`;
  if (maybe(r, 0.25)) return `Found 2 comments in document ${docId}:\n\nComment ID: C1\nAuthor: Shiv Bijlani\nCreated: 2026-09-09T15:33:45.386Z\nContent: ${pick(r, affirm)}\n\nComment ID: C2\nAuthor: Shiv Bijlani\nCreated: 2026-09-10T10:00:00.000Z\nContent: noted\n\n-- overnight-agent [oa-comment:v1]\n`;
  return `Found 1 comments in document ${docId}:\n\nComment ID: C9\nAuthor: Shiv Bijlani\nCreated: 2026-09-09T15:33:45.386Z\nContent: ${pick(r, nonAffirm)}\n`;
}

function writeFixture(root, i) {
  const r = rng(SEED + i * 2654435761);
  const data = path.join(root, 'data');
  const journalDir = path.join(data, 'journal');
  const stateDir = path.join(root, 'state');
  const inputDir = path.join(root, 'input');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  const id = String(900 + i);
  const docId = `DOC${i}`;
  fs.writeFileSync(path.join(journalDir, `task-${id}.md`), journal(r, id, docId), 'utf8');
  fs.writeFileSync(path.join(data, 'agent-gate.md'), gate(r), 'utf8');
  fs.writeFileSync(path.join(data, 'planner.md'), '# Planner\n\n## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|---|---|---|---|\n', 'utf8');
  fs.writeFileSync(path.join(data, 'planner-completed.md'), '', 'utf8');
  let docPath = '';
  const dump = docDump(r, docId);
  if (dump !== null) {
    docPath = path.join(inputDir, 'comments.txt');
    fs.writeFileSync(docPath, dump, 'utf8');
  } else if (maybe(r, 0.5)) {
    docPath = path.join(inputDir, 'missing.txt');
  }
  const action = pick(r, actions);
  return { id, action, repo: pick(r, repos), docPath, journalDir, stateDir, gatePath: path.join(data, 'agent-gate.md') };
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
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

function runOne(kind, root, f) {
  const common = ['consent', '-Id', f.id, '-JournalDir', f.journalDir, '-StateDir', f.stateDir, '-GatePath', f.gatePath];
  if (f.action) common.push('-Action', f.action);
  if (f.repo) common.push('-Repo', f.repo);
  if (f.docPath) common.push('-DocComments', f.docPath);
  const argv = kind === 'ps' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...common] : [mjs, ...common];
  return spawnSync(kind === 'ps' ? pwsh : process.execPath, argv, { cwd: repo, encoding: 'utf8', windowsHide: true });
}

function runOneAsync(kind, f) {
  const common = ['consent', '-Id', f.id, '-JournalDir', f.journalDir, '-StateDir', f.stateDir, '-GatePath', f.gatePath];
  if (f.action) common.push('-Action', f.action);
  if (f.repo) common.push('-Repo', f.repo);
  if (f.docPath) common.push('-DocComments', f.docPath);
  const argv = kind === 'ps' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...common] : [mjs, ...common];
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
  return out.replace(/\r\n/g, '\n');
}

function normJson(s, roots) {
  const v = JSON.parse(s);
  const walk = (x) => Array.isArray(x) ? x.map(walk) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]))
    : typeof x === 'string' ? normString(x, roots) : x;
  return walk(v);
}

function sameObservation(ps, node, roots) {
  if ((ps.status ?? 0) !== (node.status ?? 0)) return `exit ps=${ps.status} node=${node.status}`;
  const pse = normString(ps.stderr, roots).trim();
  const noe = normString(node.stderr, roots).trim();
  if (pse !== noe) return `stderr\nPS: ${pse}\nNO: ${noe}`;
  try {
    const pj = normJson(ps.stdout, roots);
    const nj = normJson(node.stdout, roots);
    if (JSON.stringify(pj) !== JSON.stringify(nj)) return `stdout json\nPS: ${JSON.stringify(pj)}\nNO: ${JSON.stringify(nj)}`;
  } catch {
    const po = normString(ps.stdout, roots);
    const no = normString(node.stdout, roots);
    if (po !== no) return `stdout text\nPS: ${po.slice(0, 1000)}\nNO: ${no.slice(0, 1000)}`;
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
  const d = sameObservation(ps, node, roots);
  if (d) throw new Error(`case ${i}: ${d}`);
  if (treeHash(psRoot) !== beforePs) throw new Error(`case ${i}: PowerShell wrote to fixture tree`);
  if (treeHash(nodeRoot) !== beforeNode) throw new Error(`case ${i}: Node wrote to fixture tree`);
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-consent-diff-'));
  try {
    let next = 0;
    const workers = Array.from({ length: Math.min(JOBS, N) }, async () => {
      while (next < N) await runCase(work, next++);
    });
    await Promise.all(workers);
    console.log(`consent-diff: ${N} inputs, 0 differences (seed ${SEED})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
