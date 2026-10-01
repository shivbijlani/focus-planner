#!/usr/bin/env node
// Differential fuzz for the oa-state scan/workable Node port against oa-state.ps1.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPsHost, asJson, diff } from './fn-diff.mjs';
import { makeNormalizer, tryParseJson } from '../characterization/lib/normalize.mjs';
import { getSha256 } from '../../skills/overnight-agent/oa-state-lib/collect/journal.mjs';
import {
  testUserClosed, testReopenedClosed, testUnansweredUser, testWorkable, getTodayGateVerdict,
  testExhaustionClaim, getSessionActivities,
} from '../../skills/overnight-agent/oa-state-lib/plan/workable.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const SKILL = path.join(REPO, 'plugins', 'overnight-agent', 'skills', 'overnight-agent');
const PS1 = path.join(SKILL, 'oa-state.ps1');
const NODE = path.join(SKILL, 'oa-state.mjs');
const WORK = path.join(HERE, '.scan-diff-work');

function parseArgs(argv) {
  const o = { n: 20, seed: 0x0a57a7e, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--n') o.n = Number(v());
    else if (a === '--seed') o.seed = Number(v());
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown arg ${a}`);
  }
  return o;
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const maybe = (r, p) => r() < p;
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const write = (p, s) => { mkdir(path.dirname(p)); fs.writeFileSync(p, s, 'utf8'); };

function boardRow(id, icon, title, wp, added, linked = '') {
  return `| ${id} | ${icon} | ${title} | ${wp ?? ''} | ${added} | ${linked} |`;
}

function journalText(r, id, title, { agent = true, trailing = false, above = false, blocking = false } = {}) {
  const nl = maybe(r, 0.5) ? '\r\n' : '\n';
  const head = [`# Task ${id}: ${title}`, '', above ? `## 2026-09-${String(10 + (id % 10)).padStart(2, '0')}\n<!-- from: me -->\nabove note ${id}\n` : '- user framing'];
  if (!agent) return head.join(nl) + nl;
  const ask = blocking
    ? ['<!-- oa-ask: blocking -->', '**Needs from you:** approve the next step'].join(nl)
    : ['<!-- oa-ask: none -->', '**Needs from you:** none'].join(nl);
  const turn = [
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '## 🌙 Overnight Agent',
    '<!-- from: overnight-agent -->',
    '**Status:** In progress',
    ask,
    '<!-- /overnight-agent turn-end -->',
  ];
  const tail = trailing ? ['', '## 2026-10-01', '<!-- from: me -->', `please continue ${id}`] : [];
  return [...head, '', ...turn, ...tail, ''].join(nl);
}

function todaySectionText(rows) {
  return `${[
    '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].map((x) => x.trim()).filter(Boolean).join('\n')}\n`;
}

function makePlanner(root, seed) {
  const r = rng(seed);
  const journal = path.join(root, 'journal');
  const state = path.join(root, 'state');
  mkdir(journal); mkdir(state);
  const count = 3 + Math.floor(r() * 5);
  const ids = Array.from({ length: count }, (_, i) => String(100 + i + Math.floor(r() * 20)));
  const uniq = [...new Set(ids)];
  const today = [];
  const deferred = [];
  const completedRows = [];
  const journalInfos = new Map();
  const icons = ['Red', 'Yellow', 'Book', 'White'];
  const wps = ['P0', 'P1', 'P2', ''];
  for (const [i, id] of uniq.entries()) {
    const row = boardRow(id, pick(r, icons), `Generated task ${id}`, pick(r, wps), '2026-09-01', i > 0 && maybe(r, 0.25) ? uniq[i - 1] : '');
    if (maybe(r, 0.55)) today.push(row); else deferred.push(row);
    if (maybe(r, 0.15)) completedRows.push(row);
    if (!maybe(r, 0.12)) {
      const info = {
        agent: maybe(r, 0.8),
        trailing: maybe(r, 0.25),
        above: maybe(r, 0.2),
        blocking: maybe(r, 0.25),
      };
      journalInfos.set(id, info);
      write(path.join(journal, `task-${id}.md`), journalText(r, Number(id), `Generated task ${id}`, info));
    }
  }
  if (today.length === 0 && deferred.length) today.push(deferred.shift());
  const priorities = uniq.slice().sort(() => r() - 0.5).slice(0, 3).map((id, i) => `${i + 1}. ${id}`);
  const planner = [
    '# Planner',
    '',
    '## Today',
    '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
    '|---|---|---|---|---|---|',
    ...today,
    '',
    '## Deferred',
    '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
    '|---|---|---|---|---|---|',
    ...deferred,
    '',
    '## Priorities',
    ...priorities,
    '',
  ].join('\n');
  write(path.join(root, 'planner.md'), planner);
  write(path.join(root, 'planner-completed.md'), ['# Completed', '', ...completedRows, ''].join('\n'));
  const snooze = {};
  for (const id of uniq) if (maybe(r, 0.12)) snooze[id] = '2099-01-01';
  write(path.join(root, 'snooze.json'), JSON.stringify({ tasks: snooze }, null, 2));
  write(path.join(root, 'user-settings.md'), [
    '| Setting | Value |',
    '|---|---|',
    `| Today gate backstop | ${maybe(r, 0.2) ? 'off' : String(1 + Math.floor(r() * 12))} |`,
    `| Today gate strict | ${maybe(r, 0.15) ? 'on' : 'off'} |`,
    `| Overnight Agent model | auto |`,
    '',
  ].join('\n'));

  const todayHash = getSha256(todaySectionText(today));
  for (const id of uniq) {
    if (!journalInfos.has(id) || maybe(r, 0.18)) continue;
    const content = fs.readFileSync(path.join(journal, `task-${id}.md`), 'utf8');
    const processed = maybe(r, 0.7) ? getSha256(content) : 'old-' + id;
    const status = pick(r, ['in-progress', 'done', 'skip', 'proposed', 'blocked']);
    const st = {
      id,
      status,
      status_by: maybe(r, 0.2) ? 'user' : 'agent',
      processed_file_hash: processed,
      version: Math.floor(r() * 3),
      plan_id: `t${id}-v1`,
      last_turn_at: maybe(r, 0.7) ? '2026-09-01T00:00:00-07:00' : '',
    };
    if (maybe(r, 0.25)) st.poll = { cadence: 'daily', interval_minutes: 1440, last_polled: '', next_due: maybe(r, 0.5) ? '2000-01-01T00:00:00' : '2099-01-01T00:00:00' };
    if (maybe(r, 0.2)) st.recheck = { cadence: '12h', interval_minutes: 720, kind: 'ci', last_rechecked: '', next_due: maybe(r, 0.5) ? '2000-01-01T00:00:00' : '2099-01-01T00:00:00' };
    if (maybe(r, 0.2)) st.doc = { doc_id: `doc_${id}`, doc_url: `https://docs.example/${id}`, bound_at: '2026-09-01T00:00:00-07:00', seen_ids: [], pending_ids: maybe(r, 0.5) ? [`c${id}`] : [], observed_at: maybe(r, 0.5) ? new Date().toISOString() : '' };
    if (maybe(r, 0.2)) st.session = { session_id: `sess-${id}`, state: 'live', workspace: '', workspace_type: 'folder' };
    if (today.some((line) => line.includes(`| ${id} |`)) && maybe(r, 0.25)) {
      st.today_exhausted = { at: new Date().toISOString(), examined: [`gh:${id}`], today_hash: todayHash, note: 'fuzz' };
    }
    write(path.join(state, `task-${id}.json`), JSON.stringify(st, null, 2));
  }
}

function copyDir(src, dst) {
  mkdir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function runScan(impl, root, extra = []) {
  const common = [
    'scan',
    impl === 'ps' ? '-JournalDir' : '--JournalDir', path.join(root, 'journal'),
    impl === 'ps' ? '-StateDir' : '--StateDir', path.join(root, 'state'),
    impl === 'ps' ? '-PlannerBoard' : '--PlannerBoard', path.join(root, 'planner.md'),
    impl === 'ps' ? '-PlannerCompleted' : '--PlannerCompleted', path.join(root, 'planner-completed.md'),
    impl === 'ps' ? '-SnoozeStore' : '--SnoozeStore', path.join(root, 'snooze.json'),
    impl === 'ps' ? '-UserSettings' : '--UserSettings', path.join(root, 'user-settings.md'),
    ...extra,
  ];
  const cmd = impl === 'ps'
    ? ['pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...common]]
    : [process.execPath, [NODE, ...common]];
  const r = spawnSync(cmd[0], cmd[1], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  return { exit: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function normalizedResult(run, root, t0) {
  const norm = makeNormalizer({ t0, pathTokens: [['<ROOT>', root], ['<REPO>', REPO], ['<SKILL>', SKILL]] });
  const parsed = tryParseJson(run.stdout);
  return {
    exit: run.exit,
    stdout: parsed === undefined ? norm.text(run.stdout) : norm.value(parsed),
    stderr: norm.text(run.stderr),
  };
}

function tree(root, t0) {
  const norm = makeNormalizer({ t0, pathTokens: [['<ROOT>', root], ['<REPO>', REPO], ['<SKILL>', SKILL]] });
  const out = {};
  function walk(dir, rel = '') {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else {
        const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
        const parsed = tryParseJson(text);
        out[r] = parsed === undefined ? norm.text(text) : norm.value(parsed);
      }
    }
  }
  walk(root);
  return out;
}

function assertEqual(a, b, label) {
  const d = diff(a, b);
  if (d) throw new Error(`${label}: ${d}`);
  const ja = JSON.stringify(a, null, 2);
  const jb = JSON.stringify(b, null, 2);
  if (ja !== jb) throw new Error(`${label}\nPS ${ja.slice(0, 1200)}\nNODE ${jb.slice(0, 1200)}`);
}

async function functionDiffs(workRoot, n, seed) {
  const ps = await createPsHost({ params: { StateDir: path.join(workRoot, 'fn-state'), JournalDir: path.join(workRoot, 'fn-journal') }, cwd: REPO });
  let psClosed = false;
  try {
    const r = rng(seed ^ 0x5151);
    for (let i = 0; i < n; i++) {
      const row = {
        status: pick(r, ['done', 'skip', 'blocked', 'proposed', 'in-progress', 'none']),
        status_by: maybe(r, 0.3) ? 'user' : 'agent',
        user_completed: maybe(r, 0.2),
        on_board: maybe(r, 0.8),
        reopened: maybe(r, 0.25),
        unanswered_user: maybe(r, 0.25),
        snoozed: maybe(r, 0.1),
        awaiting_reply: maybe(r, 0.2),
        due_poll: maybe(r, 0.2),
        due_recheck: maybe(r, 0.2),
        last_turn_at: maybe(r, 0.5) ? '2020-01-01T00:00:00' : '',
        exhaustion: maybe(r, 0.2) ? { at: new Date().toISOString(), examined: ['x'], today_hash: 'h' } : null,
      };
      const ctx = { p: { ExhaustionTtlMinutes: 30 }, BackstopHours: 6, GateStrict: false };
      for (const [psName, jsFn, args] of [
        ['Test-UserClosed', testUserClosed, [row]],
        ['Test-ReopenedClosed', testReopenedClosed, [row]],
        ['Test-UnansweredUser', testUnansweredUser, [row]],
        ['Test-Workable', testWorkable, [row]],
      ]) {
        const d = diff(await ps.call(psName, args), asJson(jsFn(...args)));
        if (d) throw new Error(`${psName} #${i}: ${d}`);
      }
      let d = diff(await ps.call('Get-TodayGateVerdict', [row, 'h']), asJson(getTodayGateVerdict(ctx, row, 'h')));
      if (d) throw new Error(`Get-TodayGateVerdict #${i}: ${d}`);
      d = diff(await ps.call('Test-ExhaustionClaim', [row.exhaustion, row, 'h']), asJson(testExhaustionClaim(ctx, row.exhaustion, row, 'h')));
      if (d) throw new Error(`Test-ExhaustionClaim #${i}: ${d}`);
    }
    const snap = path.join(workRoot, 'sessions.json');
    write(snap, JSON.stringify({ sessions: [{ id: 'a', activity: { status: 'idle' } }, { id: 'b', activity: { status: 'busy' } }] }));
    await ps.close();
    psClosed = true;
    const ps2 = await createPsHost({ params: { SessionsStatusFile: snap }, cwd: REPO });
    try {
      const d = diff(await ps2.call('Get-SessionActivities', []), asJson(getSessionActivities({ p: { SessionsStatusFile: snap } })));
      if (d) throw new Error(`Get-SessionActivities: ${d}`);
    } finally { await ps2.close(); }
  } finally {
    if (!psClosed) { try { await ps.close(); } catch {} }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.rmSync(WORK, { recursive: true, force: true });
  mkdir(WORK);
  await functionDiffs(WORK, Math.max(10, opts.n), opts.seed);
  for (let i = 0; i < opts.n; i++) {
    const base = path.join(WORK, `case-${String(i).padStart(3, '0')}`, 'base');
    const psRoot = path.join(WORK, `case-${String(i).padStart(3, '0')}`, 'ps');
    const nodeRoot = path.join(WORK, `case-${String(i).padStart(3, '0')}`, 'node');
    makePlanner(base, opts.seed + i * 7919);
    copyDir(base, psRoot);
    copyDir(base, nodeRoot);
    const variants = [
      { name: 'full', args: [] },
      { name: 'compact', args: ['--Compact'] },
      { name: 'outfile', args: ['--ScanOutFile', path.join('{root}', 'scan-full.json')] },
    ];
    for (const v of variants) {
      const psArgs = v.args.map((x) => x === '--Compact' ? '-Compact' : x === '--ScanOutFile' ? '-ScanOutFile' : x.replace('{root}', psRoot));
      const nodeArgs = v.args.map((x) => x.replace('{root}', nodeRoot));
      const t0 = Date.now();
      const pr = runScan('ps', psRoot, psArgs);
      const nr = runScan('node', nodeRoot, nodeArgs);
      assertEqual(normalizedResult(pr, psRoot, t0), normalizedResult(nr, nodeRoot, t0), `case ${i} ${v.name} result`);
      assertEqual(tree(psRoot, t0), tree(nodeRoot, t0), `case ${i} ${v.name} tree`);
    }
  }
  if (!opts.keep) fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`scan-diff: ${opts.n} whole-folder cases + ${Math.max(10, opts.n)} function inputs, 0 differences`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exitCode = 1; });
