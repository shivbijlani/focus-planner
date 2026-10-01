#!/usr/bin/env node
// Shadow comparison for the write-turn cutover (local only; refuses under CI).
//
// Copies the owner's live journal folder and Overnight Agent state into a temp sandbox -- the
// live folders are only READ -- and, for every journal, re-validates the newest agent turn it
// already contains against its own task with BOTH write-turn.ps1 and write-turn.mjs
// (`-Id <id> -BodyFile <turn> -Ask <its declared ask> -Validate -Json`, read-only). Any
// difference in exit code or JSON verdict is printed. Backups are recreated as empty files with
// their real names, because G12 reads only their names.
//
//   node shadow-write-turn.mjs [--data <planner folder>] [--home <OA home>] [--limit N] [--jobs 6] [--out <file>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CI) { console.error('shadow-write-turn.mjs reads live data and never runs in CI'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', '..', 'skills', 'overnight-agent');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DATA = arg('--data', process.env.PLANNER_PATH || path.join(os.homedir(), 'OneDrive', 'Apps', 'Focus Planner'));
const HOME = arg('--home', path.join(process.env.LOCALAPPDATA || '', 'overnight-agent'));
const LIMIT = Number(arg('--limit', 100000));
const JOBS = Number(arg('--jobs', 6));
const OUT = arg('--out', null);

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-shadow-')));
const jdir = path.join(root, 'journal');
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, 'state'), { recursive: true });
fs.cpSync(path.join(DATA, 'journal'), jdir, { recursive: true });
for (const f of fs.readdirSync(path.join(HOME, 'state'))) if (/^task-.*\.json$/.test(f)) fs.copyFileSync(path.join(HOME, 'state', f), path.join(home, 'state', f));
let baks = 0;
for (const f of fs.readdirSync(HOME)) if (/^task-.*\.bak-\d{8}-\d{4}\.md$/i.test(f)) { fs.writeFileSync(path.join(home, f), ''); baks++; }

const MOON = '\u{1F319}';
const journals = fs.readdirSync(jdir).filter((f) => /^task-[^.]+\.md$/.test(f))
  .map((f) => ({ f, id: f.slice(5, -3), m: fs.statSync(path.join(jdir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m).slice(0, LIMIT);
console.log(`[shadow] sandbox ${root}: ${journals.length} journal(s), ${fs.readdirSync(path.join(home, 'state')).length} state file(s), ${baks} backup name(s)`);

function newestTurn(text) {
  const lines = text.split(/\r?\n/);
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (/^[ \t]*##[ \t]*/.test(lines[i]) && lines[i].includes(MOON)) at = i;
  if (at < 0) return null;
  return lines.slice(at).join('\n');
}

function run(impl, id, body, ask) {
  const env = { ...process.env, WRITE_TURN_OA_HOME: home, COPILOT_AGENT_SESSION_ID: '', OA_SANDBOX_ROOT: root, OVERNIGHT_AGENT_PLANNER_DIR: root };
  const a = ['-Id', id, '-BodyFile', body, '-JournalDir', jdir, '-Ask', ask, '-Validate', '-Json'];
  const [cmd, args] = impl === 'ps'
    ? ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'write-turn.ps1'), ...a]]
    : [process.execPath, [path.join(SKILL, 'write-turn.mjs'), ...a]];
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: root, env });
    const out = [];
    c.stdout.on('data', (b) => out.push(b));
    c.stderr.on('data', () => {});
    c.stdin.end();
    c.on('close', (code) => {
      const s = Buffer.concat(out).toString('utf8');
      let j = null;
      try { j = JSON.parse(s); } catch { j = s.trim(); }
      resolve({ code, j });
    });
  });
}

const minTol = (s) => JSON.stringify(s).replace(/(-?[\d,]+) min\b/g, 'N min');
const report = { journals: journals.length, compared: 0, noTurn: 0, identical: 0, diffs: [], verdicts: {} };
let next = 0;
async function worker() {
  while (next < journals.length) {
    const { f, id } = journals[next++];
    const turn = newestTurn(fs.readFileSync(path.join(jdir, f), 'utf8'));
    if (!turn) { report.noTurn++; continue; }
    const ask = (/<!--[ \t]*oa-ask[ \t]*:[ \t]*([a-z]+)[ \t]*-->/i.exec(turn) || [])[1] || 'none';
    const body = path.join(root, `body-${id}.md`);
    fs.writeFileSync(body, turn);
    const [p, n] = await Promise.all([run('ps', id, body, ask), run('node', id, body, ask)]);
    report.compared++;
    const key = p.code === 0 ? 'clean' : p.code === 2 ? (p.j && p.j.findings ? [...new Set(p.j.findings.map((x) => x.guard))].sort().join('+') : 'refused') : `exit ${p.code}`;
    report.verdicts[key] = (report.verdicts[key] || 0) + 1;
    if (p.code === n.code && minTol(p.j) === minTol(n.j)) report.identical++;
    else {
      report.diffs.push({ id, ask, ps: { code: p.code, j: p.j }, node: { code: n.code, j: n.j } });
      console.log(`DIFF task ${id}: ps exit ${p.code} node exit ${n.code}`);
    }
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
fs.rmSync(root, { recursive: true, force: true });
const summary = `[shadow] compared ${report.compared} (no agent turn: ${report.noTurn}); identical ${report.identical}; differences ${report.diffs.length}; ps verdicts ${JSON.stringify(report.verdicts)}`;
console.log(summary);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
process.exit(report.diffs.length ? 1 : 0);
