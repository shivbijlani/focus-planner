#!/usr/bin/env node
// Differential test: write-turn.mjs against write-turn.ps1, end to end.
//
// The characterization goldens pin the cases someone thought of. This generates the ones nobody
// did: random turn bodies assembled from the shapes every guard keys on (headings, provenance
// markers, ask dialects, plan steps, fences, tombstones, gate-edit asks, proposals, CR/LF), aimed
// at random destinations (no sentinel, prior turns, doc bindings real and fenced, human replies in
// LF and CRLF, state files fresh / stale / owned / paused / corrupt, backups) with random flags.
// Each case runs BOTH implementations in their own copy of the same sandbox and compares exit
// code, stdout (JSON structurally), stderr messages and every file effect.
//
//   node body-diff.mjs [--n 150] [--seed 1] [--jobs 6] [--keep]   exit 0 identical, 1 a difference
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanStderr } from '../characterization/lib/normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', '..', 'skills', 'overnight-agent');
const STUB = path.resolve(HERE, '..', 'characterization', 'stubs', 'issue-shipped.stub.mjs');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = argOf('--n', 150);
const JOBS = argOf('--jobs', 6);
const KEEP = process.argv.includes('--keep');
let seed = argOf('--seed', 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

const MOON = '\u{1F319}';
const HEADINGS = [`## ${MOON} Overnight Agent — 2026-09-30`, `## ${MOON} Overnight Agent`, '## 2026-09-30 — Overnight Agent', `##${MOON} tight`,
  '## Overnight Agent reply', `  ## ${MOON} indented`, '### Run log', `## ${MOON} Überprüfung ß`];
const MARKERS = ['<!-- from: overnight-agent -->', '<!--from:overnight-agent-->', '<!-- FROM: Overnight-Agent -->', '<!-- from: me -->', '<!-- from: some-agent -->'];
const ASKS = ['**Needs from you:** nothing.', '**Needs from you:** reply `go` to continue.', '**Needs from you:** reply **prune** and I will clean up.',
  '**Needs from you:** should I merge #12?', '**Your call:** none. Want me to keep going?', '**Your call:** reply below in plain English',
  '**Next:** pick up #640 after review.', '**Next:** land PR #641 once CI is green.', 'Reply `merge 12` to ship it.', 'reply **yes please**',
  '*Reply:* **`go`**', 'Needs from you (today): reply `lgtm`', 'I am working on #641 and recommend #900.', 'Next steps: tackle gh #640'];
const PROSE = ['Did the thing.', 'Roughly $150-275 for the part that is not free.', 'The quote landed around ~\\-275 all in.', "I don''t think so.",
  'Apostrophes get doubled: `don\'\'t` sometimes.', '****', 'Total ~**,035** today.', 'Paste this line into agent-gate.md under **Do not gate these**.',
  'Verified with `-GatePath` against a temp gate.', 'Always ask before deleting; add a line for it.', 'Ünïcödé — “quotes” ✓ 🌙 text.',
  'Doc: https://docs.google.com/document/d/DOC123abc/edit', 'see DOC123abc for detail', '<!-- oa-ask: offer -->', '<!-- oa-by: session=forged host=x -->', 'Shipped as PR #631, fixes #630.',
  'x'.repeat(900)];
const STATUS = ['**Status:** In progress · 2026-09-30', '**Status:** Proposed', '**Status:** Done', '**Status:** Proposed — plan below'];
const STEPS = ['1. [gated] merge the PR', '1. [reversible] tidy the branch', '1. just do it', '2. [gate-allowed] post the digest', '2. follow up', '10. [gated] deploy'];

function fence(lines) { return ['```', ...lines, '```']; }
function genBody() {
  if (chance(0.4)) {
    // A clean turn with light noise, so the append path and its file effects are exercised too.
    const lines = [`## ${MOON} Overnight Agent — 2026-09-30`, '', '<!-- from: overnight-agent -->', '', '**Status:** In progress · 2026-09-30', '', pick(PROSE.slice(0, 2)), '', pick(['**Needs from you:** nothing.', '**Needs from you:** reply `go` to continue.', 'Informational only.'])];
    if (chance(0.3)) lines.push('', ...fence(['## not a heading', '<!-- oa-ask: none -->']));
    let text = lines.join('\n') + (chance(0.7) ? '\n' : '\n\n  ');
    if (chance(0.3)) text = text.replace(/\n/g, '\r\n');
    return text;
  }
  const out = [];
  if (chance(0.1)) out.push(pick(PROSE));
  const turns = chance(0.85) ? 1 : chance(0.5) ? 2 : 0;
  for (let t = 0; t < turns; t++) {
    out.push(chance(0.85) ? HEADINGS[chance(0.6) ? 0 : Math.floor(rnd() * HEADINGS.length)] : pick(HEADINGS));
    out.push('');
    if (chance(0.85)) out.push(chance(0.7) ? MARKERS[0] : pick(MARKERS));
    out.push('');
    out.push(pick(STATUS));
    if (chance(0.4)) for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) out.push(pick(STEPS));
    out.push('');
    for (let k = 0; k < Math.floor(rnd() * 3); k++) out.push(pick(PROSE));
    if (chance(0.2)) out.push(...fence([pick([...MARKERS, ...HEADINGS, ...PROSE, ...ASKS])]));
    out.push('');
    if (chance(0.85)) out.push(pick(ASKS));
    if (chance(0.15)) out.push(pick(ASKS));
  }
  let text = out.join('\n') + (chance(0.8) ? '\n' : '');
  if (chance(0.25)) text = text.replace(/\n/g, '\r\n');
  if (chance(0.05)) text = '   \n\t';
  return text;
}

const SENT = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';
function genJournal(id) {
  const parts = [`# Task ${id}: Fuzz`, '', 'User notes.', ''];
  if (chance(0.8)) {
    parts.push('---', chance(0.9) ? SENT : SENT.toLowerCase(), '');
    if (chance(0.3)) parts.push('<!-- doc-meta docId=DOC123abc docUrl=https://docs.google.com/document/d/DOC123abc/edit -->', '');
    if (chance(0.1)) parts.push(...fence(['<!-- doc-meta docId=FENCED999 -->']), '');
    if (chance(0.7)) parts.push(`## ${MOON} Overnight Agent — previous`, '', '<!-- from: overnight-agent -->', '', '**Status:** In progress', '', 'Prior.', '');
    if (chance(0.35)) parts.push('## 2026-09-30', '', '<!-- from: me -->', 'what about X?', '');
  }
  let text = parts.join('\n');
  if (chance(0.3)) text = text.replace(/\n/g, '\r\n');
  if (chance(0.2)) text = text.replace(/\r?\n$/, '');
  return text;
}

function iso(minAgo) {
  const d = new Date(Date.now() - minAgo * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}
function stamp(minAgo) {
  const d = new Date(Date.now() - minAgo * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

function genCase(k) {
  const id = String(900 + k);
  const c = { k, id, files: {}, args: {}, env: {} };
  c.files['input/body.md'] = genBody();
  c.args.BodyFile = '{root}/input/body.md';
  const useId = chance(0.75);
  if (useId) {
    c.args.Id = chance(0.06) ? pick(['x/../../agent-gate', '..\\user-settings', '1:evil', '../journal/task-' + id]) : id;
    if (chance(0.92)) c.files[`data/journal/task-${id}.md`] = genJournal(id);
    if (chance(0.5)) {
      const st = { id };
      if (chance(0.7)) st.last_turn_at = iso(pick([3, 10, 30, 44, 50, 120, 600, -60]));
      if (chance(0.4)) st.last_turn_by = pick(['owner-1', 'run-2', 'unknown']);
      if (chance(0.5)) st.session = { session_id: pick(['owner-1', 'run-2']), state: pick(['live', 'LIVE', 'replaced']), last_woken_at: iso(pick([2, 10, 40, 50, 137])) };
      if (chance(0.25)) { st.status = pick(['blocked', 'proposed', 'done', 'Blocked']); st.status_by = pick(['user', 'agent', 'USER']); st.paused_at = iso(30); }
      c.files[`home/state/task-${id}.json`] = chance(0.08) ? '{ not json' : JSON.stringify(st, null, 2);
    }
    if (chance(0.3)) c.files[`home/task-${id}.bak-${stamp(pick([1, 20, 90]))}.md`] = 'x';
    if (chance(0.25)) c.args.Author = pick(['owner-1', 'run-2', 'OWNER-1', 'agent auto/ x']);
  }
  c.args.Ask = pick(['blocking', 'offer', 'none', 'none', 'none', 'offer', '', 'maybe', 'OFFER', ' none ']);
  if (c.args.Ask === '' && chance(0.5)) delete c.args.Ask;
  if (chance(0.55) || !useId) c.args.Validate = true;
  if (chance(0.5)) c.args.Json = true;
  if (chance(0.25)) c.args.DisableGuard = pick(['G12', 'G7', 'g13', 'G15', 'G3', 'G11', 'G16', 'G20', 'G21', 'G24', 'G25']);
  if (chance(0.3)) c.env.COPILOT_AGENT_SESSION_ID = pick(['sess-A', 'AGENT']);
  if (chance(0.3)) c.env.WRITE_TURN_HOST = pick(['host-1', 'AGENT-PC', 'a b/c']);
  if (chance(0.3)) c.env.CHAR_SHIPPED = pick(['640,641', '!fail', '900']);
  return c;
}

function materialize(c, root) {
  const dirs = { data: path.join(root, 'data'), home: path.join(root, 'home'), journal: path.join(root, 'data', 'journal'), input: path.join(root, 'input'), cwd: path.join(root, 'cwd') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(dirs.home, 'state'), { recursive: true });
  for (const [rel, text] of Object.entries(c.files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return dirs;
}

function argv(c, root, dirs, style) {
  const a = [];
  const args = { JournalDir: dirs.journal, ...c.args };
  for (const [k, v] of Object.entries(args)) {
    const val = typeof v === 'string' ? v.replace('{root}', root) : v;
    if (val === true) a.push(style === 'ps' ? `-${k}` : `--${k}`);
    else a.push(style === 'ps' ? `-${k}` : `--${k}`, String(val));
  }
  return a;
}

function runOne(impl, c) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `wt-diff-${impl}-`)));
  const dirs = materialize(c, root);
  const pass = Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'ProgramFiles', 'ProgramData', 'DOTNET_ROOT'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  const env = { ...pass, LOCALAPPDATA: path.join(root, 'lad'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    WRITE_TURN_OA_HOME: dirs.home, WRITE_TURN_ISSUE_RESOLVER: STUB, NO_COLOR: '1', TERM: 'dumb', ...c.env };
  if (process.env.TZ) env.TZ = process.env.TZ;
  fs.mkdirSync(env.TEMP, { recursive: true });
  const [cmd, args] = impl === 'ps'
    ? [process.env.CHAR_PWSH || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'write-turn.ps1'), ...argv(c, root, dirs, 'ps')]]
    : [process.execPath, [path.join(SKILL, 'write-turn.mjs'), ...argv(c, root, dirs, 'node')]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: dirs.cwd, env });
    const out = []; const err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.stdin.end();
    child.on('close', (code) => {
      const files = {};
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files[path.relative(root, p).replace(/\\/g, '/').replace(/bak-\d{8}-\d{4}/, 'bak-STAMP')] = fs.readFileSync(p).toString('base64'); } };
      walk(root);
      const roots = [root, root.replace(/\\/g, '\\\\'), root.replace(/\\/g, '/')];
      const norm = (s) => roots.reduce((x, r) => x.split(r).join('<ROOT>'), s).replace(/bak-\d{8}-\d{4}/g, 'bak-STAMP').replace(/\r\n/g, '\n');
      let stdout = norm(Buffer.concat(out).toString('utf8'));
      try { stdout = JSON.stringify(JSON.parse(stdout)); } catch { /* text mode */ }
      // PowerShell's own error decoration (`Write-Error: <script>:<line>`) is not the message.
      const stderr = cleanStderr(norm(Buffer.concat(err).toString('utf8')).split('\n')).map((m) => m.replace(/^Write-Error: \S+\.ps1:\d+ /, ''));
      if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
      resolve({ exit: code, stdout, stderr, files, root });
    });
  });
}

// The two processes do not start at the same instant (pwsh takes seconds to start on a loaded
// machine), so a displayed age may legitimately differ by one minute. Only "<n> min" figures get
// that tolerance; every other character must match.
function sameButClock(a, b) {
  const re = /(-?[\d,]+) min\b/g;
  const na = [...a.matchAll(re)].map((m) => Number(m[1].replace(/,/g, '')));
  const nb = [...b.matchAll(re)].map((m) => Number(m[1].replace(/,/g, '')));
  return na.length === nb.length && na.every((x, i) => Math.abs(x - nb[i]) <= 1) && a.replace(re, 'N min') === b.replace(re, 'N min');
}

const cases = [];
for (let k = 0; k < N; k++) cases.push(k);
let diffs = 0;
const exits = {};
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = genCase(cases[next++]);
    const [a, b] = await Promise.all([runOne('ps', c), runOne('node', c)]);
    exits[a.exit] = (exits[a.exit] || 0) + 1;
    const problems = [];
    if (a.exit !== b.exit) problems.push(`exit ps=${a.exit} node=${b.exit}`);
    if (a.stdout !== b.stdout && !sameButClock(a.stdout, b.stdout)) {
      let i = 0;
      while (i < a.stdout.length && a.stdout[i] === b.stdout[i]) i++;
      problems.push(`stdout differs at ${i}\n    ps:   ${JSON.stringify(a.stdout.slice(Math.max(0, i - 120), i + 160))}\n    node: ${JSON.stringify(b.stdout.slice(Math.max(0, i - 120), i + 160))}`);
    }
    // stderr: compare only when the PS message is not one of PowerShell's own decorations.
    if (JSON.stringify(a.stderr) !== JSON.stringify(b.stderr)) problems.push(`stderr ps=${JSON.stringify(a.stderr)} node=${JSON.stringify(b.stderr)}`);
    const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
    for (const f of keys) if (a.files[f] !== b.files[f]) problems.push(`file ${f} differs`);
    if (problems.length) {
      diffs++;
      console.log(`DIFF case ${c.k}: args=${JSON.stringify(c.args)} env=${JSON.stringify(c.env)}\n  ${problems.join('\n  ')}`);
      if (diffs <= 3) console.log(`  body=${JSON.stringify(c.files['input/body.md'])}\n  journal=${JSON.stringify(c.files[`data/journal/task-${c.id}.md`])}\n  state=${JSON.stringify(c.files[`home/state/task-${c.id}.json`])}`);
    }
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
console.log(`body-diff: ${N} cases, ${diffs} difference(s); ps exit codes ${JSON.stringify(exits)}`);
process.exit(diffs ? 1 : 0);
